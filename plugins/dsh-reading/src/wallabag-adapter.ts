import type { Article } from './contracts.ts'
import { ReadingError } from './library.ts'

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

  constructor(config: WallabagConfig, private readonly fetchImpl: typeof fetch = fetch) {
    let origin: URL
    try { origin = new URL(config.origin) } catch { throw new ReadingError('Wallabag URL is invalid.', 'WALLABAG_CONFIG', 500) }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') throw new ReadingError('Wallabag URL is invalid.', 'WALLABAG_CONFIG', 500)
    this.#config = { ...config, origin: origin.toString().replace(/\/$/u, '') }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WallabagAdapter | undefined {
    const value = (name: string) => env[name]?.trim() ?? ''
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
    const payload = await this.request(`/entries?detail=full&page=${page}&perPage=${perPage}`)
    const embedded = isRecord(payload) && isRecord(payload._embedded) ? (Array.isArray(payload._embedded.items) ? payload._embedded.items : payload._embedded.entries) : undefined
    const rows = Array.isArray(embedded) ? embedded : isRecord(payload) && Array.isArray(payload.entries) ? payload.entries : isRecord(payload) && Array.isArray(payload.items) ? payload.items : Array.isArray(payload) ? payload : []
    return rows.filter(isRecord).map(row => this.toArticle(row))
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

  private async token(): Promise<string> {
    if (this.#bearerToken !== undefined && Date.now() < this.#expiresAt) return this.#bearerToken
    const body = new URLSearchParams({ grant_type: 'password', client_id: this.#config.clientId, client_secret: this.#config.clientSecret, username: this.#config.username, password: this.#config.password })
    const response = await this.fetchImpl(`${this.#config.origin}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(this.#config.timeoutMs ?? 20_000) })
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
    const response = await this.fetchImpl(`${this.#config.origin}/api${path}`, { ...init, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(this.#config.timeoutMs ?? 20_000) })
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
    const title = typeof row.title === 'string' && row.title !== '' ? row.title : url || `Wallabag entry ${id}`
    const archived = row.is_archived === true || row.is_archived === 1 || row.is_archived === '1'
    const savedAt = typeof row.created_at === 'string' ? row.created_at : new Date().toISOString()
    const readingTime = typeof row.reading_time === 'number' ? row.reading_time : undefined
    const rawHtml = typeof row.content === 'string' ? row.content : typeof row.content_html === 'string' ? row.content_html : undefined
    const html = rawHtml === undefined ? undefined : sanitizeHtml(rawHtml)
    return { id: `wallabag:${id}`, source: 'wallabag', url, title, ...(typeof row.domain_name === 'string' ? { domain: row.domain_name } : {}), ...(readingTime !== undefined ? { readingTimeMin: readingTime } : {}), isArchived: archived, savedAt, ...(html !== undefined ? { extractedHtml: html } : {}) }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

/** Keep Wallabag article markup inert before it crosses the HTML boundary. */
function sanitizeHtml(value: string): string {
  return value
    .replace(/<\/?(?:script|style|iframe|object|embed|form)(?:\s[^>]*)?>[\s\S]*?<\/?(?:script|style|iframe|object|embed|form)>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '')
}
