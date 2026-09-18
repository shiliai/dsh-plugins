import { createServer, type IncomingMessage as IncomingMessageLike, type Server, type ServerResponse as ServerResponseLike } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRange, registerReadingApi } from '../src/http-api.ts'
import { LocalLibrary } from '../src/library.ts'
import { ReadingStateStore } from '../src/state-store.ts'
import { SkillStore } from '@dsh-plugins/dsh-reading-core'
import { WallabagAdapter } from '../src/wallabag-adapter.ts'

let dir: string
let server: Server
let base: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-reading-api-'))
  server = createServer()
  const library = new LocalLibrary(dir)
  const store = await ReadingStateStore.create(dir)
  const fakeWebServer = {
    register(route: { handler: (req: IncomingMessageLike, res: ServerResponseLike) => Promise<void> }) {
      const listener = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
        void route.handler(req as IncomingMessageLike, res as ServerResponseLike)
      }
      server.on('request', listener)
      return () => server.off('request', listener)
    },
  }
  registerReadingApi(fakeWebServer as never, library, store, undefined, undefined, {
    get: () => ({ rootDir: dir, createSessionOnOpen: false }),
    update: async () => undefined,
    skills: () => new SkillStore(dir),
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-reading/api`
})

afterEach(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

describe('reading HTTP API', () => {
  it('rejects malformed byte ranges and cross-origin mutations', async () => {
    expect(parseRange('bytes=1-abc', 16)).toBeNull()
    expect(parseRange('bytes=-1', 0)).toBeNull()

    const response = await fetch(`${base}/import?filename=blocked.epub`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://evil.example' }, body: Buffer.from('blocked'),
    })
    expect(response.status).toBe(403)
  })

  it('imports a book, lists the library, and serves the file', async () => {
    const content = Buffer.from('%PDF-1.4 fake pdf payload for range tests')
    const response = await fetch(`${base}/import?filename=${encodeURIComponent('测试 book.pdf')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: content,
    })
    expect(response.status).toBe(200)
    const { book } = await response.json() as { book: { id: string; format: string; title: string } }
    expect(book.format).toBe('pdf')
    expect(book.title).toBe('测试 book')
    expect('filePath' in book).toBe(false)

    const library = await (await fetch(`${base}/library`)).json() as { books: Array<{ id: string; filePath?: string }> }
    expect(library.books.map(b => b.id)).toContain(book.id)
    expect(library.books[0]).not.toHaveProperty('filePath')

    const detail = await (await fetch(`${base}/book/${encodeURIComponent(book.id)}`)).json() as { book: { filePath?: string } }
    expect(detail.book).not.toHaveProperty('filePath')

    const file = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`)
    expect(file.status).toBe(200)
    expect(file.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(content)
  })

  it('rejects unsupported import formats', async () => {
    const response = await fetch(`${base}/import?filename=book.txt`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('hi'),
    })
    expect(response.status).toBe(415)
  })

  it('serves Range requests with 206 and correct bytes', async () => {
    const content = Buffer.from('0123456789abcdef')
    const { book } = await (await fetch(`${base}/import?filename=r.epub`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: content,
    })).json() as { book: { id: string } }

    const partial = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`, { headers: { Range: 'bytes=4-9' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 4-9/16')
    expect(Buffer.from(await partial.arrayBuffer()).toString()).toBe('456789')

    const suffix = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`, { headers: { Range: 'bytes=-4' } })
    expect(suffix.status).toBe(206)
    expect(Buffer.from(await suffix.arrayBuffer()).toString()).toBe('cdef')

    const openEnded = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`, { headers: { Range: 'bytes=8-' } })
    expect(openEnded.status).toBe(206)
    expect(Buffer.from(await openEnded.arrayBuffer()).toString()).toBe('89abcdef')

    const outOfRange = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`, { headers: { Range: 'bytes=99-100' } })
    expect(outOfRange.status).toBe(416)
  })

  it('reads and writes book metadata sidecars', async () => {
    const { book } = await (await fetch(`${base}/import?filename=meta%20book.pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('%PDF-1.4 fake'),
    })).json() as { book: { id: string; title: string } }
    expect(book.title).toBe('meta book')

    const missing = await fetch(`${base}/book/${encodeURIComponent(book.id)}/metadata`)
    expect(missing.status).toBe(200)
    expect((await missing.json() as { metadata: unknown }).metadata).toBeNull()

    const put = await fetch(`${base}/book/${encodeURIComponent(book.id)}/metadata`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '元数据标题', author: '作者', tags: ['标签甲', '标签乙'], summary: '概要内容' }),
    })
    expect(put.status).toBe(200)
    const { book: updated } = await put.json() as { book: { title: string; author: string; metadata: { tags: string[] } } }
    expect(updated.title).toBe('元数据标题')
    expect(updated.author).toBe('作者')
    expect(updated.metadata.tags).toEqual(['标签甲', '标签乙'])

    const listed = await (await fetch(`${base}/library`)).json() as { books: Array<{ id: string; title: string }> }
    expect(listed.books[0]).toMatchObject({ id: book.id, title: '元数据标题' })

    const got = await (await fetch(`${base}/book/${encodeURIComponent(book.id)}/metadata`)).json() as { metadata: { summary: string } }
    expect(got.metadata.summary).toBe('概要内容')

    const bad = await fetch(`${base}/book/${encodeURIComponent(book.id)}/metadata`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: 'not-an-array' }),
    })
    expect(bad.status).toBe(400)
  })

  it('persists reading progress', async () => {
    const { book } = await (await fetch(`${base}/import?filename=p.epub`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('fake'),
    })).json() as { book: { id: string } }
    const put = await fetch(`${base}/progress/${encodeURIComponent(book.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locator: { type: 'epub', cfi: 'epubcfi(/6/2!/2)', chapterHref: 'a.xhtml' }, percent: 0.77 }),
    })
    expect(put.status).toBe(200)
    const got = await (await fetch(`${base}/progress/${encodeURIComponent(book.id)}`)).json() as { progress: { percent: number } }
    expect(got.progress.percent).toBe(0.77)
    const all = await (await fetch(`${base}/progress`)).json() as { progress: Record<string, unknown> }
    expect(Object.keys(all.progress)).toHaveLength(1)
  })

  it('deletes an annotation with an empty 204 response', async () => {
    const annotation = {
      id: 'annotation-1', bookId: 'book-1',
      locator: { type: 'pdf', page: 1, scrollRatio: 0 },
      quote: 'A quote', color: 'yellow', createdAt: new Date().toISOString(),
    }
    const created = await fetch(`${base}/annotations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(annotation),
    })
    expect(created.status).toBe(200)
    const deleted = await fetch(`${base}/annotations/${annotation.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect(await deleted.text()).toBe('')
  })

  it('provides the same skill CRUD contract as the vault adapter', async () => {
    const input = { name: 'summarize', description: 'Summarize text', modelInvocable: true, userInvocable: true, instructions: 'Summarize clearly.' }
    const created = await fetch(`${base}/skill`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skill: input }) })
    expect(created.status).toBe(200)
    const createdBody = await created.json() as { result: { value: { revision: string } } }
    const listed = await (await fetch(`${base}/skills`)).json() as { result: { skills: Array<{ name: string }> } }
    expect(listed.result.skills.map(skill => skill.name)).toEqual(['summarize'])
    const removed = await fetch(`${base}/skill?name=summarize&expectedRevision=${encodeURIComponent(createdBody.result.value.revision)}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
  })
})

