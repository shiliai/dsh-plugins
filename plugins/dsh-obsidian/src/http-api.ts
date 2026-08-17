import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { ApiErrorPayload } from './contracts.ts'
import { VaultError } from './vault-service.ts'
import { VaultManager } from './vault-manager.ts'

const API_PREFIX = '/dsh-obsidian/api'

interface WriteBody {
  path: string
  content: string
  expectedModifiedMs?: number
}

interface MoveBody {
  from: string
  to: string
}

export function registerVaultApi(webServer: WebServer, vault: VaultManager, mutationOrigin: string): () => void {
  const authority = normalizeOrigin(mutationOrigin)
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        await route(request, response, vault, authority)
      } catch (error) {
        sendError(response, error)
      }
    },
  })
}

async function route(request: IncomingMessage, response: ServerResponse, vault: VaultManager, authority: string): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://dsh.local')
  const endpoint = url.pathname.slice(API_PREFIX.length) || '/'
  if (request.method === 'GET' && endpoint === '/info') {
    sendJson(response, 200, { name: vault.root.split(/[\\/]/u).at(-1) ?? vault.root, root: vault.root })
    return
  }
  if (request.method === 'GET' && endpoint === '/tree') {
    sendJson(response, 200, { nodes: await vault.listTree() })
    return
  }
  if (request.method === 'GET' && endpoint === '/directories') {
    sendJson(response, 200, await vault.listDirectories(url.searchParams.get('path') ?? undefined))
    return
  }
  if (request.method === 'GET' && endpoint === '/note') {
    sendJson(response, 200, await vault.readNote(requiredQuery(url, 'path')))
    return
  }
  if (request.method === 'GET' && endpoint === '/search') {
    sendJson(response, 200, { results: await vault.searchNotes(requiredQuery(url, 'q')) })
    return
  }
  if (request.method === 'GET' && endpoint === '/asset') {
    const asset = await vault.openAsset(requiredQuery(url, 'path'))
    response.writeHead(200, {
      'Content-Type': asset.contentType,
      'Content-Length': asset.size,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    })
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(asset.handle.readableWebStream() as never)
      stream.once('error', reject)
      response.once('finish', resolve)
      stream.pipe(response)
    }).finally(async () => asset.handle.close())
    return
  }
  if (request.method === 'PUT' && endpoint === '/note') {
    assertConfiguredOrigin(request, authority)
    const body = await readJson(request, vault.maxNoteBytes + 4096)
    if (!isRecord(body) || typeof body.path !== 'string' || typeof body.content !== 'string'
      || (body.expectedModifiedMs !== undefined && (typeof body.expectedModifiedMs !== 'number' || !Number.isFinite(body.expectedModifiedMs)))) {
      throw new VaultError('Invalid note write body.', 'INVALID_BODY', 400)
    }
    sendJson(response, 200, await vault.writeNote(body.path, body.content, body.expectedModifiedMs as number | undefined))
    return
  }
  if (request.method === 'POST' && endpoint === '/vault') {
    assertConfiguredOrigin(request, authority)
    const body = await readJson(request, 8192)
    if (!isRecord(body) || typeof body.root !== 'string') {
      throw new VaultError('Invalid vault selection body.', 'INVALID_BODY', 400)
    }
    await vault.select(body.root)
    sendJson(response, 200, { name: vault.root.split(/[\\/]/u).at(-1) ?? vault.root, root: vault.root })
    return
  }
  if (request.method === 'POST' && endpoint === '/move') {
    assertConfiguredOrigin(request, authority)
    const body = await readJson(request, 8192)
    if (!isRecord(body) || typeof body.from !== 'string' || typeof body.to !== 'string') {
      throw new VaultError('Invalid move body.', 'INVALID_BODY', 400)
    }
    sendJson(response, 200, await vault.moveNote(body.from, body.to))
    return
  }
  if (request.method === 'DELETE' && endpoint === '/note') {
    assertConfiguredOrigin(request, authority)
    await vault.deleteNote(requiredQuery(url, 'path'))
    response.writeHead(204)
    response.end()
    return
  }
  throw new VaultError('API endpoint not found.', 'NOT_FOUND', 404)
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key)
  if (value === null) throw new VaultError(`Missing query parameter: ${key}`, 'INVALID_QUERY', 400)
  return value
}

function assertConfiguredOrigin(request: IncomingMessage, authority: string): void {
  const origin = request.headers.origin
  if (origin === undefined) {
    throw new VaultError('Note mutations require a same-origin browser request.', 'ORIGIN_DENIED', 403)
  }
  try {
    if (normalizeOrigin(origin) === authority) return
  } catch {
    // A malformed Origin is not a valid same-origin browser request.
  }
  throw new VaultError('Note mutations require a same-origin browser request.', 'ORIGIN_DENIED', 403)
}

function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('dsh-obsidian: mutationOrigin must be an HTTP(S) origin without a path.')
  }
  return url.origin
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? ''
  const mediaType = contentType.split(';', 1)[0]?.trim().toLocaleLowerCase()
  if (mediaType !== 'application/json') {
    throw new VaultError('Content-Type must be application/json.', 'INVALID_BODY', 415)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new VaultError('Request body is too large.', 'BODY_TOO_LARGE', 413)
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new VaultError('Request body is not valid JSON.', 'INVALID_BODY', 400)
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined)
    return
  }
  const status = error instanceof VaultError ? error.status : 500
  const payload: ApiErrorPayload = {
    error: error instanceof Error ? error.message : 'Unexpected vault error.',
    code: error instanceof VaultError ? error.code : 'INTERNAL_ERROR',
  }
  sendJson(response, status, payload)
}
