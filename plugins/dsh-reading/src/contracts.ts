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
  addedAt: string
  convertedTo?: { path: string; at: string }
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

export interface ReadingApiError {
  error: string
  code: string
}