const WALLABAG_ERROR_CONTENT = `wallabag can't retrieve contents for this article. Please <a href="https://doc.wallabag.org/en/user/errors_during_fetching.html#how-can-i-help-to-fix-that">troubleshoot this issue</a>.`

const ZAI_BUNDLE = [
  'function d(e){',
  'let t={a:`a`,blockquote:`blockquote`,code:`code`,h1:`h1`,img:`img`,li:`li`,p:`p`,pre:`pre`,strong:`strong`,ul:`ul`,...e.components};',
  'return(0,u.jsxs)(u.Fragment,{children:[',
  '(0,u.jsx)(t.p,{children:`Locally extracted body.`}),',
  '(0,u.jsx)(t.pre,{children:(0,u.jsx)(t.code,{className:`language-Python`,children:`x < y\\n`})})',
  ']})}',
  'function f(e={}){}',
  '(0,c.createRoot)(document.getElementById(`root`)).render((0,u.jsx)(a,{date:`2026-02-03`,title:`Local Title`,children:(0,u.jsx)(s,{})}));',
].join('\n')

const zaiPageHtml = (slug: string): string => `<!doctype html><html><head>
<meta property="og:title" content="Local Title">
<script type="module" crossorigin src="/blog/assets/${slug}.js"></script>
</head><body><div id="root"></div></body></html>`

interface WallabagEntry extends Record<string, unknown> {
  id: number
  url: string
  title: string
  content: string
  is_archived: number
  created_at: string
}

