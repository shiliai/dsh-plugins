import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMultipart, CalibreWebClient, deriveUrlFromOpds } from '../src/calibre-web.ts'

function loginPage(csrf: string): string {
  return `<html><body><form method="POST"><input type="hidden" name="csrf_token" value="${csrf}"><input name="username"><input name="password" type="password"></form></body></html>`
}

/** Home page whose navbar carries the csrf token (upload-capable sessions only). */
function homePage(csrf?: string): string {
  return `<html><body><nav>${csrf === undefined ? '' : `<input type="hidden" name="csrf_token" value="${csrf}">`}</nav></body></html>`
}

/** Response whose final URL differs from the request URL (redirect following). */
function respond(body: string, init: ResponseInit & { url?: string } = {}): Response {
  const { url, ...rest } = init
  const response = new Response(body, rest)
  if (url !== undefined) Object.defineProperty(response, 'url', { value: url })
  return response
}

describe('deriveUrlFromOpds', () => {
  it('strips the /opds suffix and trailing slashes', () => {
    expect(deriveUrlFromOpds('http://192.168.88.22:9083/opds')).toBe('http://192.168.88.22:9083')
    expect(deriveUrlFromOpds('http://nas:8083/opds/')).toBe('http://nas:8083')
    expect(deriveUrlFromOpds('https://books.example.com')).toBe('https://books.example.com')
  })

  it('rejects non-http schemes and garbage', () => {
    expect(deriveUrlFromOpds('file:///opds')).toBe('')
    expect(deriveUrlFromOpds('not a url')).toBe('')
    expect(deriveUrlFromOpds('')).toBe('')
  })
})

describe('CalibreWebClient.fromEnv', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })

  it('prefers READING_CALIBRE_WEB_URL and falls back to the OPDS origin', () => {
    process.env.READING_CALIBRE_WEB_URL = 'http://calibre.example.com'
    delete process.env.READING_OPDS_0_URL
    expect(CalibreWebClient.fromEnv()?.origin).toBe('http://calibre.example.com')
    delete process.env.READING_CALIBRE_WEB_URL
    process.env.READING_OPDS_0_URL = 'http://192.168.88.22:9083/opds'
    expect(CalibreWebClient.fromEnv()?.origin).toBe('http://192.168.88.22:9083')
    delete process.env.READING_OPDS_0_URL
    expect(CalibreWebClient.fromEnv()).toBeUndefined()
  })
})

