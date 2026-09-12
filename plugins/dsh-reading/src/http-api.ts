import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { Annotation, Locator, ReadingProgress } from './contracts.ts'
import { LocalLibrary, ReadingError } from './library.ts'
import { ReadingStateStore } from './state-store.ts'
import { WallabagAdapter } from './wallabag-adapter.ts'

const API_PREFIX = '/dsh-reading/api'
const MAX_IMPORT_BYTES = 512 * 1024 * 1024

const MIME_BY_FORMAT: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  azw3: 'application/vnd.amazon.ebook',
  mobi: 'application/x-mobipocket-ebook',
  azw: 'application/vnd.amazon.ebook',
}

export function registerReadingApi(webServer: WebServer, library: LocalLibrary, store: ReadingStateStore, wallabag?: WallabagAdapter): () => void {
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        await route(request, response, library, store, wallabag)
      } catch (error) {
        sendError(response, error)
      }
    },
  })
}

async function route(request: IncomingMessage, response: ServerResponse, library: LocalLibrary, store: ReadingStateStore, wallabag?: WallabagAdapter): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://dsh.local')
  const endpoint = url.pathname.slice(API_PREFIX.length) || '/'

  // Browser state-changing requests must originate from this host. Native/API
  // clients commonly omit Origin, so absence remains allowed for compatibility.
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE' || request.method === 'PATCH') {
    const origin = request.headers.origin
    if (origin !== undefined && !isSameOrigin(origin, request)) {
      throw new ReadingError('Cross-origin state-changing request is not allowed.', 'FORBIDDEN_ORIGIN', 403)
    }
  }

  if (request.method === 'GET' && endpoint === '/library') {
    sendJson(response, 200, { books: (await library.listBooks(store.snapshot.progress)).map(toPublicBook) })
    return
  }

  if (request.method === 'POST' && endpoint === '/import') {
    const fileName = url.searchParams.get('filename')
    if (fileName === null || fileName.trim() === '') {
      throw new ReadingError('Missing query parameter: filename', 'INVALID_QUERY', 400)
    }
    const data = await readBody(request, MAX_IMPORT_BYTES)
    sendJson(response, 200, { book: toPublicBook(await library.importBook(data, fileName)) })
    return
  }

  if (request.method === 'GET' && endpoint === '/progress') {
    sendJson(response, 200, { progress: store.snapshot.progress })
    return
  }

  if (endpoint === '/wallabag/entries') {
    if (wallabag === undefined) throw new ReadingError('Wallabag is not configured.', 'WALLABAG_UNAVAILABLE', 503)
    if (request.method === 'GET') {
      const page = parsePositiveInt(url.searchParams.get('page'), 1)
      const perPage = parsePositiveInt(url.searchParams.get('perPage'), 50)
      sendJson(response, 200, { articles: await wallabag.listEntries({ page, perPage }) })
      return
    }
    if (request.method === 'POST') {
      const body = await readJson(request, 32 * 1024)
      if (!isRecord(body) || typeof body.url !== 'string' || body.url.trim() === '') throw new ReadingError('Request body requires url.', 'INVALID_BODY', 400)
      sendJson(response, 200, { article: await wallabag.importUrl(body.url) })
      return
    }
  }
  const articleMatch = /^\/wallabag\/entries\/([^/]+)$/u.exec(endpoint)
  if (articleMatch !== null && articleMatch[1] !== undefined && request.method === 'GET') {
    if (wallabag === undefined) throw new ReadingError('Wallabag is not configured.', 'WALLABAG_UNAVAILABLE', 503)
    const article = await wallabag.getEntry(decodeURIComponent(articleMatch[1]))
    sendJson(response, 200, { article })
    return
  }

  const progressMatch = /^\/progress\/([^/]+)$/u.exec(endpoint)
  if (progressMatch !== null && progressMatch[1] !== undefined) {
    const bookId = decodeURIComponent(progressMatch[1])
    if (request.method === 'GET') {
      const progress = store.getProgress(bookId)
      if (progress === undefined) throw new ReadingError('No progress recorded for this book.', 'NOT_FOUND', 404)
      sendJson(response, 200, { progress })
      return
    }
    if (request.method === 'PUT') {
      const body = await readJson(request, 64 * 1024)
      const progress = normalizeProgress(bookId, body)
      sendJson(response, 200, { progress: await store.setProgress(progress) })
      return
    }
  }

  if (request.method === 'GET' && endpoint === '/annotations') {
    const bookId = url.searchParams.get('bookId') ?? undefined
    sendJson(response, 200, { annotations: store.listAnnotations(bookId) })
    return
  }
  if (request.method === 'POST' && endpoint === '/annotations') {
    const body = await readJson(request, 256 * 1024)
    const annotation = normalizeAnnotation(body)
    sendJson(response, 200, { annotation: await store.addAnnotation(annotation) })
    return
  }
  const annotationMatch = /^\/annotations\/([^/]+)$/u.exec(endpoint)
  if (annotationMatch !== null && annotationMatch[1] !== undefined && request.method === 'DELETE') {
    const removed = await store.removeAnnotation(decodeURIComponent(annotationMatch[1]))
    if (!removed) throw new ReadingError('Annotation not found.', 'NOT_FOUND', 404)
    response.writeHead(204)
    response.end()
    return
  }

  const fileMatch = /^\/book\/([^/]+)\/file$/u.exec(endpoint)
  if (fileMatch !== null && fileMatch[1] !== undefined && request.method === 'GET') {
    await sendBookFile(request, response, library, decodeURIComponent(fileMatch[1]))
    return
  }

  const bookMatch = /^\/book\/([^/]+)$/u.exec(endpoint)
  if (bookMatch !== null && bookMatch[1] !== undefined && request.method === 'GET') {
    const bookId = decodeURIComponent(bookMatch[1])
    const book = (await library.listBooks(store.snapshot.progress)).find(item => item.id === bookId)
    if (book === undefined) throw new ReadingError('Book not found.', 'NOT_FOUND', 404)
    sendJson(response, 200, { book: toPublicBook(book) })
    return
  }

  throw new ReadingError('API endpoint not found.', 'NOT_FOUND', 404)
}

