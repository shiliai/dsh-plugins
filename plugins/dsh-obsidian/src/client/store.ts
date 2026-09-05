import { useSyncExternalStore } from 'react'
import type { DirectoryListing, NoteDocument, NoteSearchResult, VaultTag, VaultTreeNode } from '../contracts.ts'
import { vaultApi } from './api.ts'

export type NoteMode = 'edit' | 'preview'
export type VaultView = 'notes' | 'tags'

export type PendingDiscardAction =
  | { kind: 'open'; path: string }
  | { kind: 'close' }

export interface VaultSnapshot {
  vaultName: string
  vaultRoot: string
  tree: VaultTreeNode[]
  active: NoteDocument | null
  draft: string
  mode: NoteMode
  view: VaultView
  query: string
  searchResults: NoteSearchResult[]
  tags: VaultTag[]
  selectedTag: string | null
  tagPaths: string[]
  directoryListing: DirectoryListing | null
  loadingTree: boolean
  loadingTags: boolean
  loadingDirectories: boolean
  switchingVault: boolean
  loadingNote: boolean
  saving: boolean
  pendingDiscard: PendingDiscardAction | null
  error: string | null
}

interface PanelLifecycle {
  open(): void
  close(): void
}

interface VaultApi {
  info(): Promise<{ name: string; root: string }>
  directories(path?: string): Promise<DirectoryListing>
  selectVault(root: string): Promise<{ name: string; root: string }>
  tree(): Promise<{ nodes: VaultTreeNode[] }>
  note(path: string): Promise<NoteDocument>
  search(query: string): Promise<{ results: NoteSearchResult[] }>
  tags(query?: string): Promise<{ tags: VaultTag[] }>
  tag(name: string, includeDescendants?: boolean): Promise<{ paths: string[] }>
  write(path: string, content: string, expectedModifiedMs?: number): Promise<NoteDocument>
  move(from: string, to: string): Promise<NoteDocument>
  delete(path: string): Promise<void>
}

const INITIAL: VaultSnapshot = {
  vaultName: 'Vault',
  vaultRoot: '',
  tree: [],
  active: null,
  draft: '',
  mode: 'preview',
  view: 'notes',
  query: '',
  searchResults: [],
  tags: [],
  selectedTag: null,
  tagPaths: [],
  directoryListing: null,
  loadingTree: false,
  loadingTags: false,
  loadingDirectories: false,
  switchingVault: false,
  loadingNote: false,
  saving: false,
  pendingDiscard: null,
  error: null,
}

export class VaultStore {
  private snapshot: VaultSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private noteGeneration = 0
  private draftGeneration = 0
  private saveGeneration = 0
  private treeGeneration = 0
  private tagGeneration = 0
  private directoryGeneration = 0
  private panelSuppressed = false

  constructor(private readonly panel: PanelLifecycle, private readonly api: VaultApi = vaultApi) {}

  getSnapshot = (): VaultSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  useSnapshot(): VaultSnapshot {
    return useSyncExternalStore(this.subscribe, this.getSnapshot, this.getSnapshot)
  }

  get dirty(): boolean {
    return this.snapshot.active !== null && this.snapshot.draft !== this.snapshot.active.content
  }

  setPanelSuppressed(suppressed: boolean): void {
    this.panelSuppressed = suppressed
    if (suppressed) this.panel.close()
  }

  async initialize(): Promise<void> {
    const [info] = await Promise.all([this.api.info(), this.refreshTree()])
    this.update({ vaultName: info.name, vaultRoot: info.root })
  }

  async refreshTags(): Promise<void> {
    const generation = ++this.tagGeneration
    this.update({ loadingTags: true })
    try {
      const { tags } = await this.api.tags()
      if (generation === this.tagGeneration) this.update({ tags, loadingTags: false, error: null })
    } catch (error) {
      if (generation === this.tagGeneration) this.update({ loadingTags: false, error: message(error) })
    }
  }

  setView(view: VaultView): void {
    if (view === this.snapshot.view) return
    this.update({ view, query: '', searchResults: [], selectedTag: null, tagPaths: [] })
    if (view === 'tags') void this.refreshTags()
  }

  setTagQuery(query: string): void {
    this.update({ query })
  }

