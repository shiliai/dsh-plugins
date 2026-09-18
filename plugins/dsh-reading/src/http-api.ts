import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, stat, writeFile, access, rename, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { Annotation, Article, BookMetadata, Locator, ReadingProgress } from './contracts.ts'
import { LocalLibrary, ReadingError } from './library.ts'
import { ReadingStateStore } from './state-store.ts'
import { WallabagAdapter, isUnextractedContent, sanitizeHtml } from './wallabag-adapter.ts'
import { extractArticle, type ExtractedArticle } from './extract/index.ts'
import { OpdsAdapter } from './opds-adapter.ts'
import { CalibreWebClient } from './calibre-web.ts'
import { articleMetadata, bookMetadata, projectDirectory, relativeProjectPath, type ReadingProjectConfig, writeProjectMetadata } from './project-cache.ts'
import type { AgentSkillInput, SkillStore } from '@dsh-plugins/dsh-reading-core'

const API_PREFIX = '/dsh-reading/api'
const MAX_IMPORT_BYTES = 512 * 1024 * 1024
const execFileAsync = promisify(execFile)

type ProjectAccess = { get(): ReadingProjectConfig; update(value: ReadingProjectConfig): Promise<void>; skills?(): SkillStore }

const MIME_BY_FORMAT: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  azw3: 'application/vnd.amazon.ebook',
  mobi: 'application/x-mobipocket-ebook',
  azw: 'application/vnd.amazon.ebook',
}

export function registerReadingApi(webServer: WebServer, library: LocalLibrary, store: ReadingStateStore, wallabag?: WallabagAdapter, opds?: OpdsAdapter, project?: ProjectAccess, calibre?: CalibreWebClient): () => void {
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        await route(request, response, library, store, wallabag, opds, project, calibre)
      } catch (error) {
        sendError(response, error)
      }
    },
  })
}

