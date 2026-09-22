/**
 * dsh-reading config export/import (issue #105).
 *
 * - `reading-config.json` override file: `<dataDir>/reading-config.json`,
 *   holding the wallabag / opds / calibre sections imported via the shared
 *   config-portability contract. Atomic write (temp + rename, mode 600);
 *   a corrupt file is ignored and the env fallback stays active.
 * - Startup priority: explicit cordis config > reading-config.json > env
 *   (cordis `null` still force-disables a source).
 * - The {@link ReadingSourcesHolder} keeps the mutable adapter set: imports
 *   rebuild the adapters in place, so changes apply to the running host
 *   without a restart. `.env` / credentials / profile manifest are never touched.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ConfigPortabilityError, type ConfigPortabilityProvider, type ImportOutcome } from '@dsh-plugins/dsh-config-portability'
import { CalibreWebClient, type CalibreWebConfig } from './calibre-web.ts'
import { OpdsAdapter, type OpdsConfig } from './opds-adapter.ts'
import { WallabagAdapter, type WallabagConfig } from './wallabag-adapter.ts'

/** Name of the plugin-owned override file inside the reading data dir. */
export const READING_CONFIG_FILE = 'reading-config.json'

/** The live source adapters (absent = disabled). */
export interface ReadingSources {
  wallabag?: WallabagAdapter | undefined
  opds?: OpdsAdapter | undefined
  calibre?: CalibreWebClient | undefined
}

/** Sections of the override file; `null` records an explicit "disabled". */
export interface ReadingSourceOverride {
  wallabag?: WallabagConfig | null
  opds?: OpdsConfig | null
  calibre?: CalibreWebConfig | null
}

/** The cordis-facing config slice relevant to source resolution. */
export interface ReadingSourceConfig {
  wallabag?: WallabagConfig | null
  opds?: OpdsConfig | null
  calibre?: CalibreWebConfig | null
}

/** Settings section mirrored from reading-settings.json in exports. */
export interface ReadingSettingsSection {
  rootDir: string
  createSessionOnOpen: boolean
}

/** Read `<dataDir>/reading-config.json`; corrupt or malformed content degrades to "no override". */
export async function readReadingConfigFile(file: string): Promise<ReadingSourceOverride> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const override: ReadingSourceOverride = {}
  const record = raw as Record<string, unknown>
  const wallabag = sanitizeSection(record.wallabag, ['origin', 'clientId', 'clientSecret', 'username', 'password'], ['timeoutMs'])
  if (wallabag !== undefined) override.wallabag = wallabag as WallabagConfig | null
  const opds = sanitizeSection(record.opds, ['name', 'url', 'username', 'password'], ['timeoutMs'])
  if (opds !== undefined) override.opds = opds as OpdsConfig | null
  const calibre = sanitizeSection(record.calibre, ['url', 'username', 'password'], ['timeoutMs', 'uploadTimeoutMs'])
  if (calibre !== undefined) override.calibre = calibre as CalibreWebConfig | null
  return override
}

/** Keep only known, correctly typed fields; anything else invalidates the field, not the file. */
function sanitizeSection(value: unknown, stringFields: readonly string[], numberFields: readonly string[]): Record<string, unknown> | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const section: Record<string, unknown> = {}
  for (const field of stringFields) {
    const entry = record[field]
    if (typeof entry === 'string' && entry.trim() !== '') section[field] = entry
  }
  for (const field of numberFields) {
    const entry = record[field]
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) section[field] = entry
  }
  return section
}

/**
 * Startup resolution: cordis explicit config wins, cordis `null` force-disables,
 * otherwise the imported override section applies, otherwise env.
 */
export function resolveReadingSources(config: ReadingSourceConfig, override: ReadingSourceOverride): ReadingSources {
  return {
    wallabag: resolveWallabagSource(config.wallabag, override.wallabag),
    opds: resolveOpdsSource(config.opds, override.opds),
    calibre: resolveCalibreSource(config.calibre, override.calibre),
  }
}

function resolveWallabagSource(explicit: WallabagConfig | null | undefined, imported: WallabagConfig | null | undefined): WallabagAdapter | undefined {
  if (explicit === null) return undefined
  if (explicit !== undefined) return new WallabagAdapter(explicit)
  if (imported === null) return undefined
  if (imported !== undefined) {
    try {
      return new WallabagAdapter(imported)
    } catch (error) {
      console.error('dsh-reading: ignoring wallabag section of reading-config.json:', error instanceof Error ? error.message : String(error))
    }
  }
  return WallabagAdapter.fromEnv()
}

function resolveOpdsSource(explicit: OpdsConfig | null | undefined, imported: OpdsConfig | null | undefined): OpdsAdapter | undefined {
  if (explicit === null) return undefined
  if (explicit !== undefined) return new OpdsAdapter(explicit)
  if (imported === null) return undefined
  if (imported !== undefined) {
    try {
      return new OpdsAdapter(imported)
    } catch (error) {
      console.error('dsh-reading: ignoring opds section of reading-config.json:', error instanceof Error ? error.message : String(error))
    }
  }
  return OpdsAdapter.fromEnv()
}

