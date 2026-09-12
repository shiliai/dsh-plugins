import { describe, expect, it, vi } from 'vitest'
import { WallabagAdapter } from '../src/wallabag-adapter.ts'

describe('WallabagAdapter', () => {
  it('authenticates, lists entries, and imports a URL using form encoding', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(init === undefined ? { url: String(url) } : { url: String(url), init })
      if (String(url).endsWith('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 })
      if (String(url).includes('/entries.json') && init?.method === 'POST') return new Response(JSON.stringify({ id: 7 }), { status: 200 })
      if (String(url).includes('/entries/7?')) return new Response(JSON.stringify({ id: 7, url: 'https://example.com/a', title: 'An article', content: '<p>Read me</p>', is_archived: 0, created_at: '2026-01-01T00:00:00+00:00' }), { status: 200 })
      return new Response(JSON.stringify({ _embedded: { items: [{ id: 8, url: 'https://example.com/b', title: 'B', is_archived: 1 }] } }), { status: 200 })
    })
    const adapter = new WallabagAdapter({ origin: 'http://wallabag.local', clientId: 'client', clientSecret: 'secret', username: 'user', password: 'pass' }, fetchMock as typeof fetch)
    const list = await adapter.listEntries()
    expect(list[0]).toMatchObject({ id: 'wallabag:8', title: 'B', isArchived: true })
    const article = await adapter.importUrl('https://example.com/a')
    expect(article.extractedHtml).toBe('<p>Read me</p>')
    const post = calls.find(call => call.init?.method === 'POST' && call.url.includes('/entries.json'))
    expect(post?.init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(String(post?.init?.body)).toContain('url=https%3A%2F%2Fexample.com%2Fa')
    expect(calls.filter(call => call.url.endsWith('/oauth/v2/token'))).toHaveLength(1)
  })

  it('rejects non-http URLs', async () => {
    const adapter = new WallabagAdapter({ origin: 'http://wallabag.local', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' }, vi.fn() as typeof fetch)
    await expect(adapter.importUrl('javascript:alert(1)')).rejects.toMatchObject({ code: 'INVALID_URL', status: 400 })
  })
})
