import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { registerVaultApi } from '../src/http-api.ts'
import { VaultService } from '../src/vault-service.ts'

const roots: string[] = []
const servers: Server[] = []

interface PrefixRoute {
  kind: 'prefix'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

interface ApiFixture {
  baseUrl: string
  root: string
  register: ReturnType<typeof vi.fn>
  unregister: ReturnType<typeof vi.fn>
}

async function fixture(): Promise<ApiFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-obsidian-api-'))
  roots.push(root)
  await mkdir(join(root, 'Projects'), { recursive: true })
  await writeFile(join(root, 'Home.md'), '# Home\nWelcome to the vault.\n')
  await writeFile(join(root, 'Projects', 'Roadmap.md'), '# Roadmap\nShip the preview.\n')

  let route: PrefixRoute | undefined
  const unregister = vi.fn()
  const register = vi.fn((registration: PrefixRoute) => {
    route = registration
    return unregister
  })
  const vault = await VaultService.create(root, 4096, 20)
  const dispose = registerVaultApi({ register } as unknown as WebServer, vault, 'http://dsh.test')
  expect(dispose).toBe(unregister)

  if (route === undefined) throw new Error('Vault API route was not registered.')
  const handler = route.handler
  const server = createServer((request, response) => {
    void handler(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address.')
  return { baseUrl: `http://127.0.0.1:${address.port}`, root: vault.root, register, unregister }
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('registerVaultApi', () => {
  it('registers its prefix route and serves vault read endpoints', async () => {
    const { baseUrl, root, register } = await fixture()
    expect(register).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prefix', path: '/dsh-obsidian/api' }))

    const info = await request(baseUrl, '/dsh-obsidian/api/info')
    expect(info.status).toBe(200)
    expect(await info.json()).toEqual({ name: basename(root), root })

    const note = await request(baseUrl, '/dsh-obsidian/api/note?path=Projects%2FRoadmap.md')
    expect(note.status).toBe(200)
    expect(await note.json()).toMatchObject({ path: 'Projects/Roadmap.md', content: '# Roadmap\nShip the preview.\n' })

    const search = await request(baseUrl, '/dsh-obsidian/api/search?q=preview')
    expect(search.status).toBe(200)
    expect(await search.json()).toEqual({ results: [{ path: 'Projects/Roadmap.md', line: 2, excerpt: 'Ship the preview.' }] })
  })

  it('enforces same-origin, JSON body, and vault-relative path rules for mutations', async () => {
    const { baseUrl } = await fixture()
    const origin = { origin: 'http://dsh.test', 'content-type': 'application/json' }

    const written = await request(baseUrl, '/dsh-obsidian/api/note', {
      method: 'PUT', headers: origin, body: JSON.stringify({ path: 'Daily/Today.md', content: '# Today' }),
    })
    expect(written.status).toBe(200)
    expect(await written.json()).toMatchObject({ path: 'Daily/Today.md', content: '# Today' })

    const moved = await request(baseUrl, '/dsh-obsidian/api/move', {
      method: 'POST', headers: origin, body: JSON.stringify({ from: 'Daily/Today.md', to: 'Archive/Today.md' }),
    })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ path: 'Archive/Today.md', content: '# Today' })

    const deleted = await request(baseUrl, '/dsh-obsidian/api/note?path=Archive%2FToday.md', {
      method: 'DELETE', headers: { origin: 'http://dsh.test' },
    })
    expect(deleted.status).toBe(204)

    const denied = await request(baseUrl, '/dsh-obsidian/api/note', {
      method: 'PUT', headers: { ...origin, origin: 'http://attacker.invalid' }, body: JSON.stringify({ path: 'No.md', content: 'no' }),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'ORIGIN_DENIED' })

    const malformedOrigin = await request(baseUrl, '/dsh-obsidian/api/note', {
      method: 'PUT', headers: { ...origin, origin: 'not a URL' }, body: JSON.stringify({ path: 'No.md', content: 'no' }),
    })
    expect(malformedOrigin.status).toBe(403)
    expect(await malformedOrigin.json()).toMatchObject({ code: 'ORIGIN_DENIED' })

    const nonHttpOrigin = await request(baseUrl, '/dsh-obsidian/api/note', {
      method: 'PUT', headers: { ...origin, origin: 'ftp://dsh.test' }, body: JSON.stringify({ path: 'No.md', content: 'no' }),
    })
    expect(nonHttpOrigin.status).toBe(403)
    expect(await nonHttpOrigin.json()).toMatchObject({ code: 'ORIGIN_DENIED' })

    const matchingUnconfigured = await request(baseUrl, '/dsh-obsidian/api/note', {
      method: 'PUT', headers: { origin: baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'No.md', content: 'no' }),
    })
    expect(matchingUnconfigured.status).toBe(403)
    expect(await matchingUnconfigured.json()).toMatchObject({ code: 'ORIGIN_DENIED' })

    const unsupportedContentType = await request(baseUrl, '/dsh-obsidian/api/note', {
      method: 'PUT', headers: { origin: 'http://dsh.test', 'content-type': 'application/jsonp' }, body: '{}',
    })
    expect(unsupportedContentType.status).toBe(415)
    expect(await unsupportedContentType.json()).toMatchObject({ code: 'INVALID_BODY' })

    const invalidJson = await request(baseUrl, '/dsh-obsidian/api/note', {
      method: 'PUT', headers: origin, body: '{',
    })
    expect(invalidJson.status).toBe(400)
    expect(await invalidJson.json()).toMatchObject({ code: 'INVALID_BODY' })

    for (const body of ['null', '[]', '1', '{"path":"Home.md"}', '{"path":"Home.md","content":"x","expectedModifiedMs":1e999}']) {
      const invalidShape = await request(baseUrl, '/dsh-obsidian/api/note', { method: 'PUT', headers: origin, body })
      expect(invalidShape.status).toBe(400)
      expect(await invalidShape.json()).toMatchObject({ code: 'INVALID_BODY' })
    }

    const escapedPath = await request(baseUrl, '/dsh-obsidian/api/note', {
      method: 'PUT', headers: origin, body: JSON.stringify({ path: '../outside.md', content: 'no' }),
    })
    expect(escapedPath.status).toBe(400)
    expect(await escapedPath.json()).toMatchObject({ code: 'INVALID_PATH' })
  })
})
