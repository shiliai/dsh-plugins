import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { BOOK_FORMATS, isBookFormat, type Book, type BookFormat, type BookWithProgress, type ReadingProgress } from './contracts.ts'

const IMPORT_DIR = 'books'

/**
 * Local library rooted at `<dataDir>/books/<bookId>/<fileName>`.
 * The book id is derived from the file's path relative to the data dir, so
 * rescans stay stable without a separate index file.
 */
export class LocalLibrary {
  readonly #dataDir: string
  readonly #booksDir: string

  constructor(dataDir: string) {
    this.#dataDir = dataDir
    this.#booksDir = join(dataDir, IMPORT_DIR)
  }

  get booksDir(): string {
    return this.#booksDir
  }

  async listBooks(progress: Record<string, ReadingProgress>): Promise<BookWithProgress[]> {
    let entries: string[] = []
    try {
      entries = await readdir(this.#booksDir)
    } catch {
      return []
    }
    const books: BookWithProgress[] = []
    for (const entry of entries) {
      const dir = join(this.#booksDir, entry)
      let files: string[] = []
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      for (const fileName of files) {
        const format = extname(fileName).slice(1).toLowerCase()
        if (!isBookFormat(format)) continue
        const filePath = join(dir, fileName)
        let info
        try {
          info = await stat(filePath)
        } catch {
          continue
        }
        if (!info.isFile()) continue
        const book: Book = {
          id: bookIdFor(relative(this.#dataDir, filePath)),
          source: 'local',
          title: titleFromFileName(fileName),
          format: format as BookFormat,
          filePath,
          fileName,
          fileSize: info.size,
          addedAt: info.birthtime.toISOString(),
        }
        const bookProgress = progress[book.id]
        books.push(bookProgress === undefined ? book : { ...book, progress: bookProgress })
      }
    }
    books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    return books
  }

  async importBook(data: Buffer, fileName: string): Promise<Book> {
    const safeName = sanitizeFileName(fileName)
    const format = extname(safeName).slice(1).toLowerCase()
    if (!isBookFormat(format)) {
      throw new ReadingError(`Unsupported format: ${extname(safeName) || '(none)'}`, 'UNSUPPORTED_FORMAT', 415)
    }
    const id = `local-${randomUUID().slice(0, 12)}`
    const dir = join(this.#booksDir, id)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, safeName)
    await writeFile(filePath, data)
    const info = await stat(filePath)
    return {
      id: bookIdFor(relative(this.#dataDir, filePath)),
      source: 'local',
      title: titleFromFileName(safeName),
      format: format as BookFormat,
      filePath,
      fileName: safeName,
      fileSize: info.size,
      addedAt: info.birthtime.toISOString(),
    }
  }

  async resolveFile(id: string): Promise<{ filePath: string; format: BookFormat; fileName: string; fileSize: number }> {
    const book = (await this.listBooks({})).find(item => item.id === id)
    if (book === undefined) throw new ReadingError('Book not found.', 'NOT_FOUND', 404)
    return { filePath: book.filePath, format: book.format, fileName: book.fileName, fileSize: book.fileSize }
  }
}

export class ReadingError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message)
    this.name = 'ReadingError'
  }
}

export function bookIdFor(relativePath: string): string {
  return `local:${createHash('sha1').update(relativePath).digest('hex').slice(0, 16)}`
}

function titleFromFileName(fileName: string): string {
  const stem = basename(fileName, extname(fileName))
  return stem.replaceAll(/[._]+/gu, ' ').trim() || stem
}

function sanitizeFileName(name: string): string {
  const base = basename(name).replaceAll(/[\\/:*?"<>|]/gu, '_').trim()
  if (base === '' || base === '.' || base === '..') {
    throw new ReadingError('Invalid file name.', 'INVALID_NAME', 400)
  }
  const format = extname(base).slice(1).toLowerCase()
  if (!BOOK_FORMATS.includes(format as BookFormat)) {
    throw new ReadingError(`Unsupported format: ${extname(base) || '(none)'}`, 'UNSUPPORTED_FORMAT', 415)
  }
  return base
}