async function route(request: IncomingMessage, response: ServerResponse, library: LocalLibrary, store: ReadingStateStore, wallabag?: WallabagAdapter, opds?: OpdsAdapter, project?: ProjectAccess, calibre?: CalibreWebClient): Promise<void> {
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

  if (endpoint === '/settings' && project !== undefined) {
    if (request.method === 'GET') { sendJson(response, 200, { ...project.get(), sources: { wallabag: wallabag?.settings ?? null, opds: opds?.settings ?? null }, cache: { directory: 'DSH_HOME/cache/dsh-reading', staleWhileRevalidate: true, eviction: 'managed by host cache policy' } }); return }
    if (request.method === 'PUT') {
      const body = await readJson(request, 32 * 1024)
      if (!isRecord(body) || typeof body.rootDir !== 'string' || body.rootDir.trim() === '') throw new ReadingError('rootDir is required.', 'INVALID_BODY', 400)
      const next = { rootDir: body.rootDir.trim(), createSessionOnOpen: body.createSessionOnOpen === true }
      await project.update(next); sendJson(response, 200, { ...next, sources: { wallabag: wallabag?.settings ?? null, opds: opds?.settings ?? null }, cache: { directory: 'DSH_HOME/cache/dsh-reading', staleWhileRevalidate: true, eviction: 'managed by host cache policy' } }); return
    }
  }

  const skills = project?.skills?.()
  if (request.method === 'GET' && endpoint === '/skills' && skills !== undefined) {
    sendJson(response, 200, { result: await skills.list() })
    return
  }
  if (request.method === 'GET' && endpoint === '/skill' && skills !== undefined) {
    sendJson(response, 200, await skills.read(requiredQuery(url, 'name')))
    return
  }
  if (request.method === 'PUT' && endpoint === '/skill' && skills !== undefined) {
    const body = await readJson(request, 2 * 1024 * 1024)
    if (!isRecord(body) || !isRecord(body.skill)) throw new ReadingError('Invalid skill write body.', 'INVALID_BODY', 400)
    const input = normalizeSkillInput(body.skill)
    const previousName = typeof body.previousName === 'string' ? body.previousName : undefined
    const expectedRevision = typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined
    const value = previousName !== undefined && expectedRevision !== undefined
      ? await skills.update(previousName, expectedRevision, input)
      : await skills.create(input)
    sendJson(response, 200, { result: { value, refreshFailed: false } })
    return
  }
  if (request.method === 'DELETE' && endpoint === '/skill' && skills !== undefined) {
    await skills.delete(requiredQuery(url, 'name'), requiredQuery(url, 'expectedRevision'))
    sendJson(response, 200, { result: { value: null, refreshFailed: false } })
    return
  }

  const projectBook = /^\/project\/book\/([^/]+)$/u.exec(endpoint)
  if (projectBook !== null && request.method === 'POST' && project !== undefined) {
    const bookId = decodeURIComponent(projectBook[1]!)
    const book = (await library.listBooks(store.snapshot.progress)).find(item => item.id === bookId)
    if (book === undefined) throw new ReadingError('Book not found.', 'NOT_FOUND', 404)
    const cfg = project.get(); const dir = projectDirectory(cfg, 'books', book.id, book.title); await mkdir(dir, { recursive: true })
    const target = `${dir}/${book.fileName}`
    try { await stat(target) } catch { await copyFile(book.filePath, target) }
    const path = relativeProjectPath(cfg.rootDir, dir)
    const metadata = bookMetadata(book, path)
    if (book.format === 'azw3' || book.format === 'mobi' || book.format === 'azw') {
      const converted = `${dir}/${book.fileName.replace(/\.[^.]+$/u, '')}.epub`
      try {
        await access(converted)
        ;(metadata as any).convertedTo = { path: `${path}/${converted.split('/').pop()}`, at: new Date().toISOString(), status: 'reused' }
      } catch {
        try {
          const temp = `${converted}.tmp-${process.pid}-${Date.now()}`
          await execFileAsync('ebook-convert', [target, temp], { timeout: 120000 })
          await rename(temp, converted)
          ;(metadata as any).convertedTo = { path: `${path}/${converted.split('/').pop()}`, at: new Date().toISOString(), status: 'converted' }
        } catch (error) {
          ;(metadata as any).conversion = { status: 'failed', error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() }
        }
      }
    }
    await writeProjectMetadata(dir, metadata); sendJson(response, 200, { path, absolutePath: dir, metadata }); return
  }

  // Body-based variant of the route below: writes the article project from the
  // request payload alone, so locally extracted (non-wallabag) articles work too.
  if (request.method === 'POST' && endpoint === '/project/article' && project !== undefined) {
    const body = await readJson(request, 4 * 1024 * 1024)
    if (!isRecord(body) || !isRecord(body.article)) throw new ReadingError('Request body requires article.', 'INVALID_BODY', 400)
    const raw = body.article
    if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.title !== 'string' || raw.title === '' || typeof raw.url !== 'string' || raw.url === '') {
      throw new ReadingError('Article requires id, title and url.', 'INVALID_BODY', 400)
    }
    const article: Article = {
      id: raw.id,
      source: raw.source === 'extract' ? 'extract' : 'wallabag',
      url: raw.url,
      title: raw.title,
      ...(typeof raw.domain === 'string' ? { domain: raw.domain } : {}),
      ...(typeof raw.originalUrl === 'string' ? { originalUrl: raw.originalUrl } : {}),
      ...(typeof raw.publishedAt === 'string' ? { publishedAt: raw.publishedAt } : {}),
      ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
      isArchived: raw.isArchived === true,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
      ...(typeof raw.extractedHtml === 'string' ? { extractedHtml: sanitizeHtml(raw.extractedHtml) } : {}),
    }
    await writeArticleProject(project, article)
    const cfg = project.get()
    const dir = projectDirectory(cfg, 'articles', article.id, article.title)
    sendJson(response, 200, { path: relativeProjectPath(cfg.rootDir, dir), absolutePath: dir })
    return
  }

  const projectArticle = /^\/project\/article\/([^/]+)$/u.exec(endpoint)
  if (projectArticle !== null && request.method === 'POST' && project !== undefined && wallabag !== undefined) {
    const article = await wallabag.getEntry(decodeURIComponent(projectArticle[1]!))
    await writeArticleProject(project, article)
    const cfg = project.get()
    const dir = projectDirectory(cfg, 'articles', article.id, article.title)
    sendJson(response, 200, { path: relativeProjectPath(cfg.rootDir, dir), absolutePath: dir })
    return
  }

  if (request.method === 'GET' && endpoint === '/opds/books') {
    if (opds === undefined) throw new ReadingError('OPDS is not configured.', 'OPDS_UNAVAILABLE', 503)
    sendJson(response, 200, { source: opds.name, books: await opds.listBooks() })
    return
  }
  const opdsImport = /^\/opds\/books\/([^/]+)\/import$/u.exec(endpoint)
  if (opdsImport !== null && opdsImport[1] !== undefined && request.method === 'POST') {
    if (opds === undefined) throw new ReadingError('OPDS is not configured.', 'OPDS_UNAVAILABLE', 503)
    const imported = await opds.importBook(decodeURIComponent(opdsImport[1]), library)
    if (project !== undefined) {
      const dir = projectDirectory(project.get(), 'books', imported.id, imported.title)
      await writeProjectMetadata(dir, bookMetadata(imported, relativeProjectPath(project.get().rootDir, dir)))
    }
    sendJson(response, 200, { book: toPublicBook(imported) })
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

  // Open-first article flow: local extraction happens before/without wallabag,
  // so CSR pages that wallabag cannot fetch stay readable.
  if (request.method === 'POST' && endpoint === '/articles/open') {
    const body = await readJson(request, 64 * 1024)
    if (!isRecord(body) || typeof body.url !== 'string' || body.url.trim() === '') throw new ReadingError('Request body requires url.', 'INVALID_BODY', 400)
    const target = normalizeHttpUrl(body.url)
    if (wallabag !== undefined) {
      const entryId = await wallabag.findEntryByUrl(target)
      if (entryId !== undefined) {
        const article = await wallabag.getEntry(entryId)
        if (isUnextractedContent(article.extractedHtml)) {
          // Stored entry holds wallabag's fetch-error placeholder; repair from
          // the local pipeline and fall back to the stored entry on failure.
          const repaired = await repairWallabagEntry(wallabag, entryId, target)
          sendJson(response, 200, repaired === undefined ? { article, extraction: 'wallabag' } : { article: repaired, extraction: 'repaired' })
          return
        }
        sendJson(response, 200, { article, extraction: 'wallabag' })
        return
      }
    }
    const local = await extractArticle(target).catch(() => undefined)
    if (local !== undefined) {
      sendJson(response, 200, { article: localExtractArticle(target, local), extraction: 'local' })
      return
    }
    if (wallabag !== undefined) {
      sendJson(response, 200, { article: await wallabag.importUrl(target), extraction: 'imported' })
      return
    }
    throw new ReadingError('无法提取该页面正文。', 'EXTRACT_FAILED', 502)
  }

  // Second step of the flow: persist the article into wallabag in the
  // background. Repairing a broken entry takes priority over duplicating it.
  if (request.method === 'POST' && endpoint === '/articles/collect') {
    if (wallabag === undefined) throw new ReadingError('Wallabag is not configured.', 'WALLABAG_UNAVAILABLE', 503)
    const body = await readJson(request, 2 * 1024 * 1024)
    if (!isRecord(body) || typeof body.url !== 'string' || body.url.trim() === '') throw new ReadingError('Request body requires url.', 'INVALID_BODY', 400)
    const target = normalizeHttpUrl(body.url)
    const providedTitle = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined
    const providedHtml = typeof body.html === 'string' && body.html.trim() !== '' ? body.html : undefined
    const providedPublishedAt = typeof body.publishedAt === 'string' && body.publishedAt.trim() !== '' ? body.publishedAt.trim() : undefined

    // Client-provided html wins; remaining gaps are filled by local extraction.
    let contentHtml = providedHtml !== undefined ? sanitizeHtml(providedHtml) : undefined
    let contentTitle = providedTitle
    let contentPublishedAt = providedPublishedAt
    if (contentHtml === undefined || contentTitle === undefined || contentPublishedAt === undefined) {
      const extracted = await extractArticle(target).catch(() => undefined)
      if (extracted !== undefined) {
        if (contentHtml === undefined) contentHtml = sanitizeHtml(extracted.html)
        if (contentTitle === undefined) contentTitle = extracted.title
        if (contentPublishedAt === undefined) contentPublishedAt = extracted.publishedAt
      }
    }

    const entryId = await wallabag.findEntryByUrl(target)
    let action: string
    let id: string
    if (entryId !== undefined) {
      id = entryId
      const current = await wallabag.getEntry(id)
      if (isUnextractedContent(current.extractedHtml) && contentHtml !== undefined) {
        await patchEntryContent(wallabag, id, contentHtml, contentTitle, contentPublishedAt)
        action = 'repaired'
      } else {
        action = 'unchanged'
      }
    } else {
      // Always create the entry, even without content: saving intent wins.
      const created = await wallabag.importUrl(target)
      id = created.id.replace(/^wallabag:/u, '')
      if (isUnextractedContent(created.extractedHtml) && contentHtml !== undefined) {
        await patchEntryContent(wallabag, id, contentHtml, contentTitle, contentPublishedAt)
      }
      action = 'created'
    }
    const article = await wallabag.getEntry(id)
    sendJson(response, 200, { article, action })
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
      const article = await wallabag.importUrl(body.url)
      if (project !== undefined) await writeArticleProject(project, article)
      sendJson(response, 200, { article })
      return
    }
  }
  const articleMatch = /^\/wallabag\/entries\/([^/]+)$/u.exec(endpoint)
  if (articleMatch !== null && articleMatch[1] !== undefined && request.method === 'GET') {
    if (wallabag === undefined) throw new ReadingError('Wallabag is not configured.', 'WALLABAG_UNAVAILABLE', 503)
    const entryId = decodeURIComponent(articleMatch[1])
    let article = await wallabag.getEntry(entryId)
    if (isUnextractedContent(article.extractedHtml)) {
      // Self-heal legacy entries whose content is wallabag's error placeholder.
      const repaired = await repairWallabagEntry(wallabag, entryId, article.url)
      if (repaired !== undefined) article = repaired
    }
    if (project !== undefined) await writeArticleProject(project, article)
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

  const bookMetadataMatch = /^\/book\/([^/]+)\/metadata$/u.exec(endpoint)
  if (bookMetadataMatch !== null && bookMetadataMatch[1] !== undefined) {
    const bookId = decodeURIComponent(bookMetadataMatch[1])
    if (request.method === 'GET') {
      const book = (await library.listBooks(store.snapshot.progress)).find(item => item.id === bookId)
      if (book === undefined) throw new ReadingError('Book not found.', 'NOT_FOUND', 404)
      sendJson(response, 200, { metadata: book.metadata ?? null })
      return
    }
    if (request.method === 'PUT') {
      const body = await readJson(request, 256 * 1024)
      const patch = normalizeMetadataPatch(body)
      const book = await library.saveMetadata(bookId, patch, store.snapshot.progress)
      sendJson(response, 200, { book: toPublicBook(book), metadata: book.metadata ?? null })
      return
    }
  }

  if (request.method === 'POST' && endpoint === '/calibre/upload') {
    if (calibre === undefined) throw new ReadingError('calibre-web 未配置（READING_CALIBRE_WEB_URL）。', 'CALIBRE_UNAVAILABLE', 503)
    const body = await readJson(request, 256 * 1024)
    if (!isRecord(body) || typeof body.bookId !== 'string' || body.bookId === '') throw new ReadingError('Request body requires bookId.', 'INVALID_BODY', 400)
    const book = (await library.listBooks(store.snapshot.progress)).find(item => item.id === body.bookId)
    if (book === undefined) throw new ReadingError('Book not found.', 'NOT_FOUND', 404)
    const file = await library.resolveFile(book.id)
    const data = await readFile(file.filePath)
    const result = await calibre.uploadBook(file.fileName, data, {
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.author === 'string' ? { author: body.author } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
    })
    sendJson(response, 200, { result })
    return
  }

  throw new ReadingError('API endpoint not found.', 'NOT_FOUND', 404)
}

