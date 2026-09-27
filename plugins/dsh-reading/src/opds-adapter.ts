import { createHash } from 'node:crypto'
import type { BookFormat } from './contracts.ts'
import { readCredentialRefs } from './credentials.ts'
import { LocalLibrary, ReadingError } from './library.ts'
import { readRemoteCache, writeRemoteCache } from './remote-cache.ts'

export interface OpdsConfig {
  name: string
  url: string
  username?: string
  password?: string
  timeoutMs?: number
}

export interface OpdsBook {
  id: string
  source: 'opds'
  title: string
  author?: string
  format: BookFormat
  href: string
  coverHref?: string
}

const MIME_FORMAT: Record<string, BookFormat> = {
  'application/epub+zip': 'epub',
  'application/pdf': 'pdf',
  'application/x-mobipocket-ebook': 'mobi',
  'application/x-mobi8-ebook': 'azw3',
  'application/vnd.amazon.ebook': 'azw',
}

export class OpdsAdapter {
  readonly #config: OpdsConfig
  #cache: OpdsBook[] | undefined
  #cacheAt = 0

  get name(): string { return this.#config.name }
  get settings(): { name: string; url: string; timeoutMs: number; cacheTtlMs: number } {
    return { name: this.#config.name, url: this.#config.url, timeoutMs: this.#config.timeoutMs ?? 20_000, cacheTtlMs: 300_000 }
  }

  /** Full config including credentials — server-side only (config export), never sent to browsers via `settings`. */
  get rawConfig(): OpdsConfig {
    return { ...this.#config }
  }

  constructor(config: OpdsConfig, private readonly fetchImpl: typeof fetch = fetch) {
    let parsed: URL
    try { parsed = new URL(config.url) } catch { throw new ReadingError('OPDS URL is invalid.', 'OPDS_CONFIG', 500) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ReadingError('OPDS URL is invalid.', 'OPDS_CONFIG', 500)
    this.#config = { ...config, url: parsed.toString() }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpdsAdapter | undefined {
    const refs = readCredentialRefs(env)
    const url = (env.READING_OPDS_0_URL ?? '').trim()
    if (url === '') return undefined
    const timeout = Number(env.READING_FETCH_TIMEOUT_MS)
    const username = (env.READING_OPDS_0_USERNAME ?? '').trim()
    const password = (env.READING_OPDS_0_PASSWORD ?? refs.READING_OPDS_0_PASSWORD ?? '').trim()
    return new OpdsAdapter({
      name: (env.READING_OPDS_0_NAME ?? 'nasubuntu').trim() || 'nasubuntu', url,
      ...(username === '' || password === '' ? {} : { username, password }),
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    })
  }

  async listBooks(): Promise<OpdsBook[]> {
    if (this.#cache !== undefined && Date.now() - this.#cacheAt < 5 * 60_000) return this.#cache
    try {
    const response = await this.request(this.#config.url)
    const xml = await response.text()
    const books = parseFeed(xml, this.#config.url)
    if (books.length > 0) return this.#remember(await this.fetchBooksPages(this.#config.url, this.#config.url))
    // Calibre-Web exposes a navigation feed at /opds and the actual catalog
    // under the first /opds/books acquisition collection.
    const attributes = [...xml.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)].map(item => attrs(item[1] ?? ''))
      .find(item => item.href?.includes('/opds/books') && item.rel !== 'self')
    if (attributes?.href === undefined) return []
    const catalogUrl = new URL(decodeXml(attributes.href), this.#config.url).toString()
    const catalog = await this.request(catalogUrl)
    const catalogXml = await catalog.text()
    const catalogBooks = parseFeed(catalogXml, catalogUrl)
    if (catalogBooks.length > 0) return this.#remember(await this.fetchBooksPages(catalogUrl, this.#config.url))
    const subsectionAttrs = [...catalogXml.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)].map(item => attrs(item[1] ?? ''))
      .find(item => (item.rel ?? '').includes('subsection'))
    if (subsectionAttrs?.href === undefined) return []
    return this.#remember(await this.fetchBooksPages(new URL(decodeXml(subsectionAttrs.href), catalogUrl).toString(), catalogUrl))
    } catch (error) {
      const cached = await readRemoteCache<OpdsBook[]>('opds', this.#config.url)
      if (cached !== undefined) { this.#cache = cached.value; this.#cacheAt = cached.cachedAt; return cached.value }
      throw error
    }
  }

  #remember(books: OpdsBook[]): OpdsBook[] { this.#cache = books; this.#cacheAt = Date.now(); void writeRemoteCache('opds', this.#config.url, books); return books }

  private async fetchBooksPages(url: string, baseUrl: string, seen = new Set<string>()): Promise<OpdsBook[]> {
    // Calibre-Web defaults to 60 entries per page; six pages covers the
    // configured NAS library while keeping the sidebar responsive.
    if (seen.has(url) || seen.size >= 6) return []
    seen.add(url)
    const response = await this.request(url)
    const xml = await response.text()
    const books = parseFeed(xml, url)
    const nextAttrs = [...xml.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)].map(item => attrs(item[1] ?? ''))
      .find(item => (item.rel ?? '').includes('next') && item.href !== undefined)
    if (nextAttrs?.href === undefined) return books
    return books.concat(await this.fetchBooksPages(new URL(decodeXml(nextAttrs.href), url).toString(), baseUrl, seen))
  }

  async importBook(id: string, library: LocalLibrary): Promise<Awaited<ReturnType<LocalLibrary['importBook']>>> {
    const books = await this.listBooks()
    const book = books.find(item => item.id === id)
    if (book === undefined) throw new ReadingError('OPDS book not found.', 'NOT_FOUND', 404)
    const stableDir = `${id.replace(/^opds:/u, 'opds')}-${book.title}`
    const fileName = `${book.title}.${book.format}`
    const cached = await library.cachedBook(stableDir, fileName)
    if (cached !== undefined) return cached
    const response = await this.request(book.href)
    const data = Buffer.from(await response.arrayBuffer())
    return library.importBook(data, fileName, stableDir)
  }

  private async request(url: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/atom+xml, application/xml, application/octet-stream' }
    if (this.#config.username !== undefined && this.#config.password !== undefined) {
      headers.Authorization = `Basic ${Buffer.from(`${this.#config.username}:${this.#config.password}`).toString('base64')}`
    }
    try {
      const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.#config.timeoutMs ?? 20_000) })
      if (!response.ok) throw new ReadingError(`OPDS request failed (${response.status}).`, 'OPDS_REQUEST', response.status === 404 ? 404 : 502)
      return response
    } catch (error) {
      if (error instanceof ReadingError) throw error
      throw new ReadingError('OPDS is unavailable.', 'OPDS_UNAVAILABLE', 503)
    }
  }
}

function parseFeed(xml: string, baseUrl: string): OpdsBook[] {
  const books: OpdsBook[] = []
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const body = match[1] ?? ''
    const title = decodeXml(textTag(body, 'title')).trim()
    if (title === '') continue
    const author = decodeXml(textTag(body, 'author', 'name')).trim() || undefined
    const links = [...body.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)].map(item => attrs(item[1] ?? ''))
    const acquisition = links.find(link => /acquisition/i.test(link.rel ?? '') && MIME_FORMAT[(link.type ?? '').toLowerCase()] !== undefined)
    if (acquisition?.href === undefined) continue
    const type = (acquisition.type ?? '').toLowerCase()
    const format = MIME_FORMAT[type]
    if (format === undefined) continue
    const href = new URL(decodeXml(acquisition.href), baseUrl).toString()
    const cover = links.find(link => /image/i.test(link.type ?? '') && link.href !== undefined)
    books.push({
      id: `opds:${createHash('sha1').update(href).digest('hex').slice(0, 16)}`,
      source: 'opds', title, ...(author === undefined ? {} : { author }), format, href,
      ...(cover?.href === undefined ? {} : { coverHref: new URL(decodeXml(cover.href), baseUrl).toString() }),
    })
  }
  return books
}

function textTag(xml: string, tag: string, nested?: string): string {
  const outer = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)?.[1] ?? ''
  return nested === undefined ? outer.replace(/<[^>]+>/g, '') : new RegExp(`<${nested}\\b[^>]*>([\\s\\S]*?)</${nested}>`, 'i').exec(outer)?.[1] ?? ''
}

function attrs(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of raw.matchAll(/([:\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) result[match[1] ?? ''] = match[2] ?? match[3] ?? ''
  return result
}

function decodeXml(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
}
