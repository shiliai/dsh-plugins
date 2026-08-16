import { randomUUID } from 'node:crypto'
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile,
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
  const value = input.replaceAll('\\', '/').trim()
  if (value.length === 0 || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    throw new VaultError('A vault-relative path is required.', 'INVALID_PATH', 400)
  }
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new VaultError('Path traversal and empty path segments are not allowed.', 'INVALID_PATH', 400)
  }
  return parts.join('/')
}

export class VaultService {
  readonly root: string

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

  async readNote(path: string): Promise<NoteDocument> {
    const absolute = await this.existingPath(path, 'note')
    const info = await stat(absolute)
    if (!info.isFile()) throw new VaultError('The requested note is not a file.', 'NOT_A_NOTE', 400)
    if (info.size > this.maxNoteBytes) {
      throw new VaultError(`Note exceeds the ${this.maxNoteBytes} byte limit.`, 'NOTE_TOO_LARGE', 413)
    }
    return {
      path: normalizeRelativePath(path),
      content: await readFile(absolute, 'utf8'),
      modifiedMs: info.mtimeMs,
      size: info.size,
    }
  }

  async writeNote(path: string, content: string, expectedModifiedMs?: number): Promise<NoteDocument> {
    const bytes = Buffer.byteLength(content)
    if (bytes > this.maxNoteBytes) {
      throw new VaultError(`Note exceeds the ${this.maxNoteBytes} byte limit.`, 'NOTE_TOO_LARGE', 413)
    }
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
  }

  async moveNote(from: string, to: string): Promise<NoteDocument> {
    const source = await this.existingPath(from, 'note')
    const targetPath = this.assertNotePath(to)
    const target = await this.creatablePath(targetPath)
    try {
      await lstat(target)
      throw new VaultError('A note already exists at the target path.', 'NOTE_EXISTS', 409)
    } catch (error) {
      if (error instanceof VaultError) throw error
      if (!isNodeError(error, 'ENOENT')) throw error
    }
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    return this.readNote(targetPath)
  }

  async deleteNote(path: string): Promise<void> {
    await unlink(await this.existingPath(path, 'note'))
  }

  async searchNotes(query: string): Promise<NoteSearchResult[]> {
    const needle = query.trim().toLocaleLowerCase()
    if (needle.length === 0) return []
    const results: NoteSearchResult[] = []
    for (const path of await this.listNotePaths()) {
      const note = await this.readNote(path)
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
    const info = await stat(absolute)
    if (!info.isFile()) throw new VaultError('The requested asset is not a file.', 'NOT_AN_ASSET', 400)
    return { handle: await open(absolute, 'r'), size: info.size, contentType: contentType(extension) }
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
    let ancestor = dirname(lexical)
    for (;;) {
      try {
        const canonical = await realpath(ancestor)
        if (!isInside(this.root, canonical)) {
          throw new VaultError('Symbolic links may not leave the vault.', 'PATH_ESCAPE', 403)
        }
        break
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
        const parent = dirname(ancestor)
        if (parent === ancestor) throw error
        ancestor = parent
      }
    }
    return lexical
  }

  private async walk(absoluteDirectory: string, relativeDirectory: string): Promise<VaultTreeNode[]> {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true })
    const nodes: VaultTreeNode[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink() || HIDDEN_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      const path = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      const absolute = resolve(absoluteDirectory, entry.name)
      if (entry.isDirectory()) {
        const children = await this.walk(absolute, path)
        if (children.length > 0) nodes.push({ name: entry.name, path, type: 'directory', children })
      } else if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === '.md') {
        nodes.push({ name: entry.name, path, type: 'note', modifiedMs: (await stat(absolute)).mtimeMs })
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