function resolveCalibreSource(explicit: CalibreWebConfig | null | undefined, imported: CalibreWebConfig | null | undefined): CalibreWebClient | undefined {
  if (explicit === null) return undefined
  if (explicit !== undefined) return buildCalibre(explicit)
  if (imported === null) return undefined
  if (imported !== undefined) {
    const built = buildCalibre(imported)
    if (built !== undefined) return built
  }
  return buildCalibreFromEnv()
}

function buildCalibre(config: CalibreWebConfig): CalibreWebClient | undefined {
  try {
    return new CalibreWebClient(config)
  } catch (error) {
    console.error('dsh-reading: calibre-web client disabled:', error instanceof Error ? error.message : String(error))
    return undefined
  }
}

function buildCalibreFromEnv(): CalibreWebClient | undefined {
  try {
    return CalibreWebClient.fromEnv()
  } catch (error) {
    console.error('dsh-reading: calibre-web client disabled:', error instanceof Error ? error.message : String(error))
    return undefined
  }
}

/**
 * Mutable holder for the source adapters. `update()` validates and rebuilds
 * the affected adapters first (throwing before any mutation) and then
 * persists the override sections atomically (temp + rename, mode 600).
 */
export class ReadingSourcesHolder {
  readonly #file: string | undefined
  #current: ReadingSources
  #override: ReadingSourceOverride

  constructor(initial: ReadingSources, options: { file?: string; override?: ReadingSourceOverride } = {}) {
    this.#current = { ...initial }
    this.#override = options.override === undefined ? {} : { ...options.override }
    this.#file = options.file
  }

