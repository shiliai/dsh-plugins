import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { ApiErrorPayload, UploadInput } from './contracts.ts'
import { AttachmentError, TemporaryFileStore } from './file-store.ts'

const API_PREFIX = '/dsh-file-attachment/api'

export function registerAttachmentApi(webServer: WebServer, store: TemporaryFileStore, allowedOrigins: readonly string[]): () => void {
  const configured = new Set(allowedOrigins.map(normalizeOrigin))
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        await route(request, response, store, configured)
      } catch (error) {
        sendError(response, error)
      }
    },
  })
}

async function route(request: IncomingMessage, response: ServerResponse, store: TemporaryFileStore, allowedOrigins: ReadonlySet<string>): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://dsh.local')
  const endpoint = url.pathname.slice(API_PREFIX.length) || '/'
  if (request.method === 'GET' && endpoint === '/limits') {
    sendJson(response, 200, store.limits)
    return
  }
  if (request.method === 'POST' && endpoint === '/upload') {
    assertSameOrigin(request, allowedOrigins)
    const encodedLimit = Math.ceil(store.limits.maxMessageBytes / 3) * 4 + store.limits.maxFilesPerMessage * 1024
    const body = await readJson(request, encodedLimit)
    if (!isRecord(body) || !Array.isArray(body.files) || !body.files.every(isUploadInput)
      || !Array.isArray(body.existingFileIds) || !body.existingFileIds.every(value => typeof value === 'string')) {
      throw new AttachmentError('Invalid upload body.', 'INVALID_BODY', 400)
    }
    sendJson(response, 201, { files: await store.saveBatch(body.files, body.existingFileIds) })
    return
  }
  if (request.method === 'DELETE' && endpoint === '/file') {
    assertSameOrigin(request, allowedOrigins)
    const body = await readJson(request, 4096)
    if (!isRecord(body) || typeof body.fileId !== 'string') {
      throw new AttachmentError('Invalid delete body.', 'INVALID_BODY', 400)
    }
    await store.remove(body.fileId)
    response.writeHead(204, noStoreHeaders())
    response.end()
    return
  }
  throw new AttachmentError('API endpoint not found.', 'NOT_FOUND', 404)
}

function assertSameOrigin(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): void {
  const raw = request.headers.origin
  if (raw === undefined || raw === 'null') throw new AttachmentError('File mutations require a same-origin browser request.', 'ORIGIN_DENIED', 403)
  let origin: string
  try {
    origin = normalizeOrigin(raw)
  } catch {
    throw new AttachmentError('File mutations require a same-origin browser request.', 'ORIGIN_DENIED', 403)
  }
  if (allowedOrigins.has(origin)) return
  const host = request.headers.host
  if (host !== undefined && new URL(origin).host.toLowerCase() === host.split(',', 1)[0]?.trim().toLowerCase()) return
  throw new AttachmentError('File mutations require a same-origin browser request.', 'ORIGIN_DENIED', 403)
}

function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('Origin must be an HTTP(S) origin.')
  }
  return url.origin
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUploadInput(value: unknown): value is UploadInput {
  return isRecord(value) && typeof value.name === 'string' && value.name.length <= 1024
    && typeof value.mediaType === 'string' && value.mediaType.length <= 255
    && typeof value.data === 'string'
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const mediaType = (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') throw new AttachmentError('Content-Type must be application/json.', 'INVALID_BODY', 415)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new AttachmentError('Request body is too large.', 'BODY_TOO_LARGE', 413)
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new AttachmentError('Request body is not valid JSON.', 'INVALID_BODY', 400)
  }
}

function noStoreHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    ...noStoreHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  })
  response.end(body)
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined)
    return
  }
  const payload: ApiErrorPayload = {
    error: error instanceof Error ? error.message : 'Unexpected attachment error.',
    code: error instanceof AttachmentError ? error.code : 'INTERNAL_ERROR',
  }
  sendJson(response, error instanceof AttachmentError ? error.status : 500, payload)
}
