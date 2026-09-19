import { basename } from 'node:path'
import { readCredentialRefs } from './credentials.ts'
import { ReadingError } from './library.ts'

export interface CalibreWebConfig {
  /** calibre-web base URL, e.g. http://nas:8083 (no trailing /opds). */
  url: string
  username?: string
  password?: string
  timeoutMs?: number
  /** Separate, longer budget for the multipart upload request. */
  uploadTimeoutMs?: number
}

export interface CalibreUploadMetadata {
  title?: string
  author?: string
  tags?: string[]
  summary?: string
}

export interface CalibreUploadResult {
  /** calibre database book id parsed from the post-upload redirect location. */
  calibreBookId: string
  /** Post-upload location path (e.g. /admin/book/5). */
  location: string
  /** Non-fatal problems (e.g. metadata skipped because of missing edit rights). */
  warnings: string[]
}

const USER_AGENT = 'dsh-reading-calibre-web/1.0'

/**
 * Minimal calibre-web web client driving the browser upload flow over HTTP:
 * GET /login → CSRF + session cookie → POST /login → GET /upload → CSRF →
 * POST /upload (multipart, field `btn-upload`) → optional metadata patches via
 * POST /ajax/editbooks/<param>. There is no clean REST API; this mirrors the
 * official web UI (verified against the NAS calibre-web 5.x form markup).
 *
 * Notes:
 * - calibre-web rate-limits POST /login (per-user, ~40/day), so the client
 *   reuses one authenticated session across uploads and only re-logins after
 *   an auth failure.
 * - The ajax metadata edit JSON contract requires calibre-web ≥ 0.6.26; older
 *   servers fall back to the form-encoded variant automatically.
 */