  async selectTag(tag: string): Promise<void> {
    const generation = ++this.tagGeneration
    this.update({ selectedTag: tag, tagPaths: [], loadingTags: true, error: null })
    try {
      const { paths } = await this.api.tag(tag, true)
      if (generation === this.tagGeneration && this.snapshot.selectedTag === tag) this.update({ tagPaths: paths, loadingTags: false })
    } catch (error) {
      if (generation === this.tagGeneration) this.update({ loadingTags: false, error: message(error) })
    }
  }

  clearSelectedTag(): void {
    this.tagGeneration++
    this.update({ selectedTag: null, tagPaths: [], loadingTags: false })
  }

  async refreshTree(): Promise<void> {
    const generation = ++this.treeGeneration
    this.update({ loadingTree: true })
    try {
      const { nodes } = await this.api.tree()
      if (generation === this.treeGeneration) this.update({ tree: nodes, loadingTree: false, error: null })
    } catch (error) {
      if (generation === this.treeGeneration) this.update({ loadingTree: false, error: message(error) })
    }
  }

  async openVaultChooser(): Promise<void> {
    if (this.dirty) {
      this.update({ error: 'Save or discard the active note before switching vaults.' })
      return
    }
    await this.browseDirectories()
  }

  closeVaultChooser(): void {
    this.directoryGeneration++
    this.update({ directoryListing: null, loadingDirectories: false })
  }

  async browseDirectories(path?: string): Promise<void> {
    const generation = ++this.directoryGeneration
    this.update({ loadingDirectories: true, error: null })
    try {
      const directoryListing = await this.api.directories(path)
      if (generation === this.directoryGeneration) this.update({ directoryListing, loadingDirectories: false })
    } catch (error) {
      if (generation === this.directoryGeneration) this.update({ loadingDirectories: false, error: message(error) })
    }
  }

  async selectVault(root: string): Promise<void> {
    if (this.dirty || this.snapshot.switchingVault) return
    this.update({ switchingVault: true, error: null })
    try {
      const info = await this.api.selectVault(root)
      this.noteGeneration++
      this.draftGeneration++
      this.invalidateSave()
      this.directoryGeneration++
      this.treeGeneration++
      this.tagGeneration++
      if (!this.panelSuppressed) this.panel.close()
      this.update({
        vaultName: info.name,
        vaultRoot: info.root,
        tree: [],
        active: null,
        draft: '',
        view: 'notes',
        query: '',
        searchResults: [],
        tags: [],
        selectedTag: null,
        tagPaths: [],
        directoryListing: null,
        loadingDirectories: false,
        switchingVault: false,
        saving: false,
        pendingDiscard: null,
      })
      await this.refreshTree()
    } catch (error) {
      this.update({ switchingVault: false, error: message(error) })
    }
  }

  async openNote(path: string, options?: { allowDirty?: boolean }): Promise<void> {
    if (this.snapshot.pendingDiscard !== null || this.snapshot.active?.path === path) return
    if (this.dirty && options?.allowDirty !== true) {
      this.update({ pendingDiscard: { kind: 'open', path } })
      return
    }
    const generation = ++this.noteGeneration
    if (!this.panelSuppressed) this.panel.open()
    this.update({ loadingNote: true, error: null })
    try {
      const note = await this.api.note(path)
      if (generation !== this.noteGeneration) return
      this.draftGeneration++
      this.update({ active: note, draft: note.content, loadingNote: false, mode: 'preview' })
    } catch (error) {
      if (generation === this.noteGeneration) this.update({ loadingNote: false, error: message(error) })
    }
  }

  closeNote(): void {
    if (this.snapshot.pendingDiscard !== null) return
    if (this.dirty) {
      this.update({ pendingDiscard: { kind: 'close' } })
      return
    }
    this.noteGeneration++
    this.draftGeneration++
    this.invalidateSave()
    this.update({ active: null, draft: '', saving: false, error: null })
    if (!this.panelSuppressed) this.panel.close()
  }

  cancelPendingDiscard(): void {
    if (this.snapshot.pendingDiscard !== null) this.update({ pendingDiscard: null })
  }

  async discardPendingChanges(): Promise<void> {
    const pending = this.snapshot.pendingDiscard
    const active = this.snapshot.active
    if (pending === null || active === null) return

    this.draftGeneration++
    this.invalidateSave()
    this.update({ draft: active.content, pendingDiscard: null, saving: false })
    if (pending.kind === 'open') await this.openNote(pending.path)
    else this.closeNote()
  }

