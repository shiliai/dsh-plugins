import type { Annotation, Article, Locator, PublicBook, PublicBookWithProgress, ReadingProgress } from '../contracts.ts'
import type { OpdsBook } from '../opds-adapter.ts'

const API = '/dsh-reading/api'
export interface ReadingSettings { rootDir: string; createSessionOnOpen: boolean }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init)
  if (!response.ok) {
    let message = `Request failed: ${response.status}`
    try {
      const body = await response.json() as { error?: string }
      if (typeof body.error === 'string' && body.error !== '') message = body.error
    } catch { /* keep default message */ }
    throw new Error(message)
  }
  if (response.status === 204 || response.status === 205) return undefined as T
  return response.json() as Promise<T>
}

export const readingApi = {
  settings: () => request<ReadingSettings>('/settings'),
  updateSettings: (value: ReadingSettings) => request<ReadingSettings>('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
  library: () => request<{ books: PublicBookWithProgress[] }>('/library'),
  opdsBooks: () => request<{ source: string; books: OpdsBook[] }>('/opds/books'),
  importOpdsBook: (id: string) => request<{ book: PublicBook }>(`/opds/books/${encodeURIComponent(id)}/import`, { method: 'POST' }),
  ensureBookProject: (id: string) => request<{ path: string; absolutePath: string }>(`/project/book/${encodeURIComponent(id)}`, { method: 'POST' }),
  book: (id: string) => request<{ book: PublicBookWithProgress }>(`/book/${encodeURIComponent(id)}`),
  bookFileUrl: (id: string) => `${API}/book/${encodeURIComponent(id)}/file`,
  importBook: (file: File) => request<{ book: PublicBook }>(`/import?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  }),
  progress: () => request<{ progress: Record<string, ReadingProgress> }>('/progress'),
  setProgress: (bookId: string, locator: Locator, percent: number) =>
    request<{ progress: ReadingProgress }>(`/progress/${encodeURIComponent(bookId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locator, percent }),
    }),
  annotations: (bookId?: string) =>
    request<{ annotations: Annotation[] }>(`/annotations${bookId === undefined ? '' : `?bookId=${encodeURIComponent(bookId)}`}`),
  addAnnotation: (annotation: Annotation) =>
    request<{ annotation: Annotation }>('/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(annotation),
    }),
  removeAnnotation: async (id: string) => {
    await request<void>(`/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  wallabagEntries: () => request<{ articles: Article[] }>('/wallabag/entries'),
  importUrl: (url: string) => request<{ article: Article }>('/wallabag/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }),
  wallabagEntry: (id: string) => request<{ article: Article }>(`/wallabag/entries/${encodeURIComponent(id.replace(/^wallabag:/u, ''))}`),
  ensureArticleProject: (id: string) => request<{ path: string; absolutePath: string }>(`/project/article/${encodeURIComponent(id.replace(/^wallabag:/u, ''))}`, { method: 'POST' }),
}
