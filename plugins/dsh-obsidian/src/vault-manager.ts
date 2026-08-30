import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { DirectoryListing, NoteDocument, NoteSearchResult, VaultContextKind, VaultContextReference, VaultTag, VaultTreeNode } from './contracts.ts'
import { VaultError, VaultService } from './vault-service.ts'

export interface VaultAccess {
  readonly root: string
  readonly maxNoteBytes: number
  listTree(): Promise<VaultTreeNode[]>
  listNotePathsPage(cursor?: string, limit?: number, prefix?: string): Promise<{ paths: string[]; nextCursor?: string }>
  readNote(path: string): Promise<NoteDocument>
  writeNote(path: string, content: string, expectedModifiedMs?: number): Promise<NoteDocument>
  moveNote(from: string, to: string): Promise<NoteDocument>
  deleteNote(path: string): Promise<void>
  searchNotes(query: string, prefix?: string): Promise<NoteSearchResult[]>
  listTags(query?: string): Promise<VaultTag[]>
  searchNotesByTag(tag: string, includeDescendants?: boolean): Promise<string[]>
  resolveContext(kind: VaultContextKind, value: string): Promise<VaultContextReference>
  openAsset(path: string): ReturnType<VaultService['openAsset']>
}

export class VaultManager implements VaultAccess {
  private constructor(
    private current: VaultService,
    private readonly configuredMaxNoteBytes: number,
    private readonly searchResultLimit: number,
    private readonly onVaultChange: (root: string) => void,
  ) {}

  static create(root: string, maxNoteBytes: number, searchResultLimit: number, onVaultChange: (root: string) => void = () => undefined): Promise<VaultManager> {
    return VaultService.create(root, maxNoteBytes, searchResultLimit)
      .then(vault => new VaultManager(vault, maxNoteBytes, searchResultLimit, onVaultChange))
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
    this.onVaultChange(this.current.root)
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
  listNotePathsPage(cursor?: string, limit?: number, prefix?: string): ReturnType<VaultService['listNotePathsPage']> {
    return this.current.listNotePathsPage(cursor, limit, prefix)
  }
  readNote(path: string): ReturnType<VaultService['readNote']> { return this.current.readNote(path) }
  writeNote(path: string, content: string, expectedModifiedMs?: number): ReturnType<VaultService['writeNote']> {
    return this.current.writeNote(path, content, expectedModifiedMs)
  }
  moveNote(from: string, to: string): ReturnType<VaultService['moveNote']> { return this.current.moveNote(from, to) }
  deleteNote(path: string): ReturnType<VaultService['deleteNote']> { return this.current.deleteNote(path) }
  searchNotes(query: string, prefix?: string): ReturnType<VaultService['searchNotes']> { return this.current.searchNotes(query, prefix) }
  listTags(query?: string): ReturnType<VaultService['listTags']> { return this.current.listTags(query) }
  searchNotesByTag(tag: string, includeDescendants?: boolean): ReturnType<VaultService['searchNotesByTag']> {
    return this.current.searchNotesByTag(tag, includeDescendants)
  }
  resolveContext(kind: VaultContextKind, value: string): ReturnType<VaultService['resolveContext']> {
    return this.current.resolveContext(kind, value)
  }
  openAsset(path: string): ReturnType<VaultService['openAsset']> { return this.current.openAsset(path) }
}
