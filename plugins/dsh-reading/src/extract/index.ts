import { zaiBlogAdapter } from './zai-blog.ts'

export interface ExtractedArticle {
  url: string
  title: string
  html: string
  publishedAt?: string
}

export interface SiteAdapter {
  match(url: URL): boolean
  extract(url: URL, fetchImpl: typeof fetch): Promise<ExtractedArticle | undefined>
}

/**
 * Site-specific extractors tried in order. Adapters are pure and fail soft:
 * a failing adapter never blocks the next candidate.
 */
const ADAPTERS: SiteAdapter[] = [
  zaiBlogAdapter,
]

/**
 * Extract a readable article locally, without Wallabag. Returns `undefined`
 * when no adapter matches or every matching adapter fails.
 */
export async function extractArticle(url: string, fetchImpl: typeof fetch = fetch): Promise<ExtractedArticle | undefined> {
  let parsed: URL
  try { parsed = new URL(url.trim()) } catch { return undefined }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  for (const adapter of ADAPTERS) {
    if (!adapter.match(parsed)) continue
    try {
      const extracted = await adapter.extract(parsed, fetchImpl)
      if (extracted !== undefined) return extracted
    } catch {
      // Adapter failures must not block the remaining candidates.
    }
  }
  return undefined
}
