import type { Annotation, Article, Locator, PublicBook, PublicBookWithProgress, ReadingProgress } from '../contracts.ts'

const API = '/dsh-reading/api'

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
  library: () => request<{ books: PublicBookWithProgress[] }>('/library'),
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
}