describe('CalibreWebClient.uploadBook', () => {
  const config = { url: 'http://calibre.local', username: 'dshreading', password: 'secret' }

  it('logs in, uploads multipart, and patches metadata via ajax endpoints', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      calls.push(init === undefined ? { url } : { url, init })
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') {
        return respond(loginPage('login-csrf'), { headers: { 'set-cookie': 'session=abc123; Path=/; HttpOnly' } })
      }
      if (url.includes('/login') && init?.method === 'POST') {
        return respond('<html>home</html>', { url: 'http://calibre.local/' })
      }
      if (url.endsWith('/upload') && (init?.method ?? 'GET') === 'GET') {
        return respond(loginPage('upload-csrf'))
      }
      if (url.endsWith('/upload') && init?.method === 'POST') {
        return respond(JSON.stringify({ location: '/admin/book/42' }))
      }
      if (url.includes('/ajax/editbooks/')) {
        return respond(JSON.stringify({ success: true }))
      }
      return respond('unexpected', { status: 500 })
    })

    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    const result = await client.uploadBook('我的 书.pdf', Buffer.from('%PDF-fake'), { title: '我的书', author: '作者', tags: ['甲', '乙'], summary: '概要内容' })

    expect(result).toMatchObject({ calibreBookId: '42', location: '/admin/book/42', warnings: [] })

    const loginGet = calls.find(call => call.url.endsWith('/login') && (call.init?.method ?? 'GET') === 'GET')
    expect(loginGet).toBeDefined()
    const loginPost = calls.find(call => call.url.includes('/login') && call.init?.method === 'POST')
    expect(String(loginPost?.init?.body)).toContain('csrf_token=login-csrf')
    expect(String(loginPost?.init?.body)).toContain('username=dshreading')
    expect(loginPost?.init?.headers).toMatchObject({ Cookie: 'session=abc123' })

    const uploadPost = calls.find(call => call.url.endsWith('/upload') && call.init?.method === 'POST')
    const contentType = (uploadPost?.init?.headers as Record<string, string> | undefined)?.['Content-Type'] ?? ''
    expect(contentType).toContain('multipart/form-data; boundary=')
    const multipart = Buffer.from(uploadPost?.init?.body as ArrayBufferLike).toString('utf8')
    expect(multipart).toContain('name="csrf_token"')
    expect(multipart).toContain('upload-csrf')
    expect(multipart).toContain('name="btn-upload"; filename="我的 书.pdf"')
    expect(multipart).toContain('%PDF-fake')

    const ajaxParams = calls.filter(call => call.url.includes('/ajax/editbooks/')).map(call => call.url.split('/').pop())
    expect(ajaxParams).toEqual(['title', 'authors', 'tags', 'comments'])
    const titleCall = calls.find(call => call.url.endsWith('/ajax/editbooks/title'))
    expect(titleCall?.init?.headers).toMatchObject({ 'X-CSRFToken': 'upload-csrf' })
    expect(String(titleCall?.init?.body)).toBe(JSON.stringify({ pk: [42], value: '我的书' }))
  })

  it('follows login redirects and keeps the rotated session cookie', async () => {
    const requests: Array<{ url: string; cookie?: string | undefined }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie
      requests.push({ url, cookie })
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') {
        return respond(loginPage('csrf-rot'), { headers: { 'set-cookie': 'session=anonymous; Path=/; HttpOnly' } })
      }
      if (url.includes('/login') && init?.method === 'POST') {
        // Successful logins rotate the session cookie on the 302 hop; a fetch
        // that only surfaces final-response headers would lose it.
        return respond('', { status: 302, headers: { location: '/', 'set-cookie': 'session=authenticated; Path=/; HttpOnly' } })
      }
      if (new URL(url).pathname === '/') return respond('<html>home</html>')
      return respond('unexpected', { status: 500 })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    await client.login()
    const homeGet = requests.find(request => new URL(request.url).pathname === '/')
    expect(homeGet?.cookie).toContain('session=authenticated')
  })

  it('reuses the authenticated session across uploads instead of re-logging in', async () => {
    const loginPosts: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('csrf-1'))
      if (url.includes('/login') && init?.method === 'POST') { loginPosts.push(url); return respond('home', { url: 'http://calibre.local/' }) }
      if (url.endsWith('/upload') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('csrf-u'))
      if (url.endsWith('/upload') && init?.method === 'POST') return respond(JSON.stringify({ location: '/book/1' }))
      return respond('unexpected', { status: 500 })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    await client.uploadBook('a.pdf', Buffer.from('x'))
    await client.uploadBook('b.pdf', Buffer.from('y'))
    expect(loginPosts).toHaveLength(1)
  })

  it('aborts redirects that leave the configured origin', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      return respond('', { status: 302, headers: { location: 'http://evil.example/steal' } })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    await expect(client.login()).rejects.toMatchObject({ code: 'CALIBRE_RESPONSE' })
  })

  it('caps redirect following at six hops', async () => {
    let hops = 0
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      hops++
      // Every hop (including the login POST) redirects to itself forever.
      return respond('', { status: 302, headers: { location: String(input) } })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    await expect(client.login()).rejects.toMatchObject({ code: 'CALIBRE_RESPONSE', status: 502 })
    expect(hops).toBeLessThanOrEqual(6)
  })

  it('falls back to form-encoded ajax edits on old calibre-web servers', async () => {
    const bodies: Array<{ url: string; body?: string | undefined; contentType?: string | undefined }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const contentType = (init?.headers as Record<string, string> | undefined)?.['Content-Type']
      bodies.push({ url, body: typeof init?.body === 'string' ? init.body : undefined, contentType })
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('csrf-old'))
      if (url.includes('/login') && init?.method === 'POST') return respond('home', { url: 'http://calibre.local/' })
      if (url.endsWith('/upload') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('csrf-old'))
      if (url.endsWith('/upload') && init?.method === 'POST') return respond(JSON.stringify({ location: '/book/3' }))
      if (url.endsWith('/ajax/editbooks/title') && contentType === 'application/json') {
        // calibre-web ≤ 0.6.25 answers the JSON contract with a 500.
        return respond('<h1>Internal Server Error</h1>', { status: 500 })
      }
      if (url.endsWith('/ajax/editbooks/title')) return respond(JSON.stringify({ success: true }))
      return respond(JSON.stringify({ success: true }))
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    const result = await client.uploadBook('a.pdf', Buffer.from('x'), { title: '旧版兼容' })
    expect(result.warnings).toEqual([])
    const titleCalls = bodies.filter(call => call.url.endsWith('/ajax/editbooks/title'))
    expect(titleCalls).toHaveLength(2)
    expect(titleCalls[1]?.contentType).toBe('application/x-www-form-urlencoded')
    expect(titleCalls[1]?.body).toContain('pk=3')
  })

  it('re-logins once when the cached session expires mid-upload', async () => {
    let authenticated = false
    let loginPosts = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/login') && method === 'GET') {
        authenticated = false
        return respond(loginPage('csrf-exp'))
      }
      if (url.includes('/login') && method === 'POST') { loginPosts += 1; authenticated = true; return respond('home', { url: 'http://calibre.local/' }) }
      if (url.endsWith('/upload') && method === 'GET') {
        // Expired sessions are bounced through /login before the upload page.
        if (!authenticated) return respond('', { status: 302, headers: { location: '/login?next=%2Fupload' } })
        return respond(loginPage('csrf-exp'))
      }
      if (url.endsWith('/upload') && method === 'POST') {
        // Stock calibre-web expiry: anonymous POSTs bounce through /login.
        if (!authenticated) return respond('', { status: 302, headers: { location: '/login?next=%2Fupload' } })
        return respond(JSON.stringify({ location: '/book/5' }))
      }
      return respond('unexpected', { status: 500 })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    await client.uploadBook('a.pdf', Buffer.from('x'))
    // Simulate server-side session expiry: the cached cookie no longer counts.
    authenticated = false
    const second = await client.uploadBook('b.pdf', Buffer.from('y'))
    expect(second.calibreBookId).toBe('5')
    expect(loginPosts).toBe(2)
  })

  it('surfaces missing upload permission as a clear error', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('login-csrf'))
      if (url.includes('/login') && init?.method === 'POST') return respond('home', { url: 'http://calibre.local/' })
      if (url.endsWith('/upload')) return respond('forbidden', { status: 403 })
      return respond('unexpected', { status: 500 })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    await expect(client.uploadBook('a.pdf', Buffer.from('pdf'))).rejects.toMatchObject({ code: 'CALIBRE_FORBIDDEN', status: 403 })
  })

  it('falls back to the home page csrf when /upload is a POST-only route', async () => {
    // Some calibre-web builds answer GET /upload with 405 even for accounts
    // holding the upload permission; the live NAS server behaves this way.
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      calls.push(init === undefined ? { url } : { url, init })
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('login-csrf'))
      if (url.includes('/login') && init?.method === 'POST') return respond('', { status: 302, headers: { location: '/' }, url: 'http://calibre.local/' })
      if (url.endsWith('/upload') && (init?.method ?? 'GET') === 'GET') return respond('method not allowed', { status: 405 })
      if (new URL(url).pathname === '/') return respond(homePage('home-csrf'))
      if (url.endsWith('/upload') && init?.method === 'POST') return respond(JSON.stringify({ location: '/book/9' }))
      if (url.includes('/ajax/editbooks/')) return respond(JSON.stringify({ success: true }))
      return respond('unexpected', { status: 500 })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    const result = await client.uploadBook('a.pdf', Buffer.from('pdf'), { title: 'T' })
    expect(result).toMatchObject({ calibreBookId: '9', warnings: [] })
    const uploadPost = calls.find(call => call.url.endsWith('/upload') && call.init?.method === 'POST')
    const multipart = Buffer.from(uploadPost?.init?.body as ArrayBufferLike).toString('utf8')
    expect(multipart).toContain('home-csrf')
    expect(calls.some(call => call.url.endsWith('/ajax/editbooks/title'))).toBe(true)
  })

  it('reports 403 when a POST-only /upload serves a csrf-free home page', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('login-csrf'))
      if (url.includes('/login') && init?.method === 'POST') return respond('home', { url: 'http://calibre.local/' })
      if (url.endsWith('/upload') && (init?.method ?? 'GET') === 'GET') return respond('method not allowed', { status: 405 })
      if (new URL(url).pathname === '/') return respond(homePage())
      return respond('unexpected', { status: 500 })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    await expect(client.uploadBook('a.pdf', Buffer.from('pdf'))).rejects.toMatchObject({ code: 'CALIBRE_FORBIDDEN', status: 403 })
  })

  it('fails loudly when login is rejected', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('login-csrf'))
      return respond(loginPage('login-csrf'), { url })
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    await expect(client.uploadBook('a.pdf', Buffer.from('pdf'))).rejects.toMatchObject({ code: 'CALIBRE_AUTH' })
  })

  it('reports metadata write failures as warnings without failing the upload', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/login') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('csrf-x'))
      if (url.includes('/login') && init?.method === 'POST') return respond('home', { url: 'http://calibre.local/' })
      if (url.endsWith('/upload') && (init?.method ?? 'GET') === 'GET') return respond(loginPage('csrf-x'))
      if (url.endsWith('/upload') && init?.method === 'POST') return respond(JSON.stringify({ location: '/book/7' }))
      if (url.endsWith('/ajax/editbooks/comments')) return respond(JSON.stringify({ success: false, msg: 'broken' }), { status: 200 })
      return respond(JSON.stringify({ success: true }))
    })
    const client = new CalibreWebClient(config, fetchMock as unknown as typeof fetch)
    const result = await client.uploadBook('a.pdf', Buffer.from('pdf'), { summary: 's' })
    expect(result.calibreBookId).toBe('7')
    expect(result.warnings.join('')).toContain('broken')
  })
})

describe('buildMultipart', () => {
  it('embeds the csrf field and the btn-upload file part', () => {
    const body = buildMultipart('BOUNDARY', 'token-1', 'book.pdf', Buffer.from('DATA')).toString('utf8')
    expect(body).toBe(
      '--BOUNDARY\r\nContent-Disposition: form-data; name="csrf_token"\r\n\r\ntoken-1\r\n'
      + '--BOUNDARY\r\nContent-Disposition: form-data; name="btn-upload"; filename="book.pdf"\r\n'
      + 'Content-Type: application/octet-stream\r\n\r\nDATA\r\n--BOUNDARY--\r\n',
    )
  })
})
