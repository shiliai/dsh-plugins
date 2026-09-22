import { createServer, type IncomingMessage as IncomingMessageLike, type Server, type ServerResponse as ServerResponseLike } from 'node:http'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_EXPORT_KIND, CONFIG_FORMAT_VERSION, buildEnvelope } from '@dsh-plugins/dsh-config-portability'
import { registerReadingApi } from '../src/http-api.ts'
import { LocalLibrary } from '../src/library.ts'
import { ReadingStateStore } from '../src/state-store.ts'
import { readReadingConfigFile, ReadingSourcesHolder, resolveReadingSources, type ReadingSourceOverride } from '../src/config-portability.ts'

let dir: string
let server: Server
let base: string
let holder: ReadingSourcesHolder
const projectUpdates: Array<{ rootDir: string; createSessionOnOpen: boolean }> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-reading-portability-'))
  server = createServer()
  holder = new ReadingSourcesHolder({}, { file: join(dir, 'reading-config.json') })
  const fakeWebServer = {
    register(route: { handler: (req: IncomingMessageLike, res: ServerResponseLike) => Promise<void> }) {
      const listener = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
        void route.handler(req as IncomingMessageLike, res as ServerResponseLike)
      }
      server.on('request', listener)
      return () => server.off('request', listener)
    },
  }
  registerReadingApi(fakeWebServer as never, new LocalLibrary(dir), await ReadingStateStore.create(dir), holder, {
    get: () => ({ rootDir: dir, createSessionOnOpen: false }),
    update: async value => { projectUpdates.push(value) },
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-reading/api`
})

afterEach(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
  projectUpdates.length = 0
})

const envelopeWith = (config: unknown): unknown => buildEnvelope({ 'dsh-reading': { displayName: 'Reading', config } })

const wallabagSection = (origin = 'http://wallabag-new.test'): unknown => ({
  origin, clientId: 'cid', clientSecret: 'csecret', username: 'user', password: 'pass',
})

describe('reading config export', () => {
  it('exports plaintext credentials by default and redacts with ?redact=1', async () => {
    await holder.update({ wallabag: { origin: 'http://wallabag.test', clientId: 'cid', clientSecret: 'cs', username: 'user', password: 'pw' } })

    const plain = await (await fetch(`${base}/config/export`)).json() as {
      kind: string
      formatVersion: number
      plugins: Record<string, { displayName: string; config: Record<string, unknown> }>
    }
    expect(plain.kind).toBe(CONFIG_EXPORT_KIND)
    expect(plain.formatVersion).toBe(CONFIG_FORMAT_VERSION)
    const section = plain.plugins['dsh-reading']
    expect(section?.displayName).toBe('Reading')
    expect(section?.config.wallabag).toMatchObject({ origin: 'http://wallabag.test', clientSecret: 'cs', password: 'pw' })
    expect(section?.config.library).toMatchObject({ dataDir: dir })
    expect(section?.config.settings).toMatchObject({ rootDir: dir, createSessionOnOpen: false })

    const redacted = await (await fetch(`${base}/config/export?redact=1`)).json() as { plugins: Record<string, { config: Record<string, unknown> }> }
    expect(redacted.plugins['dsh-reading']?.config.wallabag).toMatchObject({ clientSecret: '', password: '' })
    expect(redacted.plugins['dsh-reading']?.config.wallabag).toMatchObject({ origin: 'http://wallabag.test' })
  })

  it('reports unconfigured sources as null sections', async () => {
    const payload = await (await fetch(`${base}/config/export`)).json() as { plugins: Record<string, { config: Record<string, unknown> }> }
    expect(payload.plugins['dsh-reading']?.config.opds).toBeNull()
    expect(payload.plugins['dsh-reading']?.config.calibre).toBeNull()
  })
})

describe('reading config import', () => {
  it('applies sections live, persists the override file, and rebuilds adapters', async () => {
    const response = await fetch(`${base}/config/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelopeWith({
        wallabag: wallabagSection(),
        opds: { name: 'nas', url: 'http://opds-new.test', username: 'o', password: 'p' },
        settings: { rootDir: `${dir}/ws`, createSessionOnOpen: true },
        library: { dataDir: '/some/other/machine' },
      })),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { ok: boolean; dryRun: boolean; report: { applied: string[]; skipped: string[]; warnings: string[] } }
    expect(payload.ok).toBe(true)
    expect(payload.dryRun).toBe(false)
    expect(payload.report.applied.sort()).toEqual(['opds', 'settings', 'wallabag'])
    expect(payload.report.skipped).toEqual([])
    expect(payload.report.warnings.some(warning => warning.includes('READING_DATA_DIR'))).toBe(true)

    // Adapters rebuilt in place — visible on /settings without a restart.
    const settings = await (await fetch(`${base}/settings`)).json() as { sources: { wallabag: { origin: string } | null; opds: { url: string } | null } }
    expect(settings.sources.wallabag?.origin).toBe('http://wallabag-new.test')
    expect(settings.sources.opds?.url).toBe('http://opds-new.test/')

    // Override file persisted atomically with mode 600.
    const file = join(dir, 'reading-config.json')
    const persisted = await readReadingConfigFile(file)
    expect(persisted.wallabag).toMatchObject({ origin: 'http://wallabag-new.test', username: 'user' })
    expect(persisted.opds).toMatchObject({ name: 'nas' })
    const info = await stat(file)
    expect(info.mode & 0o777).toBe(0o600)

    // Settings section routed through the project access.
    expect(projectUpdates).toEqual([{ rootDir: `${dir}/ws`, createSessionOnOpen: true }])
  })

  it('dryRun reports without persisting or mutating anything', async () => {
    const response = await fetch(`${base}/config/import?dryRun=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelopeWith({ wallabag: wallabagSection() })),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { dryRun: boolean; report: { applied: string[] } }
    expect(payload.dryRun).toBe(true)
    expect(payload.report.applied).toEqual(['wallabag'])
    await expect(stat(join(dir, 'reading-config.json'))).rejects.toThrowError()
    const settings = await (await fetch(`${base}/settings`)).json() as { sources: { wallabag: unknown } }
    expect(settings.sources.wallabag).toBeNull()
  })

  it('rejects an invalid URL as a whole and leaves no residue', async () => {
    const response = await fetch(`${base}/config/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelopeWith({
        wallabag: wallabagSection('ftp://not-http.test'),
        opds: { name: 'nas', url: 'http://opds-new.test' },
      })),
    })
    expect(response.status).toBe(400)
    const payload = await response.json() as { code: string }
    expect(payload.code).toBe('INVALID_CONFIG')
    await expect(stat(join(dir, 'reading-config.json'))).rejects.toThrowError()
    const settings = await (await fetch(`${base}/settings`)).json() as { sources: { opds: unknown } }
    expect(settings.sources.opds).toBeNull()
  })

  it('skips sections with missing credentials and applies the rest', async () => {
    const response = await fetch(`${base}/config/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelopeWith({
        // Redacted export shape: credentials blanked.
        wallabag: { origin: 'http://wallabag.test', clientId: 'cid', clientSecret: '', username: 'user', password: '' },
        opds: { name: 'nas', url: 'http://opds-new.test' },
      })),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { report: { applied: string[]; skipped: string[]; warnings: string[] } }
    expect(payload.report.applied).toEqual(['opds'])
    expect(payload.report.skipped).toEqual(['wallabag'])
    expect(payload.report.warnings).toHaveLength(1)

    const settings = await (await fetch(`${base}/settings`)).json() as { sources: { wallabag: unknown; opds: { url: string } | null } }
    expect(settings.sources.wallabag).toBeNull()
    expect(settings.sources.opds?.url).toBe('http://opds-new.test/')
  })

  it('rejects cross-origin imports', async () => {
    const response = await fetch(`${base}/config/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify(envelopeWith({})),
    })
    expect(response.status).toBe(403)
  })

  it('rejects envelopes without a reading section', async () => {
    const response = await fetch(`${base}/config/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildEnvelope({ other: { displayName: 'Other', config: {} } })),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as { code: string }).code).toBe('SECTION_NOT_FOUND')
  })
})

describe('source resolution priority', () => {
  it('prefers explicit cordis config over override and env', () => {
    vi.stubEnv('READING_WALLABAG_URL', 'http://from-env.test')
    try {
      const sources = resolveReadingSources(
        { wallabag: { origin: 'http://cordis.test', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' } },
        { wallabag: { origin: 'http://override.test', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' } },
      )
      expect(sources.wallabag?.settings.origin).toBe('http://cordis.test')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('cordis null force-disables even with an override section', () => {
    const sources = resolveReadingSources(
      { wallabag: null, opds: null },
      { wallabag: { origin: 'http://override.test', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' } },
    )
    expect(sources.wallabag).toBeUndefined()
    expect(sources.opds).toBeUndefined()
  })

  it('uses the override section before env, and env when absent', () => {
    vi.stubEnv('READING_WALLABAG_URL', 'http://from-env.test')
    vi.stubEnv('READING_WALLABAG_CLIENT_ID', 'cid')
    vi.stubEnv('READING_WALLABAG_CLIENT_SECRET', 'cs')
    vi.stubEnv('READING_WALLABAG_USERNAME', 'u')
    vi.stubEnv('READING_WALLABAG_PASSWORD', 'p')
    try {
      const withOverride = resolveReadingSources({}, { wallabag: { origin: 'http://override.test', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' } })
      expect(withOverride.wallabag?.settings.origin).toBe('http://override.test')
      const fromEnv = resolveReadingSources({}, {})
      expect(fromEnv.wallabag?.settings.origin).toBe('http://from-env.test')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('explicitly disabled override sections (null) suppress the env fallback', () => {
    vi.stubEnv('READING_WALLABAG_URL', 'http://from-env.test')
    try {
      const sources = resolveReadingSources({}, { wallabag: null })
      expect(sources.wallabag).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('degrades invalid override sections to env instead of failing startup', () => {
    vi.stubEnv('READING_WALLABAG_URL', 'http://from-env.test')
    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const sources = resolveReadingSources({}, { wallabag: { origin: 'not a url', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' } })
      expect(sources.wallabag?.settings.origin).toBe('http://from-env.test')
      expect(errorSpy).toHaveBeenCalled()
      errorSpy.mockRestore()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('reading-config.json file handling', () => {
  it('ignores corrupt files and falls back to env', async () => {
    const file = join(dir, 'reading-config.json')
    await writeFile(file, '{ not json', 'utf8')
    await expect(readReadingConfigFile(file)).resolves.toEqual({})
    vi.stubEnv('READING_WALLABAG_URL', 'http://from-env.test')
    try {
      const override: ReadingSourceOverride = await readReadingConfigFile(file)
      const sources = resolveReadingSources({}, override)
      expect(sources.wallabag?.settings.origin).toBe('http://from-env.test')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('drops malformed fields but keeps well-typed ones', async () => {
    const file = join(dir, 'reading-config.json')
    await writeFile(file, JSON.stringify({
      wallabag: { origin: 'http://ok.test', clientId: 42, timeoutMs: -5 },
      opds: 'garbage',
      calibre: { url: 'http://calibre.test', uploadTimeoutMs: 120000 },
    }), 'utf8')
    const override = await readReadingConfigFile(file)
    expect(override.wallabag).toEqual({ origin: 'http://ok.test' })
    expect(override.opds).toBeUndefined()
    expect(override.calibre).toEqual({ url: 'http://calibre.test', uploadTimeoutMs: 120000 })
  })

  it('holder.update validates before mutating and persists after success', async () => {
    const file = join(dir, 'reading-config.json')
    const local = new ReadingSourcesHolder({}, { file })
    await expect(local.update({ opds: { name: 'nas', url: 'bad url' } })).rejects.toThrowError()
    await expect(stat(file)).rejects.toThrowError()
    await local.update({ opds: { name: 'nas', url: 'http://opds.test' } })
    expect(local.get().opds?.settings.url).toBe('http://opds.test/')
    const info = await stat(file)
    expect(info.mode & 0o777).toBe(0o600)
    await chmod(file, 0o640)
    await local.update({ calibre: { url: 'http://calibre.test' } })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
})