describe('reading HTTP API with wallabag (open-first flow)', () => {
  let dir: string
  let server: Server
  let base: string
  let entries: Map<number, WallabagEntry>
  let nextId: number
  let patchCalls: Array<{ id: number; fields: URLSearchParams }>
  let httpFetch: typeof fetch

  const findByUrl = (target: string): WallabagEntry | undefined =>
    [...entries.values()].find(entry => entry.url === target || entry.origin_url === target)

  beforeEach(async () => {
    httpFetch = globalThis.fetch
    dir = await mkdtemp(join(tmpdir(), 'dsh-reading-api-w-'))
    server = createServer()
    entries = new Map()
    entries.set(7, { id: 7, url: 'https://z.ai/blog/healthy-post', title: 'Healthy post', content: '<p>Healthy body</p>', is_archived: 0, created_at: 'stub-created-at-7' })
    entries.set(9, { id: 9, url: 'https://z.ai/blog/broken-post', title: 'Broken post', content: WALLABAG_ERROR_CONTENT, is_archived: 0, created_at: 'stub-created-at-9' })
    entries.set(11, { id: 11, url: 'https://z.ai/blog/unextractable-post', title: 'Unextractable post', content: WALLABAG_ERROR_CONTENT, is_archived: 0, created_at: 'stub-created-at-11' })
    nextId = 100
    patchCalls = []

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      const method = init?.method ?? 'GET'
      const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })
      if (url.hostname === 'wallabag.test') {
        if (url.pathname === '/oauth/v2/token') return jsonResponse({ access_token: 'token', expires_in: 3600 })
        if (url.pathname === '/api/entries/exists.json') return jsonResponse({ exists: findByUrl(url.searchParams.get('url') ?? '') !== undefined })
        if (url.pathname === '/api/search.json') {
          const hit = findByUrl(url.searchParams.get('term') ?? '')
          return jsonResponse({ _embedded: { items: hit === undefined ? [] : [hit] } })
        }
        if (url.pathname === '/api/entries.json' && method === 'POST') {
          const target = new URLSearchParams(String(init?.body ?? '')).get('url') ?? ''
          const entry: WallabagEntry = { id: nextId, url: target, title: target, content: WALLABAG_ERROR_CONTENT, is_archived: 0, created_at: 'stub-created-at-new' }
          nextId += 1
          entries.set(entry.id, entry)
          return jsonResponse({ id: entry.id })
        }
        const entryMatch = /\/api\/entries\/(\d+)(\.json)?$/.exec(url.pathname)
        if (entryMatch !== null) {
          const id = Number(entryMatch[1])
          const entry = entries.get(id)
          if (entry === undefined) return new Response('missing', { status: 404 })
          if (method === 'PATCH') {
            const fields = new URLSearchParams(String(init?.body ?? ''))
            patchCalls.push({ id, fields })
            if (fields.has('content')) entry.content = fields.get('content') ?? ''
            if (fields.has('title')) entry.title = fields.get('title') ?? ''
            if (fields.has('published_at')) entry.published_at = fields.get('published_at') ?? ''
          }
          return jsonResponse(entry)
        }
        return new Response('unexpected', { status: 500 })
      }
      // Local z.ai extraction endpoints (page shell + MDX bundle).
      if (url.hostname === 'z.ai') {
        if (url.pathname === '/blog/assets/unextractable-post.js') return new Response('this is not a parseable bundle', { status: 200, headers: { 'Content-Type': 'text/javascript' } })
        if (url.pathname.startsWith('/blog/assets/')) return new Response(ZAI_BUNDLE, { status: 200, headers: { 'Content-Type': 'text/javascript' } })
        const slug = url.pathname.replace(/^\/blog\//u, '').replace(/\/$/u, '')
        return new Response(zaiPageHtml(slug), { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const wallabag = new WallabagAdapter({ origin: 'http://wallabag.test', clientId: 'id-stub', clientSecret: 'cs-stub-value', username: 'account-stub', password: 'pw-stub-value' })
    const fakeWebServer = {
      register(route: { handler: (req: IncomingMessageLike, res: ServerResponseLike) => Promise<void> }) {
        const listener = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
          void route.handler(req as IncomingMessageLike, res as ServerResponseLike)
        }
        server.on('request', listener)
        return () => server.off('request', listener)
      },
    }
    registerReadingApi(fakeWebServer as never, new LocalLibrary(dir), await ReadingStateStore.create(dir), wallabag, undefined, {
      get: () => ({ rootDir: dir, createSessionOnOpen: false }),
      update: async () => undefined,
      skills: () => new SkillStore(dir),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-reading/api`
  })

  afterEach(async () => {
    server.close()
    await rm(dir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  const postJson = async (path: string, body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> => {
    const response = await httpFetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, payload: await response.json() as Record<string, unknown> }
  }

  it('serves a healthy wallabag entry untouched on /articles/open', async () => {
    const { status, payload } = await postJson('/articles/open', { url: 'https://z.ai/blog/healthy-post' })
    expect(status).toBe(200)
    expect(payload.extraction).toBe('wallabag')
    const article = payload.article as { id: string; extractedHtml?: string }
    expect(article.id).toBe('wallabag:7')
    expect(article.extractedHtml).toBe('<p>Healthy body</p>')
    expect(patchCalls).toHaveLength(0)
  })

  it('repairs a broken wallabag entry from the local pipeline on /articles/open', async () => {
    const { status, payload } = await postJson('/articles/open', { url: 'https://z.ai/blog/broken-post' })
    expect(status).toBe(200)
    expect(payload.extraction).toBe('repaired')
    const article = payload.article as { id: string; extractedHtml?: string; publishedAt?: string }
    expect(article.id).toBe('wallabag:9')
    expect(article.extractedHtml).toContain('<p>Locally extracted body.</p>')
    expect(article.extractedHtml).toContain('<pre><code class="language-Python">x &lt; y\n</code></pre>')
    expect(article.publishedAt).toBe('2026-02-03')
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0]?.id).toBe(9)
    expect(patchCalls[0]?.fields.get('title')).toBe('Local Title')
  })

  it('keeps the stored broken entry when local extraction also fails on /articles/open', async () => {
    const { payload } = await postJson('/articles/open', { url: 'https://z.ai/blog/unextractable-post' })
    expect(payload.extraction).toBe('wallabag')
    const article = payload.article as { id: string; extractedHtml?: string }
    expect(article.id).toBe('wallabag:11')
    expect(patchCalls).toHaveLength(0)
  })

  it('opens non-wallabag articles via local extraction on /articles/open', async () => {
    const { status, payload } = await postJson('/articles/open', { url: 'https://z.ai/blog/extractable-post' })
    expect(status).toBe(200)
    expect(payload.extraction).toBe('local')
    const article = payload.article as { id: string; source: string; url: string; originalUrl: string; domain?: string; extractedHtml?: string; isArchived: boolean; publishedAt?: string }
    expect(article.source).toBe('extract')
    expect(article.id).toMatch(/^extract:[0-9a-f]{16}$/u)
    expect(article.url).toBe('https://z.ai/blog/extractable-post')
    expect(article.originalUrl).toBe('https://z.ai/blog/extractable-post')
    expect(article.domain).toBe('z.ai')
    expect(article.isArchived).toBe(false)
    expect(article.publishedAt).toBe('2026-02-03')
    expect(article.extractedHtml).toContain('<p>Locally extracted body.</p>')
    expect(patchCalls).toHaveLength(0)
  })

  it('falls back to wallabag import when local extraction misses on /articles/open', async () => {
    const { status, payload } = await postJson('/articles/open', { url: 'https://example.com/plain-post' })
    expect(status).toBe(200)
    expect(payload.extraction).toBe('imported')
    const article = payload.article as { id: string; source: string; url: string }
    expect(article.source).toBe('wallabag')
    expect(article.url).toBe('https://example.com/plain-post')
    expect(entries.size).toBe(4)
  })

  it('collects a new entry with provided content', async () => {
    const { status, payload } = await postJson('/articles/collect', { url: 'https://example.com/collect-new', title: 'Provided', html: '<p>Provided body</p>' })
    expect(status).toBe(200)
    expect(payload.action).toBe('created')
    const article = payload.article as { id: string; extractedHtml?: string }
    expect(article.extractedHtml).toBe('<p>Provided body</p>')
    expect(patchCalls).toHaveLength(1)
  })

  it('repairs an existing broken entry on collect and reports unchanged for healthy ones', async () => {
    const repaired = await postJson('/articles/collect', { url: 'https://z.ai/blog/broken-post', html: '<p>Fixed body</p>' })
    expect(repaired.payload.action).toBe('repaired')
    const article = repaired.payload.article as { id: string; extractedHtml?: string }
    expect(article.id).toBe('wallabag:9')
    expect(article.extractedHtml).toBe('<p>Fixed body</p>')

    const unchanged = await postJson('/articles/collect', { url: 'https://z.ai/blog/healthy-post', html: '<p>Ignored body</p>' })
    expect(unchanged.payload.action).toBe('unchanged')
    expect((unchanged.payload.article as { extractedHtml?: string }).extractedHtml).toBe('<p>Healthy body</p>')
  })

  it('writes the article project purely from the request body', async () => {
    const { status, payload } = await postJson('/project/article', {
      article: {
        id: 'extract:abcdef0123456789', source: 'extract', url: 'https://z.ai/blog/project-post', title: 'Project post',
        domain: 'z.ai', extractedHtml: '<p>Project body text</p>', isArchived: false, savedAt: 'stub-saved-at',
      },
    })
    expect(status).toBe(200)
    const { path, absolutePath } = payload as { path: string; absolutePath: string }
    expect(absolutePath).toContain('articles')
    const metadata = JSON.parse(await readFile(join(absolutePath, 'metadata.json'), 'utf8')) as Record<string, unknown>
    expect(metadata).toMatchObject({ kind: 'article', id: 'extract:abcdef0123456789', title: 'Project post', source: 'extract', path })
    const articleMd = await readFile(join(absolutePath, 'article.md'), 'utf8')
    expect(articleMd).toContain('# Project post')
    expect(articleMd).toContain('Source: https://z.ai/blog/project-post')
    expect(articleMd).toContain('Project body text')
    await stat(path === '' ? absolutePath : `${dir}/${path}`)
  })

  it('self-heals broken entries served by GET /wallabag/entries/:id', async () => {
    const response = await httpFetch(`${base}/wallabag/entries/9`)
    expect(response.status).toBe(200)
    const { article } = await response.json() as { article: { id: string; extractedHtml?: string } }
    expect(article.extractedHtml).toContain('<p>Locally extracted body.</p>')
    expect(patchCalls.map(call => call.id)).toContain(9)
  })

  it('reports calibre-web as unconfigured when no client is registered', async () => {
    const response = await httpFetch(`${base}/calibre/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: 'local:x' }),
    })
    expect(response.status).toBe(503)
    expect((await response.json() as { code: string }).code).toBe('CALIBRE_UNAVAILABLE')
  })
})