/** Keep filesystem details inside the host; clients use the file endpoint by id. */
function toPublicBook<T extends { filePath: string }>(book: T): Omit<T, 'filePath'> {
  const { filePath: _filePath, ...publicBook } = book
  return publicBook
}

/** Stream a local book file, honoring `Range` (required by PDF.js). */
async function sendBookFile(request: IncomingMessage, response: ServerResponse, library: LocalLibrary, bookId: string): Promise<void> {
  const { filePath, format, fileName, fileSize } = await library.resolveFile(bookId)
  const mime = MIME_BY_FORMAT[format] ?? 'application/octet-stream'
  const rangeHeader = request.headers.range

  const baseHeaders: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  }

  if (rangeHeader === undefined) {
    response.writeHead(200, { ...baseHeaders, 'Content-Length': fileSize })
    await pipe(response, filePath, {})
    return
  }

  const range = parseRange(rangeHeader, fileSize)
  if (range === null) {
    response.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${fileSize}` })
    response.end()
    return
  }
  const { start, end } = range
  response.writeHead(206, {
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Content-Length': end - start + 1,
  })
  await pipe(response, filePath, { start, end })
}

function pipe(response: ServerResponse, filePath: string, range: { start?: number; end?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, range)
    stream.once('error', reject)
    response.once('finish', resolve)
    response.once('close', resolve)
    stream.pipe(response)
  })
}

export function parseRange(header: string, size: number): { start: number; end: number } | null {
  if (!Number.isInteger(size) || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return null
  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') return null
  if (startRaw === '') {
    // suffix range: last N bytes
    const suffix = Number(endRaw)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }
  const start = Number(startRaw)
  if (!Number.isSafeInteger(start) || start >= size) return null
  if (endRaw === '') return { start, end: size - 1 }
  const requestedEnd = Number(endRaw)
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null
  const end = Math.min(requestedEnd, size - 1)
  return { start, end }
}

function isSameOrigin(origin: string, request: IncomingMessage): boolean {
  try {
    const parsed = new URL(origin)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false
    const host = request.headers.host
    if (host === undefined) return false
    const forwardedProto = request.headers['x-forwarded-proto']
    const protocol = typeof forwardedProto === 'string' && forwardedProto.split(',')[0] !== ''
      ? forwardedProto.split(',')[0]!.trim()
      : 'http'
    return parsed.protocol === `${protocol}:` && parsed.host === host
  } catch {
    return false
  }
}

function normalizeProgress(bookId: string, body: unknown): ReadingProgress {
  if (!isRecord(body) || !isLocator(body.locator) || typeof body.percent !== 'number' || !Number.isFinite(body.percent)) {
    throw new ReadingError('Progress body requires locator and numeric percent.', 'INVALID_BODY', 400)
  }
  return {
    bookId,
    locator: body.locator,
    percent: Math.min(1, Math.max(0, body.percent)),
    updatedAt: new Date().toISOString(),
  }
}

function normalizeAnnotation(body: unknown): Annotation {
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.bookId !== 'string' || !isLocator(body.locator) || typeof body.quote !== 'string') {
    throw new ReadingError('Annotation body requires id, bookId, locator and quote.', 'INVALID_BODY', 400)
  }
  const color = body.color === 'green' || body.color === 'blue' || body.color === 'pink' ? body.color : 'yellow'
  return {
    id: body.id,
    bookId: body.bookId,
    locator: body.locator,
    ...(typeof body.chapter === 'string' ? { chapter: body.chapter } : {}),
    quote: body.quote,
    ...(typeof body.note === 'string' ? { note: body.note } : {}),
    color,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : new Date().toISOString(),
  }
}

function isLocator(value: unknown): value is Locator {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'epub') return typeof value.cfi === 'string' && typeof value.chapterHref === 'string'
  if (value.type === 'pdf') return typeof value.page === 'number' && typeof value.scrollRatio === 'number'
  if (value.type === 'article') return typeof value.scrollRatio === 'number'
  return false
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new ReadingError('Request body is too large.', 'BODY_TOO_LARGE', 413)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? ''
  const mediaType = contentType.split(';', 1)[0]?.trim().toLocaleLowerCase()
  if (mediaType !== 'application/json') {
    throw new ReadingError('Content-Type must be application/json.', 'INVALID_BODY', 415)
  }
  const raw = await readBody(request, limit)
  try {
    return JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    throw new ReadingError('Request body is not valid JSON.', 'INVALID_BODY', 400)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(100, parsed) : fallback
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
  if (error instanceof ReadingError) {
    sendJson(response, error.status, { error: error.message, code: error.code })
    return
  }
  sendJson(response, 500, { error: error instanceof Error ? error.message : 'Unexpected reading error.', code: 'INTERNAL_ERROR' })
}
