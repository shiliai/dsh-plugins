import { randomUUID } from 'node:crypto'
import {
  link, lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile,
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { NoteDocument, NoteSearchResult, VaultTreeNode } from './contracts.ts'

const HIDDEN_DIRECTORIES = new Set(['.git', '.obsidian', 'node_modules'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'])

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function normalizeRelativePath(input: string): string {
  if (input.length === 0 || input.includes('\0') || input.includes('\\') || input.startsWith('/') || /^[A-Za-z]:\//.test(input)) {
    throw new VaultError('A vault-relative path is required.', 'INVALID_PATH', 400)
  }
  const parts = input.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new VaultError('Path traversal and empty path segments are not allowed.', 'INVALID_PATH', 400)
  }
  return parts.join('/')
}

export class VaultService {
  readonly root: string
  private mutationTail: Promise<void> = Promise.resolve()

  private constructor(
    root: string,
    readonly maxNoteBytes: number,
    readonly searchResultLimit: number,
  ) {
    this.root = root
  }

  static async create(root: string, maxNoteBytes: number, searchResultLimit: number): Promise<VaultService> {
    if (!Number.isSafeInteger(maxNoteBytes) || maxNoteBytes < 1) {
      throw new Error('maxNoteBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(searchResultLimit) || searchResultLimit < 1) {
      throw new Error('searchResultLimit must be a positive safe integer')
    }
    const canonicalRoot = await realpath(resolve(root))
    const info = await stat(canonicalRoot)
    if (!info.isDirectory()) throw new Error(`vaultRoot is not a directory: ${canonicalRoot}`)
    return new VaultService(canonicalRoot, maxNoteBytes, searchResultLimit)
  }

  async listTree(): Promise<VaultTreeNode[]> {
    return this.walk(this.root, '')
  }

  async listNotePaths(): Promise<string[]> {
    const output: string[] = []
    const visit = (nodes: VaultTreeNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'note') output.push(node.path)
        else if (node.children !== undefined) visit(node.children)
      }
    }
    visit(await this.listTree())
    return output
  }

  async listNotePathsPage(cursor?: string, limit = 100): Promise<{ paths: string[]; nextCursor?: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new VaultError('Note list limit must be between 1 and 500.', 'INVALID_QUERY', 400)
    }
    const paths = await this.listNotePaths()
    let start = 0
    if (cursor !== undefined) {
      const index = paths.indexOf(cursor)
      if (index === -1) throw new VaultError('Note list cursor is not valid for this vault.', 'INVALID_QUERY', 400)
      start = index + 1
    }
    const page = paths.slice(start, start + limit)
    const last = page.at(-1)
    return last !== undefined && start + page.length < paths.length ? { paths: page, nextCursor: last } : { paths: page }
  }

  async readNote(path: string): Promise<NoteDocument> {
    const absolute = await this.existingPath(path, 'note')
    const handle = await open(absolute, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new VaultError('The requested note is not a file.', 'NOT_A_NOTE', 400)
      if (info.size > this.maxNoteBytes) {
        throw new VaultError(`Note exceeds the ${this.maxNoteBytes} byte limit.`, 'NOTE_TOO_LARGE', 413)
      }
      return {
        path: normalizeRelativePath(path),
        content: await handle.readFile({ encoding: 'utf8' }),
        modifiedMs: info.mtimeMs,
        size: info.size,
      }
    } finally {
      await handle.close()
    }
  }

  async writeNote(path: string, content: string, expectedModifiedMs?: number): Promise<NoteDocument> {
    const bytes = Buffer.byteLength(content)
    if (bytes > this.maxNoteBytes) {
      throw new VaultError(`Note exceeds the ${this.maxNoteBytes} byte limit.`, 'NOTE_TOO_LARGE', 413)
    }
    return this.mutate(async () => {
      const normalized = this.assertNotePath(path)
      const absolute = await this.creatablePath(normalized)
      let currentModifiedMs: number | undefined
      try {
        currentModifiedMs = (await stat(absolute)).mtimeMs
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
      if (currentModifiedMs !== undefined && expectedModifiedMs === undefined) {
        throw new VaultError('The note already exists; read it before replacing it.', 'NOTE_EXISTS', 409)
      }
      if (expectedModifiedMs !== undefined && currentModifiedMs !== expectedModifiedMs) {
        throw new VaultError('The note changed after it was opened.', 'NOTE_CONFLICT', 409)
      }
      await mkdir(dirname(absolute), { recursive: true })
      await this.assertCreatableComponents(normalized)
      const temporary = `${absolute}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, absolute)
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error
        })
      }
      return this.readNote(normalized)
    })
  }

  async moveNote(from: string, to: string): Promise<NoteDocument> {
    return this.mutate(async () => {
      const source = await this.existingPath(from, 'note')
      const targetPath = this.assertNotePath(to)
      const target = await this.creatablePath(targetPath)
      await mkdir(dirname(target), { recursive: true })
      await this.assertCreatableComponents(targetPath)
      try {
        await link(source, target)
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) throw new VaultError('A note already exists at the target path.', 'NOTE_EXISTS', 409)
        throw error
      }
      try {
        await unlink(source)
      } catch (error) {
        await unlink(target).catch(() => undefined)
        throw error
      }
      return this.readNote(targetPath)
    })
  }

  async deleteNote(path: string): Promise<void> {
    await this.mutate(async () => {
      await unlink(await this.existingPath(path, 'note'))
    })
  }

  async searchNotes(query: string): Promise<NoteSearchResult[]> {
    const needle = query.trim().toLocaleLowerCase()
    if (needle.length === 0) return []
    const results: NoteSearchResult[] = []
    for (const path of await this.listNotePaths()) {
      let note: NoteDocument
      try {
        note = await this.readNote(path)
      } catch (error) {
        if (error instanceof VaultError && error.code === 'NOTE_TOO_LARGE') continue
        throw error
      }
      const lines = note.content.split(/\r?\n/u)
      const pathMatch = path.toLocaleLowerCase().includes(needle)
      if (pathMatch) results.push({ path, line: 0, excerpt: path })
      for (let index = 0; index < lines.length && results.length < this.searchResultLimit; index++) {
        const line = lines[index]
        if (line !== undefined && line.toLocaleLowerCase().includes(needle)) {
          results.push({ path, line: index + 1, excerpt: line.trim().slice(0, 240) })
        }
      }
      if (results.length >= this.searchResultLimit) break
    }
    return results.slice(0, this.searchResultLimit)
  }

  async openAsset(path: string): Promise<{ handle: Awaited<ReturnType<typeof open>>; size: number; contentType: string }> {
    const normalized = normalizeRelativePath(path)
    const extension = extname(normalized).toLocaleLowerCase()
    if (!IMAGE_EXTENSIONS.has(extension)) {
      throw new VaultError('Only supported image assets can be opened.', 'UNSUPPORTED_ASSET', 400)
    }
    const absolute = await this.existingPath(normalized, 'asset')
    const handle = await open(absolute, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new VaultError('The requested asset is not a file.', 'NOT_AN_ASSET', 400)
      return { handle, size: info.size, contentType: contentType(extension) }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  private assertNotePath(path: string): string {
    const normalized = normalizeRelativePath(path)
    if (extname(normalized).toLocaleLowerCase() !== '.md') {
      throw new VaultError('Note paths must end in .md.', 'NOT_A_NOTE', 400)
    }
    return normalized
  }

  private async existingPath(path: string, kind: 'note' | 'asset'): Promise<string> {
    const normalized = kind === 'note' ? this.assertNotePath(path) : normalizeRelativePath(path)
    const lexical = resolve(this.root, normalized)
    if (!isInside(this.root, lexical)) throw new VaultError('Path leaves the vault.', 'PATH_ESCAPE', 403)
    await this.assertExistingComponents(normalized)
    let canonical: string
    try {
      canonical = await realpath(lexical)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new VaultError('Vault entry not found.', 'NOT_FOUND', 404)
      throw error
    }
    if (!isInside(this.root, canonical)) {
      throw new VaultError('Symbolic links may not leave the vault.', 'PATH_ESCAPE', 403)
    }
    return canonical
  }

  private async creatablePath(path: string): Promise<string> {
    const lexical = resolve(this.root, path)
    if (!isInside(this.root, lexical)) throw new VaultError('Path leaves the vault.', 'PATH_ESCAPE', 403)
    await this.assertCreatableComponents(path)
    return lexical
  }

  private async assertExistingComponents(path: string): Promise<void> {
    let candidate = this.root
    for (const part of path.split('/')) {
      candidate = resolve(candidate, part)
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(candidate)
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) throw new VaultError('Vault entry not found.', 'NOT_FOUND', 404)
        throw error
      }
      if (info.isSymbolicLink()) throw new VaultError('Symbolic links are not allowed for vault operations.', 'PATH_ESCAPE', 403)
    }
  }

  private async assertCreatableComponents(path: string): Promise<void> {
    let candidate = this.root
    for (const part of path.split('/')) {
      candidate = resolve(candidate, part)
      try {
        const info = await lstat(candidate)
        if (info.isSymbolicLink()) throw new VaultError('Symbolic links are not allowed for vault operations.', 'PATH_ESCAPE', 403)
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return
        throw error
      }
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release: (() => void) | undefined
    this.mutationTail = new Promise(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }

  private async walk(absoluteDirectory: string, relativeDirectory: string): Promise<VaultTreeNode[]> {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true })
    const nodes: VaultTreeNode[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.includes('\\') || HIDDEN_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      const path = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      const absolute = resolve(absoluteDirectory, entry.name)
      const current = await lstat(absolute)
      if (current.isSymbolicLink()) continue
      if (current.isDirectory()) {
        const children = await this.walk(absolute, path)
        if (children.length > 0) nodes.push({ name: entry.name, path, type: 'directory', children })
      } else if (current.isFile() && extname(entry.name).toLocaleLowerCase() === '.md') {
        nodes.push({ name: entry.name, path, type: 'note', modifiedMs: current.mtimeMs })
      }
    }
    return nodes.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function contentType(extension: string): string {
  switch (extension) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.avif': return 'image/avif'
    default: throw new Error(`unsupported image extension: ${extension}`)
  }
}
