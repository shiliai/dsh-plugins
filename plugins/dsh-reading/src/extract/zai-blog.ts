import { parseMdxBundle } from './jsx-mdx.ts'
import type { ExtractedArticle } from './index.ts'

/** Desktop Chrome user agent; the z.ai blog serves the CSR shell to unknown clients too. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 20_000

const BUNDLE_SCRIPT = /<script\s+type="module"[^>]*\ssrc="((?:\/blog\/)?assets\/[^"]+\.js)"/u
const OG_TITLE = /<meta\s+property="og:title"\s+content="([^"]*)"/u

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/giu, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
}

function pageSlug(url: URL): string {
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  const slug = segments[segments.length - 1] ?? ''
  try { return decodeURIComponent(slug) } catch { return slug }
}

async function fetchText(url: URL, fetchImpl: typeof fetch): Promise<string | undefined> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/javascript,*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  try { return await response.text() } catch { return undefined }
}

/** z.ai blog adapter: posts are client-rendered MDX bundles; extract the bundle locally. */
export const zaiBlogAdapter = {
  match(url: URL): boolean {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.hostname !== 'z.ai') return false
    return /^\/blog\/[^/]+/u.test(url.pathname)
  },

  async extract(url: URL, fetchImpl: typeof fetch): Promise<ExtractedArticle | undefined> {
    const page = await fetchText(url, fetchImpl)
    if (page === undefined) return undefined
    const scriptMatch = BUNDLE_SCRIPT.exec(page)
    const asset = scriptMatch?.[1]
    if (asset === undefined) return undefined
    const bundleText = await fetchText(new URL(asset.startsWith('/blog/') ? asset : `/blog/${asset}`, url.origin), fetchImpl)
    if (bundleText === undefined) return undefined
    const bundle = parseMdxBundle(bundleText)
    if (bundle === undefined || bundle.html.trim() === '') return undefined
    const ogTitle = OG_TITLE.exec(page)?.[1]
    const fallbackTitle = bundle.title ?? pageSlug(url).replace(/-/gu, ' ').trim()
    const title = (ogTitle !== undefined && decodeHtmlEntities(ogTitle).trim() !== '' ? decodeHtmlEntities(ogTitle).trim() : fallbackTitle) || url.pathname
    return {
      url: url.toString(),
      title,
      html: bundle.html,
      ...(bundle.date !== undefined ? { publishedAt: bundle.date } : {}),
    }
  },
}
