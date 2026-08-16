import { useSyncExternalStore } from 'react'
import type { NoteDocument, NoteSearchResult, VaultTreeNode } from '../contracts.ts'
import { vaultApi } from './api.ts'

export type NoteMode = 'edit' | 'preview'

export interface VaultSnapshot {
  vaultName: string
  vaultRoot: string
  tree: VaultTreeNode[]
  active: NoteDocument | null
  draft: string
  mode: NoteMode
  query: string
  searchResults: NoteSearchResult[]
  loadingTree: boolean
  loadingNote: boolean
  saving: boolean
  error: string | null
}

interface PanelLifecycle {
  open(): void
  close(): void
}

const INITIAL: VaultSnapshot = {
  vaultName: 'Vault',
  vaultRoot: '',
  tree: [],
  active: null,
  draft: '',
  mode: 'preview',
  query: '',
  searchResults: [],
  loadingTree: false,
  loadingNote: false,
  saving: false,
  error: null,
}

export class VaultStore {
  private snapshot: VaultSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()

  constructor(private readonly panel: PanelLifecycle) {}

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

  async initialize(): Promise<void> {
    const [info] = await Promise.all([vaultApi.info(), this.refreshTree()])
    this.update({ vaultName: info.name, vaultRoot: info.root })
  }

  async refreshTree(): Promise<void> {
    this.update({ loadingTree: true })
    try {
      const { nodes } = await vaultApi.tree()
      this.update({ tree: nodes, loadingTree: false, error: null })
    } catch (error) {
      this.update({ loadingTree: false, error: message(error) })
    }
  }

  async openNote(path: string): Promise<void> {
    if (this.dirty && !window.confirm('Discard unsaved changes?')) return
    this.panel.open()
    this.update({ loadingNote: true, error: null })
    try {
      const note = await vaultApi.note(path)
      this.update({ active: note, draft: note.content, loadingNote: false, mode: 'preview' })
    } catch (error) {
      this.update({ loadingNote: false, error: message(error) })
    }
  }

  closeNote(): void {
    if (this.dirty && !window.confirm('Discard unsaved changes?')) return
    this.update({ active: null, draft: '', error: null })
    this.panel.close()
  }

  setDraft(draft: string): void { this.update({ draft }) }
  setMode(mode: NoteMode): void { this.update({ mode }) }

  async save(): Promise<void> {
    const active = this.snapshot.active
    if (active === null || !this.dirty) return
    this.update({ saving: true, error: null })
    try {
      const note = await vaultApi.write(active.path, this.snapshot.draft, active.modifiedMs)
      this.update({ active: note, draft: note.content, saving: false })
      await this.refreshTree()
    } catch (error) {
      this.update({ saving: false, error: message(error) })
    }
  }

  async createNote(path: string): Promise<void> {
    const normalized = path.trim().endsWith('.md') ? path.trim() : `${path.trim()}.md`
    if (normalized === '.md') return
    try {
      await vaultApi.write(normalized, `# ${titleFromPath(normalized)}\n\n`)
      await this.refreshTree()
      await this.openNote(normalized)
      this.setMode('edit')
    } catch (error) {
      this.update({ error: message(error) })
    }
  }

  async renameActive(to: string): Promise<void> {
    const active = this.snapshot.active
    if (active === null) return
    if (this.dirty) await this.save()
    const normalized = to.trim().endsWith('.md') ? to.trim() : `${to.trim()}.md`
    try {
      const note = await vaultApi.move(active.path, normalized)
      this.update({ active: note, draft: note.content, error: null })
      await this.refreshTree()
    } catch (error) {
      this.update({ error: message(error) })
    }
  }

  async deleteActive(): Promise<void> {
    const active = this.snapshot.active
    if (active === null || !window.confirm(`Delete ${active.path}?`)) return
    try {
      await vaultApi.delete(active.path)
      this.update({ active: null, draft: '', error: null })
      this.panel.close()
      await this.refreshTree()
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
      const { results } = await vaultApi.search(query)
      if (this.snapshot.query === query) this.update({ searchResults: results, error: null })
    } catch (error) {
      this.update({ error: message(error) })
    }
  }

  async pollActive(): Promise<void> {
    const active = this.snapshot.active
    if (active === null || this.dirty || this.snapshot.saving) return
    try {
      const current = await vaultApi.note(active.path)
      if (current.modifiedMs !== active.modifiedMs) this.update({ active: current, draft: current.content })
    } catch (error) {
      this.update({ error: message(error) })
    }
  }

  private update(patch: Partial<VaultSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected vault error.'
}

function titleFromPath(path: string): string {
  return path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? 'Untitled'
}