/** Keep filesystem details inside the host; clients use the file endpoint by id. */
function toPublicBook<T extends { filePath: string }>(book: T): Omit<T, 'filePath'> {
  const { filePath: _filePath, ...publicBook } = book
  return publicBook
}

function normalizeHttpUrl(value: string): string {
  let parsed: URL
  try { parsed = new URL(value.trim()) } catch { throw new ReadingError('URL is invalid.', 'INVALID_URL', 400) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ReadingError('Only http(s) URLs can be used.', 'INVALID_URL', 400)
  return parsed.toString()
}

/** Stable client-side id for locally extracted articles (no wallabag entry yet). */
function sha1Prefix(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function localExtractArticle(target: string, extracted: ExtractedArticle): Article {
  return {
    id: `extract:${sha1Prefix(target)}`,
    source: 'extract',
    url: target,
    originalUrl: target,
    title: extracted.title,
    domain: new URL(target).hostname,
    ...(extracted.publishedAt !== undefined ? { publishedAt: extracted.publishedAt } : {}),
    isArchived: false,
    savedAt: new Date().toISOString(),
    extractedHtml: sanitizeHtml(extracted.html),
  }
}

/** Best-effort: write locally extracted content over a wallabag error placeholder. */
async function repairWallabagEntry(wallabag: WallabagAdapter, id: string, url: string): Promise<Article | undefined> {
  try {
    const extracted = await extractArticle(url)
    if (extracted === undefined) return undefined
    await patchEntryContent(wallabag, id, sanitizeHtml(extracted.html), extracted.title, extracted.publishedAt)
    return await wallabag.getEntry(id)
  } catch {
    return undefined
  }
}

async function patchEntryContent(wallabag: WallabagAdapter, id: string, content: string, title?: string, publishedAt?: string): Promise<void> {
  await wallabag.updateEntry(id, {
    content,
    ...(title !== undefined ? { title } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  })
}

/** Mirror an article into the Reading workspace (metadata.json + article.md). */
async function writeArticleProject(project: ProjectAccess, article: Article): Promise<void> {
  const cfg = project.get()
  const dir = projectDirectory(cfg, 'articles', article.id, article.title)
  await mkdir(dir, { recursive: true })
  const path = relativeProjectPath(cfg.rootDir, dir)
  await writeProjectMetadata(dir, articleMetadata(article, path))
  const plain = (article.extractedHtml ?? '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
  await writeFile(`${dir}/article.md`, `# ${article.title}\n\nSource: ${article.url}\n\n${plain}\n`, 'utf8')
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

function normalizeMetadataPatch(body: unknown): Partial<Omit<BookMetadata, 'updatedAt'>> {
  if (!isRecord(body)) throw new ReadingError('Metadata body must be an object.', 'INVALID_BODY', 400)
  const patch: Partial<Omit<BookMetadata, 'updatedAt'>> = {}
  if (typeof body.title === 'string') patch.title = body.title
  if (typeof body.author === 'string') patch.author = body.author
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some(tag => typeof tag !== 'string')) throw new ReadingError('Metadata tags must be a string array.', 'INVALID_BODY', 400)
    patch.tags = body.tags
  }
  if (typeof body.summary === 'string') patch.summary = body.summary
  if (patch.title === undefined && patch.author === undefined && patch.tags === undefined && patch.summary === undefined) {
    throw new ReadingError('Metadata body requires at least one field.', 'INVALID_BODY', 400)
  }
  return patch
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

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key)
  if (value === null || value.trim() === '') throw new ReadingError(`Missing query parameter: ${key}`, 'INVALID_QUERY', 400)
  return value
}

function normalizeSkillInput(value: Record<string, unknown>): AgentSkillInput {
  if (typeof value.name !== 'string' || typeof value.description !== 'string' || typeof value.instructions !== 'string') {
    throw new ReadingError('Skill requires name, description and instructions.', 'INVALID_BODY', 400)
  }
  return {
    name: value.name,
    description: value.description,
    ...(typeof value.whenToUse === 'string' ? { whenToUse: value.whenToUse } : {}),
    modelInvocable: value.modelInvocable !== false,
    userInvocable: value.userInvocable !== false,
    instructions: value.instructions,
  }
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
  if (error instanceof Error) {
    const code = error.constructor.name
    const status = code === 'AgentSkillRevisionConflictError' || code === 'AgentSkillCollisionError' ? 409
      : code === 'AgentSkillValidationError' || code === 'AgentSkillCodecError' ? 400
        : code === 'AgentSkillStoreError' ? 500 : undefined
    if (status !== undefined) {
      sendJson(response, status, { error: error.message, code })
      return
    }
  }
  sendJson(response, 500, { error: error instanceof Error ? error.message : 'Unexpected reading error.', code: 'INTERNAL_ERROR' })
}
