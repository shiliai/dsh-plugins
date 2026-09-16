/** Shared contracts between the dsh-reading server plugin and its web client. */

export type BookFormat = 'epub' | 'pdf' | 'azw3' | 'mobi' | 'azw'

export const BOOK_FORMATS: readonly BookFormat[] = ['epub', 'pdf', 'azw3', 'mobi', 'azw']

export function isBookFormat(value: string): value is BookFormat {
  return (BOOK_FORMATS as readonly string[]).includes(value.toLowerCase())
}

export interface Book {
  id: string
  source: 'local'
  title: string
  author?: string
  format: BookFormat
  /** Absolute path of the book file inside the reading data directory. */
  filePath: string
  fileName: string
  fileSize: number
  checksum?: string
  addedAt: string
  convertedTo?: { path: string; at: string }
  /** Stable project path relative to the Reading workspace root. */
  projectPath?: string
  /** Absolute project directory, used when injecting file references into a conversation. */
  projectAbsolutePath?: string
  /** Absolute Reading workspace root, used when injecting file references into a conversation. */
  readingWorkspace?: string
}

export type Locator =
  | { type: 'epub'; cfi: string; chapterHref: string }
  | { type: 'pdf'; page: number; scrollRatio: number }
  | { type: 'article'; scrollRatio: number }

export interface ReadingProgress {
  bookId: string
  locator: Locator
  percent: number
  updatedAt: string
}

export interface Annotation {
  id: string
  bookId: string
  locator: Locator
  chapter?: string
  quote: string
  note?: string
  color: 'yellow' | 'green' | 'blue' | 'pink'
  createdAt: string
  exportedTo?: { path: string; at: string }
}

export interface ReadingStateSnapshot {
  progress: Record<string, ReadingProgress>
  annotations: Annotation[]
}

export interface BookWithProgress extends Book {
  progress?: ReadingProgress
}

/** Book metadata safe to return to web clients; filesystem paths stay server-side. */
export type PublicBook = Omit<Book, 'filePath'>

export type PublicBookWithProgress = Omit<BookWithProgress, 'filePath'>

export interface ReadingApiError {
  error: string
  code: string
}

/** Article saved in Wallabag and exposed to the web client. */
export interface Article {
  id: string
  source: 'wallabag' | 'extract'
  url: string
  title: string
  domain?: string
  /** Original source URL (kept distinct for integrations that rewrite url). */
  originalUrl?: string
  tags?: string[]
  publishedAt?: string
  updatedAt?: string
  readingTimeMin?: number
  isArchived: boolean
  savedAt: string
  extractedHtml?: string
  /** Stable project path relative to the Reading workspace root. */
  projectPath?: string
  /** Absolute project directory, used when injecting file references into a conversation. */
  projectAbsolutePath?: string
  /** Absolute Reading workspace root, used when injecting file references into a conversation. */
  readingWorkspace?: string
  /** Absolute Obsidian vault root when the integration is available. */
  vaultRoot?: string
}
