import type { Annotation, Article, BookMetadata, Locator, PublicBook, PublicBookWithProgress, ReadingProgress } from '../contracts.ts'
import type { AgentSkillDocument, AgentSkillInput, AgentSkillListResult } from '@dsh-plugins/dsh-reading-core'
import type { OpdsBook } from '../opds-adapter.ts'

const API = '/dsh-reading/api'
export interface ReadingSettings { rootDir: string; createSessionOnOpen: boolean; sources?: { wallabag: { origin: string; timeoutMs: number; cacheTtlMs: number } | null; opds: { name: string; url: string; timeoutMs: number; cacheTtlMs: number } | null }; cache?: { directory: string; staleWhileRevalidate: boolean; eviction: string } }

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
  bookMetadata: (id: string) => request<{ metadata: BookMetadata | null }>(`/book/${encodeURIComponent(id)}/metadata`),
  saveBookMetadata: (id: string, metadata: { title?: string; author?: string; tags?: string[]; summary?: string }) =>
    request<{ book: PublicBookWithProgress; metadata: BookMetadata | null }>(`/book/${encodeURIComponent(id)}/metadata`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    }),
  uploadToCalibre: (payload: { bookId: string; title?: string; author?: string; tags?: string[]; summary?: string }) =>
    request<{ result: { calibreBookId: string; location: string; warnings: string[] } }>('/calibre/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
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
  /** Open-first: read the article from the local pipeline (wallabag stays optional). */
  openArticle: (url: string) => request<{ article: Article; extraction: string }>('/articles/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }),
  /** Second step: persist into wallabag in the background; failures never block reading. */
  collectArticle: (url: string, extracted?: { title: string; html: string; publishedAt?: string }) => request<{ article: Article; action: string }>('/articles/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, ...(extracted === undefined ? {} : extracted) }),
  }),
  ensureArticleProjectFor: (article: Article) => request<{ path: string; absolutePath: string }>('/project/article', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ article }),
  }),
  skillList: () => request<{ result: AgentSkillListResult }>('/skills'),
  skillGet: (name: string) => request<AgentSkillDocument>(`/skill?name=${encodeURIComponent(name)}`),
  skillWrite: (payload: { input: AgentSkillInput; previousName?: string; expectedRevision?: string }) => request<{ result: { value: AgentSkillDocument } }>('/skill', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill: payload.input, ...(payload.previousName === undefined ? {} : { previousName: payload.previousName }), ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }) }),
  }),
  skillDelete: (name: string, expectedRevision: string) => request<{ result: { value: null } }>(`/skill?name=${encodeURIComponent(name)}&expectedRevision=${encodeURIComponent(expectedRevision)}`, { method: 'DELETE' }),
  /** Config-portability contract: export this plugin's section (`redact` blanks credentials). */
  configExport: (redact = false) => request<unknown>(`/config/export${redact ? '?redact=1' : ''}`),
  /** Config-portability contract: apply (or preview with `dryRun`) a config export envelope. */
  configImport: (envelope: unknown, dryRun = false) => request<{ ok: boolean; dryRun: boolean; report: { pluginId: string; displayName: string; applied: string[]; skipped: string[]; warnings: string[] } }>(`/config/import${dryRun ? '?dryRun=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  }),
}
