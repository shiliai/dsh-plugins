import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WallabagAdapter, isUnextractedContent } from '../src/wallabag-adapter.ts'

function makeAdapter(fetchMock: ReturnType<typeof vi.fn>): WallabagAdapter {
  return new WallabagAdapter({ origin: 'http://wallabag.local', clientId: 'client', clientSecret: 'secret', username: 'user', password: 'pass' }, fetchMock as unknown as typeof fetch)
}

// The adapter mirrors successful entry lists into $DSH_HOME/cache/dsh-reading;
// point that at a temp dir so tests never touch the real DSH home.
let cacheHome: string
beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), 'dsh-reading-cache-'))
  process.env.DSH_HOME = cacheHome
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(cacheHome, { recursive: true, force: true })
})

describe('WallabagAdapter', () => {
  it('authenticates, lists entries, and imports a URL using form encoding', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(init === undefined ? { url: String(url) } : { url: String(url), init })
      if (String(url).endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
      if (String(url).includes('/entries.json') && init?.method === 'POST') return new Response(JSON.stringify({ id: 7 }), { status: 200 })
      if (String(url).includes('/entries/7?')) return new Response(JSON.stringify({ id: 7, url: 'https://example.com/a', origin_url: 'https://origin.example/a', title: 'An article', tags: [{ label: 'tech' }], content: '<p>Read me</p>', is_archived: 0, created_at: '2026-01-01T00:00:00+00:00', published_at: '2025-12-01T00:00:00+00:00' }), { status: 200 })
      return new Response(JSON.stringify({ _embedded: { items: [{ id: 8, url: 'https://example.com/b', title: 'B', is_archived: 1 }] } }), { status: 200 })
    })
    const adapter = new WallabagAdapter({ origin: 'http://wallabag.local', clientId: 'client', clientSecret: 'secret', username: 'user', password: 'pass' }, fetchMock as typeof fetch)
    const list = await adapter.listEntries()
    expect(list[0]).toMatchObject({ id: 'wallabag:8', title: 'B', isArchived: true })
    const article = await adapter.importUrl('https://example.com/a')
    expect(article.extractedHtml).toBe('<p>Read me</p>')
    expect(article).toMatchObject({ originalUrl: 'https://origin.example/a', tags: ['tech'], publishedAt: '2025-12-01T00:00:00+00:00' })
    const post = calls.find(call => call.init?.method === 'POST' && call.url.includes('/entries.json'))
    expect(post?.init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(String(post?.init?.body)).toContain('url=https%3A%2F%2Fexample.com%2Fa')
    expect(calls.filter(call => call.url.endsWith('/oauth/v2/token'))).toHaveLength(1)
  })

  it('rejects non-http URLs', async () => {
    const adapter = new WallabagAdapter({ origin: 'http://wallabag.local', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' }, vi.fn() as typeof fetch)
    await expect(adapter.importUrl('javascript:alert(1)')).rejects.toMatchObject({ code: 'INVALID_URL', status: 400 })
  })

  describe('findEntryByUrl', () => {
    const target = 'https://example.com/a'

    it('resolves the entry id via exists + search matching url', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
        if (requestUrl.includes('/entries/exists.json')) return new Response(JSON.stringify({ exists: true }), { status: 200 })
        if (requestUrl.includes('/search.json')) return new Response(JSON.stringify({ _embedded: { items: [{ id: 7, url: 'https://example.com/other' }, { id: 42, url: 'https://example.com/a' }] } }), { status: 200 })
        return new Response('unexpected', { status: 500 })
      })
      const adapter = makeAdapter(fetchMock)
      await expect(adapter.findEntryByUrl(target)).resolves.toBe('42')
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes(`/entries/exists.json?url=${encodeURIComponent(target)}`))).toBe(true)
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes(`/search.json?term=${encodeURIComponent(target)}`))).toBe(true)
    })

    it('matches origin_url when wallabag rewrote the stored url', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
        if (requestUrl.includes('/entries/exists.json')) return new Response(JSON.stringify({ exists: true }), { status: 200 })
        const term = new URL(requestUrl).searchParams.get('term') ?? ''
        if (requestUrl.includes('/search.json')) return new Response(JSON.stringify({ _embedded: { items: [{ id: 9, url: 'https://wallabag.local/entry/9', origin_url: term }] } }), { status: 200 })
        return new Response('unexpected', { status: 500 })
      })
      const adapter = makeAdapter(fetchMock)
      await expect(adapter.findEntryByUrl('https://example.com/rewritten')).resolves.toBe('9')
    })

    it('returns undefined without searching when the url is not saved', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
        if (requestUrl.includes('/entries/exists.json')) return new Response(JSON.stringify({ exists: false }), { status: 200 })
        return new Response('unexpected', { status: 500 })
      })
      const adapter = makeAdapter(fetchMock)
      await expect(adapter.findEntryByUrl(target)).resolves.toBeUndefined()
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/search.json'))).toBe(false)
    })

    it('returns undefined when the search has no exact url match', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
        if (requestUrl.includes('/entries/exists.json')) return new Response(JSON.stringify({ exists: true }), { status: 200 })
        if (requestUrl.includes('/search.json')) return new Response(JSON.stringify({ _embedded: { items: [{ id: 3, url: 'https://example.com/similar' }] } }), { status: 200 })
        return new Response('unexpected', { status: 500 })
      })
      const adapter = makeAdapter(fetchMock)
      await expect(adapter.findEntryByUrl(target)).resolves.toBeUndefined()
    })

    it('returns undefined when exists or search requests fail', async () => {
      const failing = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
        return new Response('boom', { status: 500 })
      })
      const adapter = makeAdapter(failing)
      await expect(adapter.findEntryByUrl(target)).resolves.toBeUndefined()

      const notFound = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
        if (requestUrl.includes('/entries/exists.json')) return new Response('no route', { status: 404 })
        return new Response('unexpected', { status: 500 })
      })
      await expect(makeAdapter(notFound).findEntryByUrl(target)).resolves.toBeUndefined()
    })
  })

  describe('updateEntry', () => {
    it('patches content/title/published_at as form encoding and invalidates the list cache', async () => {
      const calls: Array<{ url: string; init?: RequestInit | undefined }> = []
      const listCalls = (): number => calls.filter(call => call.url.includes('/entries?detail=full')).length
      const entryRow = { id: 7, url: 'https://example.com/a', title: 'Old title', content: `wallabag can't retrieve contents for this article.`, is_archived: 0, created_at: 'stub-created-at' }
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url)
        calls.push({ url: target, init })
        if (target.endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
        if (target.includes('/entries?detail=full')) return new Response(JSON.stringify({ _embedded: { items: [entryRow] }, total: 1 }), { status: 200 })
        if (target.endsWith('/entries/7.json') && init?.method === 'PATCH') return new Response(JSON.stringify({ id: 7 }), { status: 200 })
        return new Response('unexpected', { status: 500 })
      })
      const adapter = makeAdapter(fetchMock)
      await adapter.listEntries()
      await adapter.updateEntry('7', { content: '<p>Repaired body</p>', title: 'New title', publishedAt: '2026-02-03T00:00:00+00:00' })
      const patch = calls.find(call => call.init?.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(patch?.init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
      const body = new URLSearchParams(String(patch?.init?.body))
      expect(body.get('content')).toBe('<p>Repaired body</p>')
      expect(body.get('title')).toBe('New title')
      expect(body.get('published_at')).toBe('2026-02-03T00:00:00+00:00')
      expect(listCalls()).toBe(1)
      await adapter.listEntries()
      expect(listCalls()).toBe(2)
    })

    it('rejects invalid entry ids', async () => {
      const adapter = makeAdapter(vi.fn())
      await expect(adapter.updateEntry('../etc', { content: 'x' })).rejects.toMatchObject({ code: 'INVALID_ID', status: 400 })
    })
  })

  describe('isUnextractedContent', () => {
    it('flags missing, blank and wallabag error placeholder content', () => {
      expect(isUnextractedContent(undefined)).toBe(true)
      expect(isUnextractedContent('')).toBe(true)
      expect(isUnextractedContent('   \n  ')).toBe(true)
      expect(isUnextractedContent(`wallabag can't retrieve contents for this article. Please <a href="https://doc.wallabag.org/en/user/errors_during_fetching.html#how-can-i-help-to-fix-that">troubleshoot this issue</a>.`)).toBe(true)
      expect(isUnextractedContent('Read the docs at https://doc.wallabag.org/ for help.')).toBe(true)
      expect(isUnextractedContent("WALLABAG CAN'T RETRIEVE CONTENTS for this article.")).toBe(true)
    })

    it('keeps healthy content', () => {
      expect(isUnextractedContent('<p>Real article body</p>')).toBe(false)
      expect(isUnextractedContent('<p>正文里提到 mirror.example.com 也不影响</p>')).toBe(false)
    })
  })

  it('loads credentials from current flat mapping and legacy refs mapping', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-reading-credentials-'))
    try {
      const credentials = join(root, '.credentials.yaml')
      const baseEnv = {
        DSH_HOME: root,
        READING_WALLABAG_URL: 'http://wallabag.local',
      }
      writeFileSync(credentials, [
        'READING_WALLABAG_CLIENT_ID: client',
        'READING_WALLABAG_CLIENT_SECRET: secret',
        'READING_WALLABAG_USERNAME: user',
        'READING_WALLABAG_PASSWORD: pass',
        '',
      ].join('\n'))
      expect(WallabagAdapter.fromEnv(baseEnv)).toBeDefined()

      writeFileSync(credentials, [
        'version: 1',
        'refs:',
        '  READING_WALLABAG_CLIENT_ID: client',
        '  READING_WALLABAG_CLIENT_SECRET: secret',
        '  READING_WALLABAG_USERNAME: user',
        '  READING_WALLABAG_PASSWORD: pass',
        '',
      ].join('\n'))
      expect(WallabagAdapter.fromEnv(baseEnv)).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