export class CalibreWebClient {
  readonly #config: CalibreWebConfig
  readonly #fetch: typeof fetch
  readonly #cookies = new Map<string, string>()
  #csrfToken: string | undefined
  #authenticated = false
  /** Serializes uploads: concurrent calls must not interleave logins/CSRF. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(config: CalibreWebConfig, fetchImpl: typeof fetch = fetch) {
    let parsed: URL
    try { parsed = new URL(config.url) } catch { throw new ReadingError('calibre-web URL is invalid.', 'CALIBRE_CONFIG', 500) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ReadingError('calibre-web URL is invalid.', 'CALIBRE_CONFIG', 500)
    this.#config = { ...config, url: parsed.toString().replace(/\/+$/u, '') }
    this.#fetch = fetchImpl
  }

  get origin(): string { return this.#config.url }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): CalibreWebClient | undefined {
    const refs = readCredentialRefs(env)
    let url = (env.READING_CALIBRE_WEB_URL ?? '').trim()
    if (url === '') url = deriveUrlFromOpds((env.READING_OPDS_0_URL ?? '').trim())
    if (url === '') return undefined
    const timeout = Number(env.READING_FETCH_TIMEOUT_MS)
    const username = (env.READING_CALIBRE_WEB_USERNAME ?? env.READING_OPDS_0_USERNAME ?? '').trim()
    const password = (env.READING_CALIBRE_WEB_PASSWORD ?? refs.READING_CALIBRE_WEB_PASSWORD ?? env.READING_OPDS_0_PASSWORD ?? refs.READING_OPDS_0_PASSWORD ?? '').trim()
    return new CalibreWebClient({
      url,
      ...(username === '' ? {} : { username }),
      ...(password === '' ? {} : { password }),
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    })
  }

  /**
   * Log in and keep the session cookie. Skipped when a session from a
   * previous upload is still believed valid — calibre-web rate-limits the
   * login endpoint, and re-sending the password per upload is unnecessary.
   */
  async login(): Promise<void> {
    if (this.#authenticated) return
    const page = await this.#getText('/login', undefined, true)
    const csrf = extractCsrf(page)
    if (csrf === undefined) throw new ReadingError('calibre-web 登录页缺少 csrf_token。', 'CALIBRE_RESPONSE', 502)
    const body = new URLSearchParams({ next: '/', csrf_token: csrf, username: this.#config.username ?? '', password: this.#config.password ?? '', submit: 'Login' })
    const response = await this.#request('/login?next=/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    // endsWith covers reverse-proxy subpath mounts (e.g. /calibre/login).
    if (response.status !== 200 || new URL(response.url).pathname.endsWith('/login')) {
      throw new ReadingError('calibre-web 登录失败，请检查 READING_CALIBRE_WEB_* 凭据。', 'CALIBRE_AUTH', 502)
    }
    await response.body?.cancel()
    this.#authenticated = true
  }

  /** Upload one book file; applies metadata afterwards when provided. Serialized per client. */
  uploadBook(fileName: string, data: Buffer, metadata?: CalibreUploadMetadata): Promise<CalibreUploadResult> {
    const run = this.#queue.then(() => this.#uploadWithAuthRetry(fileName, data, metadata), () => this.#uploadWithAuthRetry(fileName, data, metadata))
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * A cached session can expire server-side mid-flight (the upload then
   * bounces through /login and fails with an auth-flavoured error). Retry
   * once with a fresh login in that case.
   */
  async #uploadWithAuthRetry(fileName: string, data: Buffer, metadata?: CalibreUploadMetadata): Promise<CalibreUploadResult> {
    try {
      return await this.#uploadOnce(fileName, data, metadata)
    } catch (error) {
      const code = error instanceof ReadingError ? error.code : ''
      const retryable = code === 'CALIBRE_AUTH' || code === 'CALIBRE_FORBIDDEN'
      if (!retryable || !this.#authenticated) throw error
      this.#resetAuth()
      return this.#uploadOnce(fileName, data, metadata)
    }
  }

  #resetAuth(): void {
    this.#authenticated = false
    this.#csrfToken = undefined
    this.#cookies.clear()
  }

  /**
   * Fetch the upload form page and its csrf token. Some calibre-web builds
   * register /upload as POST-only, so the GET probe fails with 405 even for
   * accounts holding the upload permission; fall back to the home page in
   * that case — its navbar renders a csrf_token only when the session is
   * allowed to upload, so a missing token there still signals 403.
   */
  async #getUploadPage(): Promise<string> {
    const forbidden = 'calibre-web 账号缺少上传权限（Upload），请在管理后台为该账号勾选上传权限。'
    try {
      return await this.#getText('/upload', forbidden)
    } catch (error) {
      if (!(error instanceof ReadingError) || error.status !== 405) throw error
      const home = await this.#getText('/')
      if (extractCsrf(home) === undefined) throw new ReadingError(forbidden, 'CALIBRE_FORBIDDEN', 403)
      return home
    }
  }

  async #uploadOnce(fileName: string, data: Buffer, metadata?: CalibreUploadMetadata): Promise<CalibreUploadResult> {
    await this.login()
    const page = await this.#getUploadPage()
    const csrf = extractCsrf(page)
    if (csrf === undefined) throw new ReadingError('calibre-web 上传页缺少 csrf_token。', 'CALIBRE_RESPONSE', 502)
    this.#csrfToken = csrf

    const boundary = `----dshReading${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const payload = buildMultipart(boundary, csrf, sanitizeUploadFileName(fileName), data)
    const response = await this.#request('/upload', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
      timeoutMs: this.#config.uploadTimeoutMs ?? 300_000,
    })
    if (new URL(response.url).pathname.endsWith('/login')) {
      throw new ReadingError('calibre-web 会话已过期，需要重新登录。', 'CALIBRE_AUTH', 502)
    }
    const raw = await response.text()
    if (response.status === 403) throw new ReadingError('calibre-web 账号缺少上传权限（Upload）。', 'CALIBRE_FORBIDDEN', 403)
    if (!response.ok) throw new ReadingError(`calibre-web 上传失败（HTTP ${response.status}）。`, 'CALIBRE_REQUEST', 502)
    let location: string | undefined
    try {
      const parsed = JSON.parse(raw) as { location?: unknown }
      location = typeof parsed.location === 'string' ? parsed.location : undefined
    } catch { /* fall through */ }
    if (location === undefined || location === '') {
      throw new ReadingError('calibre-web 上传响应异常（缺少 location）。', 'CALIBRE_RESPONSE', 502)
    }
    const idMatch = /\/(?:admin\/)?book\/(\d+)/u.exec(location)
    const calibreBookId = idMatch?.[1] ?? ''
    const warnings: string[] = []
    if (calibreBookId === '') warnings.push('无法解析新书籍 id，元数据未写入。')

    if (metadata !== undefined && calibreBookId !== '') {
      warnings.push(...await this.editBookMetadata(calibreBookId, metadata))
    }
    return { calibreBookId, location, warnings }
  }

  /**
   * Patch metadata through the ajax edit endpoints (one call per field).
   * Requires the calibre-web account to have edit rights; missing rights are
   * reported as warnings so the upload itself still succeeds.
   */
  async editBookMetadata(bookId: string, metadata: CalibreUploadMetadata): Promise<string[]> {
    const csrf = this.#csrfToken
    if (csrf === undefined) {
      const page = await this.#getUploadPage()
      const parsed = extractCsrf(page)
      if (parsed === undefined) throw new ReadingError('calibre-web 上传页缺少 csrf_token。', 'CALIBRE_RESPONSE', 502)
      this.#csrfToken = parsed
    }
    const fields: Array<[param: string, label: string, value: string | undefined]> = [
      ['title', '书名', metadata.title?.trim() || undefined],
      ['authors', '作者', metadata.author?.trim() || undefined],
      ['tags', '标签', metadata.tags !== undefined ? metadata.tags.filter(tag => tag.trim() !== '').join(',') : undefined],
      ['comments', '概要', metadata.summary?.trim() || undefined],
    ]
    const warnings: string[] = []
    for (const [param, label, value] of fields) {
      if (value === undefined) continue
      const response = await this.#request(`/ajax/editbooks/${param}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': this.#csrfToken ?? '' },
        body: JSON.stringify({ pk: [Number(bookId)], value }),
      })
      if (response.status === 403) {
        warnings.push(`calibre-web 账号缺少编辑权限，${label} 未写入。`)
        continue
      }
      let raw = await response.text()
      if (response.status >= 500 || !tryParseEditResult(raw)) {
        // calibre-web ≤ 0.6.25 expects form encoding with a scalar pk; retry once that way.
        const fallback = new URLSearchParams({ csrf_token: this.#csrfToken ?? '', pk: bookId, value })
        const retry = await this.#request(`/ajax/editbooks/${param}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': this.#csrfToken ?? '' },
          body: fallback.toString(),
        })
        raw = await retry.text()
        if (retry.status === 403) {
          warnings.push(`calibre-web 账号缺少编辑权限，${label} 未写入。`)
          continue
        }
      }
      const verdict = parseEditResult(raw)
      if (verdict.ok !== true) warnings.push(`calibre-web ${label} 写入失败${verdict.message !== undefined ? `：${verdict.message}` : ''}。`)
    }
    return warnings
  }

  async #getText(path: string, forbiddenMessage?: string, allowLoginPage = false): Promise<string> {
    const response = await this.#request(path)
    // An expired cached session bounces any page through /login; surface that
    // as an auth failure so the upload retry path re-logins.
    if (!allowLoginPage && new URL(response.url).pathname.endsWith('/login')) {
      throw new ReadingError('calibre-web 会话已过期，需要重新登录。', 'CALIBRE_AUTH', 502)
    }
    if (response.status === 403 || response.status === 405) {
      // Keep the original status: 405 means the route is method-restricted
      // (e.g. POST-only /upload), not a permission failure.
      throw new ReadingError(forbiddenMessage ?? 'calibre-web 拒绝访问（账号权限不足）。', 'CALIBRE_FORBIDDEN', response.status)
    }
    if (!response.ok) throw new ReadingError(`calibre-web 请求失败（HTTP ${response.status}）。`, 'CALIBRE_REQUEST', 502)
    return response.text()
  }

  /**
   * Fetch with explicit redirect handling: the session cookie rotates across
   * login redirects (302 → GET /), and fetch only exposes the final response's
   * set-cookie headers, which would drop the authenticated session. Following
   * redirects manually lets the jar capture every hop.
   */
  async #request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number } = {}): Promise<Response> {
    let url = `${this.#config.url}${path}`
    let method = init.method ?? 'GET'
    let body = init.body as BodyInit | undefined
    for (let hop = 0; hop < 6; hop++) {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        ...(this.#cookies.size > 0 ? { Cookie: [...this.#cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...init.headers,
      }
      let response: Response
      try {
        response = await this.#fetch(url, {
          method,
          // Typed-array body types vary across DOM/undici typings; BodyInit keeps the exact bytes.
          ...(body === undefined ? {} : { body }),
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(init.timeoutMs ?? this.#config.timeoutMs ?? 60_000),
        })
      } catch (error) {
        if (error instanceof ReadingError) throw error
        throw new ReadingError('calibre-web 不可达。', 'CALIBRE_UNAVAILABLE', 503)
      }
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0] ?? ''
        const index = pair.indexOf('=')
        if (index > 0) this.#cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
      }
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel().catch(() => {})
        const next = new URL(location, url)
        // Never follow a redirect off the configured origin: the session
        // cookie (and on 307/308 the request body) must not leak cross-origin.
        if (next.origin !== new URL(this.#config.url).origin) {
          throw new ReadingError('calibre-web 重定向到非本站地址，已中止。', 'CALIBRE_RESPONSE', 502)
        }
        // 301/302/303 rewrite POST to GET; the body must not ride along.
        if (method !== 'GET' && (response.status === 301 || response.status === 302 || response.status === 303)) {
          method = 'GET'
          body = undefined
          if (init.headers !== undefined) delete init.headers['Content-Type']
        }
        url = next.toString()
        continue
      }
      try {
        if (response.url !== url) Object.defineProperty(response, 'url', { value: url, configurable: true })
      } catch {
        // Test doubles may pin url as non-configurable; the status checks still hold.
      }
      return response
    }
    throw new ReadingError('calibre-web 重定向次数过多。', 'CALIBRE_RESPONSE', 502)
  }
}

