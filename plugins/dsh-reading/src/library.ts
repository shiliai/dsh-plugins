import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readdir, readFile, stat, writeFile, rename } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { BOOK_FORMATS, isBookFormat, type Book, type BookFormat, type BookMetadata, type BookWithProgress, type ReadingProgress } from './contracts.ts'

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
      // A metadata.json sidecar in the book directory carries user-edited
      // metadata; it is not a book file and is skipped by the format filter.
      const sidecar = await readMetadataFile(dir)
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
        if (sidecar !== undefined) {
          if (sidecar.title !== undefined && sidecar.title.trim() !== '') book.title = sidecar.title.trim()
          if (sidecar.author !== undefined && sidecar.author.trim() !== '') book.author = sidecar.author.trim()
          book.metadata = sidecar
        }
        const bookProgress = progress[book.id]
        books.push(bookProgress === undefined ? book : { ...book, progress: bookProgress })
      }
    }
    books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    return books
  }

  async importBook(data: Buffer, fileName: string, directoryName?: string): Promise<Book> {
    const safeName = sanitizeFileName(fileName)
    const format = extname(safeName).slice(1).toLowerCase()
    if (!isBookFormat(format)) {
      throw new ReadingError(`Unsupported format: ${extname(safeName) || '(none)'}`, 'UNSUPPORTED_FORMAT', 415)
    }
    const id = directoryName !== undefined && directoryName.trim() !== '' ? sanitizeDirectoryName(directoryName) : `local-${randomUUID().slice(0, 12)}`
    const dir = join(this.#booksDir, id)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, safeName)
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, data)
    await rename(tmp, filePath)
    const info = await stat(filePath)
    return {
      id: bookIdFor(relative(this.#dataDir, filePath)),
      source: 'local',
      title: titleFromFileName(safeName),
      format: format as BookFormat,
      filePath,
      fileName: safeName,
      fileSize: info.size,
      checksum: createHash('sha256').update(data).digest('hex'),
      addedAt: info.birthtime.toISOString(),
    }
  }

  async cachedBook(directoryName: string, fileName: string): Promise<Book | undefined> {
    const safeDir = sanitizeDirectoryName(directoryName)
    const safeName = sanitizeFileName(fileName)
    const filePath = join(this.#booksDir, safeDir, safeName)
    try { await access(filePath) } catch { return undefined }
    const info = await stat(filePath)
    if (!info.isFile()) return undefined
    const format = extname(safeName).slice(1).toLowerCase() as BookFormat
    return { id: bookIdFor(relative(this.#dataDir, filePath)), source: 'local', title: titleFromFileName(safeName), format, filePath, fileName: safeName, fileSize: info.size, addedAt: info.birthtime.toISOString() }
  }

  async resolveFile(id: string): Promise<{ filePath: string; format: BookFormat; fileName: string; fileSize: number }> {
    const book = (await this.listBooks({})).find(item => item.id === id)
    if (book === undefined) throw new ReadingError('Book not found.', 'NOT_FOUND', 404)
    if (book.format === 'azw3' || book.format === 'mobi' || book.format === 'azw') {
      const epubPath = `${book.filePath.replace(/\.[^.]+$/u, '')}.epub`
      try {
        const info = await stat(epubPath)
        if (info.isFile()) return { filePath: epubPath, format: 'epub', fileName: `${book.fileName.replace(/\.[^.]+$/u, '')}.epub`, fileSize: info.size }
      } catch { /* conversion not available yet */ }
    }
    return { filePath: book.filePath, format: book.format, fileName: book.fileName, fileSize: book.fileSize }
  }

  /**
   * Merge user-edited metadata into the book's metadata.json sidecar
   * (stored beside the book file inside the book directory). Fields set to
   * undefined are left untouched; empty strings clear the field.
   */
  async saveMetadata(id: string, patch: Partial<Omit<BookMetadata, 'updatedAt'>>, progress: Record<string, ReadingProgress> = {}): Promise<BookWithProgress> {
    const book = (await this.listBooks(progress)).find(item => item.id === id)
    if (book === undefined) throw new ReadingError('Book not found.', 'NOT_FOUND', 404)
    const current = book.metadata ?? { updatedAt: new Date().toISOString() }
    const next: BookMetadata = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.author !== undefined ? { author: patch.author } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags.filter(tag => tag.trim() !== '').map(tag => tag.trim()) } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      updatedAt: new Date().toISOString(),
    }
    const dir = dirname(book.filePath)
    await mkdir(dir, { recursive: true })
    const target = join(dir, 'metadata.json')
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
    const { author: _derivedAuthor, ...rest } = book
    // The fallback title comes from the file name, not book.title: listBooks
    // already overlaid the OLD sidecar title onto book.title, so clearing the
    // custom title must respond with the file-derived title the next list
    // will show.
    const updated: Book = {
      ...rest,
      title: next.title !== undefined && next.title.trim() !== '' ? next.title.trim() : titleFromFileName(book.fileName),
      ...(next.author !== undefined && next.author.trim() !== '' ? { author: next.author.trim() } : {}),
      metadata: next,
    }
    const bookProgress = progress[id]
    return bookProgress === undefined ? updated : { ...updated, progress: bookProgress }
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

/** Best-effort read of a book directory's metadata.json sidecar; malformed files are ignored. */
async function readMetadataFile(dir: string): Promise<BookMetadata | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const record = raw as Record<string, unknown>
    const metadata: BookMetadata = { updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString() }
    if (typeof record.title === 'string') metadata.title = record.title
    if (typeof record.author === 'string') metadata.author = record.author
    if (Array.isArray(record.tags)) metadata.tags = record.tags.filter((tag): tag is string => typeof tag === 'string')
    if (typeof record.summary === 'string') metadata.summary = record.summary
    return metadata
  } catch {
    return undefined
  }
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

function sanitizeDirectoryName(name: string): string {
  const value = name.replaceAll(/[\\/:*?"<>|]/gu, '_').replaceAll(/\s+/gu, '-').replaceAll(/-+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 120)
  if (value === '' || value === '.' || value === '..') throw new ReadingError('Invalid directory name.', 'INVALID_NAME', 400)
  return value
}
