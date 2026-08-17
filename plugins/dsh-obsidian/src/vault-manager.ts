import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { DirectoryListing, NoteDocument, NoteSearchResult, VaultTreeNode } from './contracts.ts'
import { VaultError, VaultService } from './vault-service.ts'

export interface VaultAccess {
  readonly root: string
  readonly maxNoteBytes: number
  listTree(): Promise<VaultTreeNode[]>
  listNotePathsPage(cursor?: string, limit?: number): Promise<{ paths: string[]; nextCursor?: string }>
  readNote(path: string): Promise<NoteDocument>
  writeNote(path: string, content: string, expectedModifiedMs?: number): Promise<NoteDocument>
  moveNote(from: string, to: string): Promise<NoteDocument>
  deleteNote(path: string): Promise<void>
  searchNotes(query: string): Promise<NoteSearchResult[]>
  openAsset(path: string): ReturnType<VaultService['openAsset']>
}

export class VaultManager implements VaultAccess {
  private constructor(
    private current: VaultService,
    private readonly configuredMaxNoteBytes: number,
    private readonly searchResultLimit: number,
  ) {}

  static async create(root: string, maxNoteBytes: number, searchResultLimit: number): Promise<VaultManager> {
    const vault = await VaultService.create(root, maxNoteBytes, searchResultLimit)
    return new VaultManager(vault, maxNoteBytes, searchResultLimit)
  }

  get root(): string { return this.current.root }
  get maxNoteBytes(): number { return this.configuredMaxNoteBytes }

  async select(root: string): Promise<void> {
    if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) {
      throw new VaultError('An absolute vault directory is required.', 'INVALID_VAULT_ROOT', 400)
    }
    try {
      const next = await VaultService.create(root.trim(), this.configuredMaxNoteBytes, this.searchResultLimit)
      this.current = next
    } catch (error) {
      if (error instanceof VaultError) throw error
      throw new VaultError(error instanceof Error ? error.message : 'Vault directory is not available.', 'INVALID_VAULT_ROOT', 400)
    }
  }

  async listDirectories(path = this.root): Promise<DirectoryListing> {
    if (!isAbsolute(path)) throw new VaultError('An absolute directory path is required.', 'INVALID_DIRECTORY', 400)
    try {
      const canonical = await realpath(resolve(path))
      if (!(await stat(canonical)).isDirectory()) throw new Error('Path is not a directory.')
      const entries = await readdir(canonical, { withFileTypes: true })
      const directories = entries
        .filter(entry => entry.isDirectory())
        .map(entry => ({ name: entry.name, path: resolve(canonical, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name))
      const parent = dirname(canonical)
      return { path: canonical, parent: parent === canonical ? null : parent, directories }
    } catch (error) {
      if (error instanceof VaultError) throw error
      throw new VaultError(error instanceof Error ? error.message : 'Directory is not available.', 'INVALID_DIRECTORY', 400)
    }
  }

  listTree(): ReturnType<VaultService['listTree']> { return this.current.listTree() }
  listNotePathsPage(cursor?: string, limit?: number): ReturnType<VaultService['listNotePathsPage']> {
    return this.current.listNotePathsPage(cursor, limit)
  }
  readNote(path: string): ReturnType<VaultService['readNote']> { return this.current.readNote(path) }
  writeNote(path: string, content: string, expectedModifiedMs?: number): ReturnType<VaultService['writeNote']> {
    return this.current.writeNote(path, content, expectedModifiedMs)
  }
  moveNote(from: string, to: string): ReturnType<VaultService['moveNote']> { return this.current.moveNote(from, to) }
  deleteNote(path: string): ReturnType<VaultService['deleteNote']> { return this.current.deleteNote(path) }
  searchNotes(query: string): ReturnType<VaultService['searchNotes']> { return this.current.searchNotes(query) }
  openAsset(path: string): ReturnType<VaultService['openAsset']> { return this.current.openAsset(path) }
}