/** Strip `/opds` (and trailing slashes) from the OPDS base to get the web origin. */
export function deriveUrlFromOpds(opdsUrl: string): string {
  if (opdsUrl === '') return ''
  try {
    const parsed = new URL(opdsUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    const path = parsed.pathname.replace(/\/+$/u, '')
    parsed.pathname = path.endsWith('/opds') ? path.slice(0, -'/opds'.length) || '/' : path || '/'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/u, '')
  } catch {
    return ''
  }
}

function extractCsrf(html: string): string | undefined {
  const match = /name="csrf_token"[^>]*value="([^"]+)"/u.exec(html) ?? /value="([^"]+)"[^>]*name="csrf_token"/u.exec(html)
  return match?.[1]
}

/** True when the body parses as an ajax edit result object. */
function tryParseEditResult(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { success?: unknown }
    return typeof parsed === 'object' && parsed !== null && 'success' in parsed
  } catch {
    return false
  }
}

function parseEditResult(raw: string): { ok: boolean; message?: string } {
  try {
    const parsed = JSON.parse(raw) as { success?: unknown; msg?: unknown }
    return { ok: parsed.success === true, ...(typeof parsed.msg === 'string' ? { message: parsed.msg } : {}) }
  } catch {
    return { ok: false }
  }
}

function sanitizeUploadFileName(fileName: string): string {
  const base = basename(fileName).replaceAll(/["\\\r\n]/gu, '_').trim()
  return base === '' ? 'book.bin' : base
}

/** Build the multipart body calibre-web expects: csrf_token + one `btn-upload` file part. */
export function buildMultipart(boundary: string, csrfToken: string, fileName: string, data: Buffer): Buffer {
  const head = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="csrf_token"',
    '',
    csrfToken,
    `--${boundary}`,
    `Content-Disposition: form-data; name="btn-upload"; filename="${fileName}"`,
    'Content-Type: application/octet-stream',
    '',
    '',
  ].join('\r\n'))
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return Buffer.concat([head, data, tail])
}

