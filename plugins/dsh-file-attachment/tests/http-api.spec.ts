import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { TemporaryFileStore } from '../src/file-store.ts'
import { registerAttachmentApi } from '../src/http-api.ts'

const roots: string[] = []
const servers: Server[] = []

interface PrefixRoute {
  kind: 'prefix'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-api-'))
  roots.push(root)
  const store = await TemporaryFileStore.create({ root, maxFileBytes: 16, maxFilesPerMessage: 2, maxMessageBytes: 16, ttlMs: 60_000 })
  let route: PrefixRoute | undefined
  const unregister = vi.fn()
  const register = vi.fn((value: PrefixRoute) => { route = value; return unregister })
  const dispose = registerAttachmentApi({ register } as unknown as WebServer, store, ['https://allowed.example'])
  expect(dispose).toBe(unregister)
  if (route === undefined) throw new Error('Route was not registered.')
  const handler = route.handler
  const server = createServer((request, response) => void handler(request, response))
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address.')
  return { baseUrl: `http://127.0.0.1:${address.port}`, register }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('attachment HTTP API', () => {
  it('reports limits and accepts same-host uploads and deletion', async () => {
    const { baseUrl, register } = await fixture()
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prefix', path: '/dsh-file-attachment/api' }))
    const limits = await fetch(`${baseUrl}/dsh-file-attachment/api/limits`)
    expect(await limits.json()).toEqual({ maxFileBytes: 16, maxFilesPerMessage: 2, maxMessageBytes: 16 })

    const uploaded = await fetch(`${baseUrl}/dsh-file-attachment/api/upload`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ name: 'a.txt', mediaType: 'text/plain', data: 'YQ==' }], existingFileIds: [] }),
    })
    expect(uploaded.status).toBe(201)
    const body = await uploaded.json() as { files: Array<{ fileId: string }> }
    const removed = await fetch(`${baseUrl}/dsh-file-attachment/api/file`, {
      method: 'DELETE',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ fileId: body.files[0]!.fileId }),
    })
    expect(removed.status).toBe(204)
  })

  it('accepts configured proxy origins and rejects missing or foreign origins', async () => {
    const { baseUrl } = await fixture()
    const body = JSON.stringify({ files: [{ name: 'a', mediaType: '', data: 'YQ==' }], existingFileIds: [] })
    const allowed = await fetch(`${baseUrl}/dsh-file-attachment/api/upload`, {
      method: 'POST', headers: { origin: 'https://allowed.example', 'content-type': 'application/json' }, body,
    })
    expect(allowed.status).toBe(201)
    for (const origin of [undefined, 'https://attacker.example', 'null', 'not-a-url']) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (origin !== undefined) headers.origin = origin
      const denied = await fetch(`${baseUrl}/dsh-file-attachment/api/upload`, { method: 'POST', headers, body })
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ code: 'ORIGIN_DENIED' })
    }
    const spoofedProxyHost = await fetch(`${baseUrl}/dsh-file-attachment/api/upload`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example', 'content-type': 'application/json' },
      body,
    })
    expect(spoofedProxyHost.status).toBe(403)
    expect(await spoofedProxyHost.json()).toMatchObject({ code: 'ORIGIN_DENIED' })
  })

  it('rejects invalid bodies and enforces cumulative host limits', async () => {
    const { baseUrl } = await fixture()
    const headers = { origin: baseUrl, 'content-type': 'application/json' }
    const invalid = await fetch(`${baseUrl}/dsh-file-attachment/api/upload`, { method: 'POST', headers, body: '{}' })
    expect(invalid.status).toBe(400)

    const first = await fetch(`${baseUrl}/dsh-file-attachment/api/upload`, {
      method: 'POST', headers,
      body: JSON.stringify({ files: [{ name: 'first', mediaType: '', data: Buffer.alloc(12).toString('base64') }], existingFileIds: [] }),
    })
    const firstBody = await first.json() as { files: Array<{ fileId: string }> }
    const over = await fetch(`${baseUrl}/dsh-file-attachment/api/upload`, {
      method: 'POST', headers,
      body: JSON.stringify({ files: [{ name: 'second', mediaType: '', data: Buffer.alloc(5).toString('base64') }], existingFileIds: [firstBody.files[0]!.fileId] }),
    })
    expect(over.status).toBe(413)
    expect(await over.json()).toMatchObject({ code: 'MESSAGE_TOO_LARGE' })
  })
})