  get(): ReadingSources {
    return { ...this.#current }
  }

  /** Sections this holder would persist (what the override file contains). */
  get overrideSections(): ReadingSourceOverride {
    return { ...this.#override }
  }

  async update(sections: ReadingSourceOverride): Promise<void> {
    const { current, override } = this.prepare(sections)
    this.#current = current
    this.#override = override
    if (this.#file !== undefined) await persistReadingConfigFile(this.#file, this.#override)
  }

  /** Validate + rebuild without mutating; throws before any state change. */
  prepare(sections: ReadingSourceOverride): { current: ReadingSources; override: ReadingSourceOverride } {
    const current = { ...this.#current }
    const override = { ...this.#override }
    if (sections.wallabag !== undefined) {
      override.wallabag = sections.wallabag
      current.wallabag = sections.wallabag === null ? undefined : new WallabagAdapter(sections.wallabag)
    }
    if (sections.opds !== undefined) {
      override.opds = sections.opds
      current.opds = sections.opds === null ? undefined : new OpdsAdapter(sections.opds)
    }
    if (sections.calibre !== undefined) {
      override.calibre = sections.calibre
      current.calibre = sections.calibre === null ? undefined : new CalibreWebClient(sections.calibre)
    }
    return { current, override }
  }
}

async function persistReadingConfigFile(file: string, override: ReadingSourceOverride): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(override, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}

export interface ReadingPortabilityDeps {
  sources: ReadingSourcesHolder
  dataDir: string
  project?: {
    get(): ReadingSettingsSection
    update(value: ReadingSettingsSection): Promise<void>
  } | undefined
}

/** Build the dsh-reading `ConfigPortabilityProvider` for the shared route handler. */
export function createReadingPortabilityProvider(deps: ReadingPortabilityDeps): ConfigPortabilityProvider {
  return {
    id: 'dsh-reading',
    displayName: 'Reading',
    exportConfig({ redactSecrets }) {
      const sources = deps.sources.get()
      const settings = deps.project?.get()
      return {
        // Reference only: imports never change the local data dir.
        library: { dataDir: deps.dataDir },
        wallabag: sources.wallabag === undefined ? null : exportConfig(sources.wallabag.rawConfig, redactSecrets, ['clientSecret', 'password']),
        opds: sources.opds === undefined ? null : exportConfig(sources.opds.rawConfig, redactSecrets, ['password']),
        calibre: sources.calibre === undefined ? null : exportConfig(sources.calibre.rawConfig, redactSecrets, ['password']),
        settings: settings === undefined ? null : { rootDir: settings.rootDir, createSessionOnOpen: settings.createSessionOnOpen },
      }
    },
    async importConfig(config, { dryRun }): Promise<ImportOutcome> {
      const record = asRecord(config)
      if (record === undefined) throw new ConfigPortabilityError('Reading config section must be an object.', 'INVALID_CONFIG', 400)
      const applied: string[] = []
      const skipped: string[] = []
      const warnings: string[] = []
      const sections: ReadingSourceOverride = {}

      const library = asRecord(record.library)
      const exportedDataDir = library !== undefined && typeof library.dataDir === 'string' ? library.dataDir.trim() : ''
      if (exportedDataDir !== '' && exportedDataDir !== deps.dataDir) {
        warnings.push(`library.dataDir 仅作参考：导出机器为 ${exportedDataDir}，本机为 ${deps.dataDir}。如需变更请设置 READING_DATA_DIR 后重启。`)
      }

      if (record.wallabag !== undefined && record.wallabag !== null) {
        const parsed = parseWallabagSection(record.wallabag)
        if (parsed === undefined) {
          skipped.push('wallabag')
          warnings.push('wallabag 配置不完整（需要 origin/clientId/clientSecret/username/password），已跳过，未写入残缺配置。')
        } else {
          validateHttpUrl(parsed.origin, 'wallabag')
          sections.wallabag = parsed
        }
      }
      if (record.opds !== undefined && record.opds !== null) {
        const parsed = parseOpdsSection(record.opds)
        if (parsed === undefined) {
          skipped.push('opds')
          warnings.push('opds 配置不完整（需要 name/url），已跳过，未写入残缺配置。')
        } else {
          validateHttpUrl(parsed.url, 'opds')
          sections.opds = parsed
        }
      }
      if (record.calibre !== undefined && record.calibre !== null) {
        const parsed = parseCalibreSection(record.calibre)
        if (parsed === undefined) {
          skipped.push('calibre')
          warnings.push('calibre 配置不完整（需要 url），已跳过，未写入残缺配置。')
        } else {
          validateHttpUrl(parsed.url, 'calibre')
          sections.calibre = parsed
        }
      }
      let nextSettings: ReadingSettingsSection | undefined
      if (record.settings !== undefined && record.settings !== null) {
        const parsed = parseSettingsSection(record.settings)
        if (parsed === undefined) {
          skipped.push('settings')
          warnings.push('settings 配置不完整（需要非空 rootDir），已跳过。')
        } else if (deps.project === undefined) {
          skipped.push('settings')
          warnings.push('当前运行方式未接入项目设置，settings 已跳过。')
        } else {
          nextSettings = parsed
        }
      }

      if (!dryRun) {
        if (Object.keys(sections).length > 0) await deps.sources.update(sections)
        if (nextSettings !== undefined && deps.project !== undefined) await deps.project.update(nextSettings)
      }
      applied.push(...Object.keys(sections))
      if (nextSettings !== undefined) applied.push('settings')
      return { applied, skipped, warnings }
    },
  }
}

function exportConfig(config: object, redactSecrets: boolean, secretFields: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...config }
  if (redactSecrets) {
    for (const field of secretFields) {
      if (typeof copy[field] === 'string') copy[field] = ''
    }
  }
  return copy
}

function parseWallabagSection(value: unknown): WallabagConfig | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const origin = nonEmptyString(record.origin)
  const clientId = nonEmptyString(record.clientId)
  const clientSecret = nonEmptyString(record.clientSecret)
  const username = nonEmptyString(record.username)
  const password = nonEmptyString(record.password)
  if (origin === undefined || clientId === undefined || clientSecret === undefined || username === undefined || password === undefined) return undefined
  const timeoutMs = optionalTimeout(record)
  return { origin, clientId, clientSecret, username, password, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

function parseOpdsSection(value: unknown): OpdsConfig | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const name = nonEmptyString(record.name)
  const url = nonEmptyString(record.url)
  if (name === undefined || url === undefined) return undefined
  const username = nonEmptyString(record.username)
  const password = nonEmptyString(record.password)
  const timeoutMs = optionalTimeout(record)
  return {
    name,
    url,
    // Credentials only count as a pair; a lone username is not partial auth.
    ...(username === undefined || password === undefined ? {} : { username, password }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function parseCalibreSection(value: unknown): CalibreWebConfig | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const url = nonEmptyString(record.url)
  if (url === undefined) return undefined
  const username = nonEmptyString(record.username)
  const password = nonEmptyString(record.password)
  const timeoutMs = optionalTimeout(record)
  const uploadTimeoutMs = optionalTimeout(record, 'uploadTimeoutMs')
  return {
    url,
    ...(username === undefined || password === undefined ? {} : { username, password }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(uploadTimeoutMs === undefined ? {} : { uploadTimeoutMs }),
  }
}

function parseSettingsSection(value: unknown): ReadingSettingsSection | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const rootDir = nonEmptyString(record.rootDir)
  if (rootDir === undefined) return undefined
  return { rootDir, createSessionOnOpen: record.createSessionOnOpen === true }
}

function validateHttpUrl(value: string, label: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ConfigPortabilityError(`${label} URL is invalid.`, 'INVALID_CONFIG', 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigPortabilityError(`${label} URL must be http(s).`, 'INVALID_CONFIG', 400)
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function optionalTimeout(record: Record<string, unknown>, field: string = 'timeoutMs'): number | undefined {
  const value = record[field]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Convenience: default override file path inside the reading data dir. */
export function readingConfigFile(dataDir: string): string {
  return join(dataDir, READING_CONFIG_FILE)
}