  setDraft(draft: string): void {
    this.draftGeneration++
    this.update({ draft })
  }
  setMode(mode: NoteMode): void { this.update({ mode }) }

  async save(): Promise<void> {
    const active = this.snapshot.active
    if (active === null || !this.dirty) return
    const noteGeneration = this.noteGeneration
    const draftGeneration = this.draftGeneration
    const saveGeneration = ++this.saveGeneration
    const draft = this.snapshot.draft
    this.update({ saving: true, error: null })
    try {
      const note = await this.api.write(active.path, draft, active.modifiedMs)
      if (saveGeneration !== this.saveGeneration || noteGeneration !== this.noteGeneration || this.snapshot.active?.path !== active.path) return
      const draftChanged = draftGeneration !== this.draftGeneration
      this.update({ active: note, draft: draftChanged ? this.snapshot.draft : note.content, saving: false })
      await this.refreshTree()
      if (this.snapshot.view === 'tags') await this.refreshTags()
    } catch (error) {
      if (saveGeneration === this.saveGeneration && noteGeneration === this.noteGeneration) this.update({ saving: false, error: message(error) })
    }
  }

  async createNote(path: string): Promise<void> {
    const normalized = path.trim().endsWith('.md') ? path.trim() : `${path.trim()}.md`
    if (normalized === '.md') return
    try {
      this.noteGeneration++
      this.invalidateSave()
      this.update({ saving: false })
      await this.api.write(normalized, `# ${titleFromPath(normalized)}\n\n`)
      await this.refreshTree()
      if (this.snapshot.view === 'tags') await this.refreshTags()
      await this.openNote(normalized)
      this.setMode('edit')
    } catch (error) {
      this.update({ error: message(error) })
    }
  }

  async renameActive(to: string): Promise<void> {
    const active = this.snapshot.active
    const trimmed = to.trim()
    if (active === null || trimmed === '') return
    if (this.dirty) {
      await this.save()
      if (this.dirty) return
    }
    const normalized = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
    if (normalized === active.path) return
    try {
      this.noteGeneration++
      this.invalidateSave()
      this.update({ saving: false })
      const note = await this.api.move(active.path, normalized)
      this.draftGeneration++
      this.update({ active: note, draft: note.content, error: null })
      await this.refreshTree()
      if (this.snapshot.view === 'tags') await this.refreshTags()
    } catch (error) {
      this.update({ error: message(error) })
    }
  }

  async deleteActive(): Promise<void> {
    const active = this.snapshot.active
    if (active === null) return
    try {
      this.noteGeneration++
      this.draftGeneration++
      this.invalidateSave()
      this.update({ saving: false })
      await this.api.delete(active.path)
      this.update({ active: null, draft: '', error: null })
      if (!this.panelSuppressed) this.panel.close()
      await this.refreshTree()
      if (this.snapshot.view === 'tags') await this.refreshTags()
    } catch (error) {
      this.update({ error: message(error) })
    }
  }

  async search(query: string): Promise<void> {
    this.update({ query })
    if (query.trim() === '') {
      this.update({ searchResults: [] })
      return
    }
    try {
      const { results } = await this.api.search(query)
      if (this.snapshot.query === query) this.update({ searchResults: results, error: null })
    } catch (error) {
      this.update({ error: message(error) })
    }
  }

  async pollActive(): Promise<void> {
    const active = this.snapshot.active
    if (active === null || this.dirty || this.snapshot.saving) return
    const noteGeneration = this.noteGeneration
    const draftGeneration = this.draftGeneration
    const path = active.path
    const modifiedMs = active.modifiedMs
    try {
      const current = await this.api.note(path)
      if (noteGeneration !== this.noteGeneration || draftGeneration !== this.draftGeneration || this.snapshot.active?.path !== path || this.snapshot.active.modifiedMs !== modifiedMs || this.dirty) return
      if (current.modifiedMs !== modifiedMs) {
        this.draftGeneration++
        this.update({ active: current, draft: current.content })
      }
    } catch (error) {
      if (noteGeneration === this.noteGeneration) this.update({ error: message(error) })
    }
  }

  private update(patch: Partial<VaultSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private invalidateSave(): void {
    this.saveGeneration++
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected vault error.'
}

function titleFromPath(path: string): string {
  return path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? 'Untitled'
}
