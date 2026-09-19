import { readCredentialRefs } from './credentials.ts'
import type { Article } from './contracts.ts'
import { ReadingError } from './library.ts'
import { readRemoteCache, writeRemoteCache } from './remote-cache.ts'

export interface WallabagConfig {
  origin: string
  clientId: string
  clientSecret: string
  username: string
  password: string
  timeoutMs?: number
}

interface TokenResponse { access_token?: unknown; expires_in?: unknown }

/** Small Wallabag REST client. Credentials stay on the host and are never returned. */
export class WallabagAdapter {
  readonly #config: WallabagConfig
  #bearerToken: string | undefined
  #expiresAt = 0
  #entriesCache: { articles: Article[]; at: number } | undefined

  get settings(): { origin: string; timeoutMs: number; cacheTtlMs: number } {
    return { origin: this.#config.origin, timeoutMs: this.#config.timeoutMs ?? 20_000, cacheTtlMs: 60_000 }
  }

  constructor(config: WallabagConfig, private readonly fetchImpl: typeof fetch = fetch) {
    let origin: URL
    try { origin = new URL(config.origin) } catch { throw new ReadingError('Wallabag URL is invalid.', 'WALLABAG_CONFIG', 500) }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') throw new ReadingError('Wallabag URL is invalid.', 'WALLABAG_CONFIG', 500)
    this.#config = { ...config, origin: origin.toString().replace(/\/$/u, '') }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WallabagAdapter | undefined {
    const refs = readCredentialRefs(env)
    const value = (name: string) => (env[name] ?? refs[name] ?? '').trim()
    const origin = value('READING_WALLABAG_URL')
    const clientId = value('READING_WALLABAG_CLIENT_ID')
    const clientSecret = value('READING_WALLABAG_CLIENT_SECRET')
    const username = value('READING_WALLABAG_USERNAME')
    const password = value('READING_WALLABAG_PASSWORD')
    if ([origin, clientId, clientSecret, username, password].some(item => item === '')) return undefined
    const timeout = Number(value('READING_FETCH_TIMEOUT_MS'))
    return new WallabagAdapter({ origin, clientId, clientSecret, username, password, ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}) })
  }

  async listEntries(options: { page?: number; perPage?: number } = {}): Promise<Article[]> {
    const page = Math.max(1, Math.floor(options.page ?? 1))
    const perPage = Math.min(100, Math.max(1, Math.floor(options.perPage ?? 50)))
    if (page === 1 && this.#entriesCache !== undefined && Date.now() - this.#entriesCache.at < 60_000) return this.#entriesCache.articles
    const all: Record<string, unknown>[] = []
    try {
    let current = page
    for (let count = 0; count < 20; count += 1) {
      const payload = await this.request(`/entries?detail=full&sort=created&order=desc&page=${current}&perPage=${perPage}`)
      const embedded = isRecord(payload) && isRecord(payload._embedded) ? (Array.isArray(payload._embedded.items) ? payload._embedded.items : payload._embedded.entries) : undefined
      const rows = (Array.isArray(embedded) ? embedded : isRecord(payload) && Array.isArray(payload.entries) ? payload.entries : isRecord(payload) && Array.isArray(payload.items) ? payload.items : Array.isArray(payload) ? payload : []).filter(isRecord)
      all.push(...rows)
      const total = isRecord(payload) && typeof payload.total === 'number' ? payload.total : undefined
      if (rows.length === 0 || total === undefined || all.length >= total || rows.length < perPage) break
      current += 1
    }
    const articles = all.map(row => this.toArticle(row))
    if (page === 1) { this.#entriesCache = { articles, at: Date.now() }; void writeRemoteCache('wallabag', this.#config.origin, articles) }
    return articles
    } catch (error) {
      if (page === 1) {
        const cached = await readRemoteCache<Article[]>('wallabag', this.#config.origin)
        if (cached !== undefined) { this.#entriesCache = { articles: cached.value, at: cached.cachedAt }; return cached.value }
      }
      throw error
    }
  }

  async importUrl(url: string): Promise<Article> {
    let parsed: URL
    try { parsed = new URL(url.trim()) } catch { throw new ReadingError('URL is invalid.', 'INVALID_URL', 400) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ReadingError('Only http(s) URLs can be imported.', 'INVALID_URL', 400)
    const created = await this.request('/entries.json', { method: 'POST', body: new URLSearchParams({ url: parsed.toString() }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    const entry = isRecord(created) && isRecord(created.entry) ? created.entry : created
    const id = isRecord(entry) ? String(entry.id ?? '') : ''
    if (id === '') throw new ReadingError('Wallabag returned an invalid entry.', 'WALLABAG_RESPONSE', 502)
    // POST responses can omit extracted content; fetch the canonical entry once.
    const fetched = await this.request(`/entries/${encodeURIComponent(id)}?detail=full`)
    if (!isRecord(fetched)) throw new ReadingError('Wallabag returned an invalid entry.', 'WALLABAG_RESPONSE', 502)
    return this.toArticle(fetched)
  }

  async getEntry(id: string): Promise<Article> {
    if (!/^\d+$/u.test(id) && !/^[-\w]+$/u.test(id)) throw new ReadingError('Entry id is invalid.', 'INVALID_ID', 400)
    const fetched = await this.request(`/entries/${encodeURIComponent(id)}?detail=full`)
    if (!isRecord(fetched)) throw new ReadingError('Wallabag returned an invalid entry.', 'WALLABAG_RESPONSE', 502)
    return this.toArticle(fetched)
  }

  /**
   * Resolve the wallabag entry id for a URL, or `undefined` when the URL is not
   * saved yet (or wallabag cannot be asked). `exists.json` only returns a
   * boolean, so the id is recovered from a search over `url`/`origin_url`.
   */
  async findEntryByUrl(url: string): Promise<string | undefined> {
    let target: URL
    try { target = new URL(url.trim()) } catch { return undefined }
    try {
      const exists = await this.request(`/entries/exists.json?url=${encodeURIComponent(target.toString())}`)
      if (!isRecord(exists) || exists.exists !== true) return undefined
      const search = await this.request(`/search.json?term=${encodeURIComponent(target.toString())}`)
      const items = isRecord(search) && isRecord(search._embedded) && Array.isArray(search._embedded.items) ? search._embedded.items : []
      for (const item of items) {
        if (!isRecord(item)) continue
        const itemUrl = typeof item.url === 'string' ? item.url : ''
        const originUrl = typeof item.origin_url === 'string' ? item.origin_url : typeof item.original_url === 'string' ? item.original_url : ''
        if (itemUrl === target.toString() || originUrl === target.toString()) {
          const id = String(item.id ?? '')
          return id === '' ? undefined : id
        }
      }
      return undefined
    } catch {
      // Missing entry, network trouble, or auth trouble: treat as "not saved".
      return undefined
    }
  }

  /** Patch an entry (content/title/published_at) and invalidate the list cache. */
  async updateEntry(id: string, patch: { content?: string; title?: string; publishedAt?: string }): Promise<void> {
    if (!/^\d+$/u.test(id) && !/^[-\w]+$/u.test(id)) throw new ReadingError('Entry id is invalid.', 'INVALID_ID', 400)
    const fields = new URLSearchParams()
    if (patch.content !== undefined) fields.set('content', patch.content)
    if (patch.title !== undefined) fields.set('title', patch.title)
    if (patch.publishedAt !== undefined) fields.set('published_at', patch.publishedAt)
    if ([...fields.keys()].length === 0) return
    await this.request(`/entries/${encodeURIComponent(id)}.json`, { method: 'PATCH', body: fields, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    this.#entriesCache = undefined
  }

  private async token(): Promise<string> {
    if (this.#bearerToken !== undefined && Date.now() < this.#expiresAt) return this.#bearerToken
    const body = new URLSearchParams({ grant_type: 'password', client_id: this.#config.clientId, client_secret: this.#config.clientSecret, username: this.#config.username, password: this.#config.password })
    let response: Response
    try {
      response = await this.fetchImpl(`${this.#config.origin}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(this.#config.timeoutMs ?? 20_000) })
    } catch {
      throw new ReadingError('Wallabag is unavailable.', 'WALLABAG_UNAVAILABLE', 503)
    }
    if (!response.ok) throw new ReadingError('Wallabag authentication failed.', 'WALLABAG_AUTH', response.status === 401 ? 502 : 503)
    const payload = await response.json() as TokenResponse
    if (typeof payload.access_token !== 'string' || payload.access_token === '') throw new ReadingError('Wallabag authentication returned no token.', 'WALLABAG_AUTH', 502)
    const expires = typeof payload.expires_in === 'number' ? payload.expires_in : 300
    this.#bearerToken = payload.access_token
    this.#expiresAt = Date.now() + Math.max(30, expires - 30) * 1000
    return this.#bearerToken
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.token()
    let response: Response
    try {
      response = await this.fetchImpl(`${this.#config.origin}/api${path}`, { ...init, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(this.#config.timeoutMs ?? 20_000) })
    } catch {
      throw new ReadingError('Wallabag is unavailable.', 'WALLABAG_UNAVAILABLE', 503)
    }
    if (!response.ok) {
      if (response.status === 401) { this.#bearerToken = undefined; this.#expiresAt = 0 }
      throw new ReadingError(`Wallabag request failed (${response.status}).`, 'WALLABAG_REQUEST', response.status === 404 ? 404 : 502)
    }
    if (response.status === 204) return {}
    try { return await response.json() as unknown } catch { throw new ReadingError('Wallabag returned invalid JSON.', 'WALLABAG_RESPONSE', 502) }
  }

  private toArticle(row: Record<string, unknown>): Article {
    const id = String(row.id ?? '')
    if (id === '') throw new ReadingError('Wallabag returned an invalid entry.', 'WALLABAG_RESPONSE', 502)
    const url = typeof row.url === 'string' ? row.url : ''
    const originalUrl = typeof row.origin_url === 'string' ? row.origin_url : typeof row.original_url === 'string' ? row.original_url : url
    const title = typeof row.title === 'string' && row.title !== '' ? row.title : url || `Wallabag entry ${id}`
    const archived = row.is_archived === true || row.is_archived === 1 || row.is_archived === '1'
    const savedAt = typeof row.created_at === 'string' ? row.created_at : new Date().toISOString()
    const readingTime = typeof row.reading_time === 'number' ? row.reading_time : undefined
    const rawHtml = typeof row.content === 'string' ? row.content : typeof row.content_html === 'string' ? row.content_html : undefined
    const html = rawHtml === undefined ? undefined : sanitizeHtml(rawHtml)
    const tags = Array.isArray(row.tags) ? row.tags.map(tag => isRecord(tag) ? tag.label ?? tag.slug : tag).filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '') : undefined
    const publishedAt = typeof row.published_at === 'string' ? row.published_at : undefined
    const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : undefined
    return { id: `wallabag:${id}`, source: 'wallabag', url, originalUrl, title, ...(typeof row.domain_name === 'string' ? { domain: row.domain_name } : {}), ...(tags !== undefined ? { tags } : {}), ...(publishedAt !== undefined ? { publishedAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}), ...(readingTime !== undefined ? { readingTimeMin: readingTime } : {}), isArchived: archived, savedAt, ...(html !== undefined ? { extractedHtml: html } : {}) }
  }
}

/** Read current rc.8 flat credentials and legacy version/refs files for standalone hosts. */

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

/** Marker text wallabag writes into entries whose extraction failed. */
const UNEXTRACTED_MARKERS = ['doc.wallabag.org', "can't retrieve contents"] as const

/** Detect wallabag's "can't retrieve contents" error placeholder (or missing content). */
export function isUnextractedContent(html: string | undefined): boolean {
  if (html === undefined) return true
  if (html.trim() === '') return true
  const lowered = html.toLowerCase()
  return UNEXTRACTED_MARKERS.some(marker => lowered.includes(marker))
}

/** Keep Wallabag article markup inert before it crosses the HTML boundary. */
export function sanitizeHtml(value: string): string {
  return value
    .replace(/<\/?(?:script|style|iframe|object|embed|form)(?:\s[^>]*)?>[\s\S]*?<\/?(?:script|style|iframe|object|embed|form)>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '')
}
