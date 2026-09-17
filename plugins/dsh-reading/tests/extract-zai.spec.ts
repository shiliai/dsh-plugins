import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { extractArticle } from '../src/extract/index.ts'
import { zaiBlogAdapter } from '../src/extract/zai-blog.ts'

/** Real MDX bundle captured from a z.ai blog post (CSR shell + module script). */
const BUNDLE_SOURCE = readFileSync(new URL('./fixtures/zai-post.js', import.meta.url), 'utf8')
const BUNDLE_PATH = '/blog/assets/glm-built-its-inference-infrastructure-qEyLd6aI.js'

const pageHtml = (scriptPath: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta property="og:title" content="Toward Recursive Self-Improvement: How GLM Built Its Own Inference Infrastructure">
    <meta property="og:title" content="Ignored duplicate">
    <script type="module" crossorigin src="${scriptPath}"></script>
  </head>
  <body><div id="root"></div></body>
</html>`

function stubZaiFetch(options: { pageStatus?: number; pageHtml?: string; bundleStatus?: number; bundleSource?: string } = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.hostname !== 'z.ai') return new Response('not found', { status: 404 })
    if (url.pathname.startsWith('/blog/assets/')) {
      if (url.pathname.endsWith('.js') === false) return new Response('not found', { status: 404 })
      if (options.bundleStatus === 404) return new Response('missing', { status: 404 })
      return new Response(options.bundleSource ?? BUNDLE_SOURCE, { status: 200, headers: { 'Content-Type': 'text/javascript' } })
    }
    if (options.pageStatus === 500) return new Response('boom', { status: 500 })
    return new Response(options.pageHtml ?? pageHtml(BUNDLE_PATH), { status: 200, headers: { 'Content-Type': 'text/html' } })
  })
}

describe('zaiBlogAdapter', () => {
  it('matches z.ai blog posts with a slug only', () => {
    expect(zaiBlogAdapter.match(new URL('https://z.ai/blog/glm-built-its-inference-infrastructure'))).toBe(true)
    expect(zaiBlogAdapter.match(new URL('https://z.ai/blog/nested/post'))).toBe(true)
    expect(zaiBlogAdapter.match(new URL('https://z.ai/blog/'))).toBe(false)
    expect(zaiBlogAdapter.match(new URL('https://z.ai/blog'))).toBe(false)
    expect(zaiBlogAdapter.match(new URL('https://z.ai/docs/overview'))).toBe(false)
    expect(zaiBlogAdapter.match(new URL('https://example.com/blog/post'))).toBe(false)
    expect(zaiBlogAdapter.match(new URL('ftp://z.ai/blog/post'))).toBe(false)
  })

  it('extracts the article from the page shell plus its MDX bundle', async () => {
    const fetchMock = stubZaiFetch()
    const extracted = await zaiBlogAdapter.extract(new URL('https://z.ai/blog/glm-built-its-inference-infrastructure'), fetchMock as unknown as typeof fetch)
    expect(extracted).toBeDefined()
    expect(extracted?.url).toBe('https://z.ai/blog/glm-built-its-inference-infrastructure')
    expect(extracted?.title).toBe('Toward Recursive Self-Improvement: How GLM Built Its Own Inference Infrastructure')
    expect(extracted?.publishedAt).toBe('2026-09-17')
    expect(extracted?.html).toContain('<p>As we develop GLM, the model sometimes exhibits capabilities')
    expect(extracted?.html).toContain('<pre><code class="language-Python">')
    expect(extracted?.html).toContain('<img src="https://z-cdn-media.chatglm.cn/')
    expect(extracted?.html).toContain('<blockquote><p><strong>Figure 1:')
    // The bundle is fetched from the same origin the page was served from.
    const requestedUrls = fetchMock.mock.calls.map(call => String(call[0]))
    expect(requestedUrls).toContain(`https://z.ai${BUNDLE_PATH}`)
  })

  it('decodes HTML entities in the og:title meta value', async () => {
    const withEntities = pageHtml(BUNDLE_PATH).replace(
      'content="Toward Recursive Self-Improvement: How GLM Built Its Own Inference Infrastructure"',
      'content="A &amp; B &quot;quoted&quot;"',
    )
    const fetchMock = stubZaiFetch({ pageHtml: withEntities })
    const extracted = await zaiBlogAdapter.extract(new URL('https://z.ai/blog/entity-post'), fetchMock as unknown as typeof fetch)
    expect(extracted?.title).toBe('A & B "quoted"')
  })

  it('falls back to the bundle title and then the slug for the title', async () => {
    const bundleWithTitle = BUNDLE_SOURCE.replace(
      'title:`Toward Recursive Self-Improvement: How GLM Built Its Own Inference Infrastructure`',
      'title:`Bundle Title`',
    )
    const noOg = pageHtml(BUNDLE_PATH).replace(/<meta property="og:title"[^>]*>/gu, '')
    const fromBundle = await zaiBlogAdapter.extract(new URL('https://z.ai/blog/some-post'), stubZaiFetch({ pageHtml: noOg, bundleSource: bundleWithTitle }) as unknown as typeof fetch)
    expect(fromBundle?.title).toBe('Bundle Title')

    const bundleWithoutTitle = BUNDLE_SOURCE.replace('title:`Toward Recursive Self-Improvement: How GLM Built Its Own Inference Infrastructure`,', '')
    const fromSlug = await zaiBlogAdapter.extract(new URL('https://z.ai/blog/some-post'), stubZaiFetch({ pageHtml: noOg, bundleSource: bundleWithoutTitle }) as unknown as typeof fetch)
    expect(fromSlug?.title).toBe('some post')
  })

  it('returns undefined when the page, the bundle or the parse fails', async () => {
    const pageFailed = await zaiBlogAdapter.extract(new URL('https://z.ai/blog/post'), stubZaiFetch({ pageStatus: 500 }) as unknown as typeof fetch)
    expect(pageFailed).toBeUndefined()

    const bundleFailed = await zaiBlogAdapter.extract(new URL('https://z.ai/blog/post'), stubZaiFetch({ bundleStatus: 404 }) as unknown as typeof fetch)
    expect(bundleFailed).toBeUndefined()

    const parseFailed = await zaiBlogAdapter.extract(new URL('https://z.ai/blog/post'), stubZaiFetch({ bundleSource: 'this is not a bundle' }) as unknown as typeof fetch)
    expect(parseFailed).toBeUndefined()

    const noScript = await zaiBlogAdapter.extract(new URL('https://z.ai/blog/post'), stubZaiFetch({ pageHtml: '<html><body><div id="root"></div></body></html>' }) as unknown as typeof fetch)
    expect(noScript).toBeUndefined()
  })

  it('surfaces adapter crashes as undefined via the registry', async () => {
    vi.stubGlobal('fetch', stubZaiFetch())
    try {
      await expect(extractArticle('https://z.ai/blog/glm-built-its-inference-infrastructure')).resolves.toMatchObject({ publishedAt: '2026-09-17' })
      await expect(extractArticle('https://example.com/blog/post')).resolves.toBeUndefined()
      await expect(extractArticle('not a url')).resolves.toBeUndefined()
      await expect(extractArticle('javascript:alert(1)')).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
