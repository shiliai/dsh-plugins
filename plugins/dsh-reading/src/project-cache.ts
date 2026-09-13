import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Article, Book, BookFormat } from './contracts.ts'

export interface ReadingProjectConfig {
  rootDir: string
  createSessionOnOpen: boolean
}

export function defaultProjectConfig(dataDir: string): ReadingProjectConfig {
  return { rootDir: join(dataDir, 'workspaces'), createSessionOnOpen: false }
}

export function slug(value: string): string {
  const cleaned = value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80)
  return cleaned || 'untitled'
}

export function projectDirectory(config: ReadingProjectConfig, kind: 'books' | 'articles', id: string, title: string): string {
  const stable = createHash('sha1').update(id).digest('hex').slice(0, 12)
  return join(config.rootDir, kind, `${stable}-${slug(title)}`)
}

export async function writeProjectMetadata(dir: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.metadata-${process.pid}-${Date.now()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, join(dir, 'metadata.json'))
}

export function relativeProjectPath(rootDir: string, dir: string): string {
  return relative(rootDir, dir).split('\\').join('/')
}

export async function readProjectConfig(file: string, fallback: ReadingProjectConfig): Promise<ReadingProjectConfig> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<ReadingProjectConfig>
    return { rootDir: typeof value.rootDir === 'string' && value.rootDir.trim() !== '' ? value.rootDir : fallback.rootDir, createSessionOnOpen: value.createSessionOnOpen === true }
  } catch {
    return fallback
  }
}

export async function saveProjectConfig(file: string, value: ReadingProjectConfig): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

export function bookMetadata(book: Pick<Book, 'id' | 'title' | 'author' | 'format' | 'fileName' | 'fileSize' | 'source'>, path: string): Record<string, unknown> {
  return { kind: 'book', id: book.id, title: book.title, author: book.author, format: book.format as BookFormat, fileName: book.fileName, fileSize: book.fileSize, path, cachedAt: new Date().toISOString() }
}

export function articleMetadata(article: Article, path: string): Record<string, unknown> {
  return { kind: 'article', id: article.id, title: article.title, url: article.url, originalUrl: article.originalUrl ?? article.url, domain: article.domain, tags: article.tags ?? [], savedAt: article.savedAt, publishedAt: article.publishedAt, updatedAt: article.updatedAt, isArchived: article.isArchived, readingTimeMin: article.readingTimeMin, source: article.source, path, contentFile: 'article.md', cachedAt: new Date().toISOString() }
}