describe('reading HTTP API /calibre/upload', () => {
  it('streams the local file to calibre-web with the requested metadata', async () => {
    const local = await mkdtemp(join(tmpdir(), 'dsh-reading-calibre-api-'))
    const calibreServer = createServer()
    try {
      const calibreLibrary = new LocalLibrary(local)
      const calibreStore = await ReadingStateStore.create(local)
      const uploaded: { fileName?: string; metadata?: unknown } = {}
      const fakeCalibre = {
        uploadBook: vi.fn(async (fileName: string, data: Buffer, metadata?: unknown) => {
          uploaded.fileName = fileName
          uploaded.metadata = metadata
          expect(data.toString()).toBe('%PDF-1.4 calibre upload payload')
          return { calibreBookId: '9', location: '/admin/book/9', warnings: ['calibre-web 账号缺少编辑权限，作者 未写入。'] }
        }),
      }
      const fakeWebServer = {
        register(route: { handler: (req: IncomingMessageLike, res: ServerResponseLike) => Promise<void> }) {
          const listener = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
            void route.handler(req as IncomingMessageLike, res as ServerResponseLike)
          }
          calibreServer.on('request', listener)
          return () => calibreServer.off('request', listener)
        },
      }
      registerReadingApi(fakeWebServer as never, calibreLibrary, calibreStore, undefined, undefined, undefined, fakeCalibre as never)
      await new Promise<void>(resolve => calibreServer.listen(0, '127.0.0.1', resolve))
      const calibreBase = `http://127.0.0.1:${(calibreServer.address() as AddressInfo).port}/dsh-reading/api`

      const { book } = await (await fetch(`${calibreBase}/import?filename=up%20book.pdf`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('%PDF-1.4 calibre upload payload'),
      })).json() as { book: { id: string } }

      const response = await fetch(`${calibreBase}/calibre/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: book.id, title: '上传标题', author: '作者', tags: ['甲'], summary: '概要' }),
      })
      expect(response.status).toBe(200)
      const { result } = await response.json() as { result: { calibreBookId: string; warnings: string[] } }
      expect(result.calibreBookId).toBe('9')
      expect(result.warnings).toHaveLength(1)
      expect(uploaded.fileName).toBe('up book.pdf')
      expect(uploaded.metadata).toMatchObject({ title: '上传标题', author: '作者', tags: ['甲'], summary: '概要' })

      const missing = await fetch(`${calibreBase}/calibre/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: 'local:missing' }),
      })
      expect(missing.status).toBe(404)
    } finally {
      calibreServer.close()
      await rm(local, { recursive: true, force: true })
    }
  })
})
