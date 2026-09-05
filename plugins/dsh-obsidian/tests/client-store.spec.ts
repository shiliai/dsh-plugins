import { describe, expect, it } from 'vitest'
import { VaultStore } from '../src/client/store.ts'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(innerResolve => { resolve = innerResolve }), resolve }
}

const home = { path: 'Home.md', absolutePath: '/vault/Home.md', content: '# Home', modifiedMs: 1, size: 6 }
const roadmap = { path: 'Projects/Roadmap.md', absolutePath: '/vault/Projects/Roadmap.md', content: '# Roadmap', modifiedMs: 1, size: 9 }

function apiWithNotes(notes: Array<Promise<typeof home>>) {
  return {
    info: async () => ({ name: 'Vault', root: '/vault' }),
    directories: async () => ({ path: '/vault', parent: '/', directories: [] }),
    selectVault: async (root: string) => ({ name: root.split('/').at(-1) ?? root, root }),
    tree: async () => ({ nodes: [] }),
    note: async () => {
      const next = notes.shift()
      if (next === undefined) throw new Error('unexpected note read')
      return next
    },
    search: async () => ({ results: [] }),
    tags: async () => ({ tags: [] as Array<{ name: string; count: number }> }),
    tag: async () => ({ paths: [] as string[] }),
    write: async () => home,
    move: async () => home,
    delete: async () => undefined,
  }
}

describe('VaultStore request generations', () => {
  it('browses and switches vaults while clearing state from the previous vault', async () => {
    let closed = 0
    const api = apiWithNotes([Promise.resolve(home)])
    api.directories = async () => ({ path: '/vaults/Next', parent: '/vaults', directories: [] })
    api.selectVault = async () => ({ name: 'Next', root: '/vaults/Next' })
    const store = new VaultStore({ open() {}, close() { closed++ } }, api)
    await store.openNote('Home.md')
    await store.search('home')
    await store.openVaultChooser()
    expect(store.getSnapshot().directoryListing?.path).toBe('/vaults/Next')

    await store.selectVault('/vaults/Next')
    expect(store.getSnapshot()).toMatchObject({
      vaultName: 'Next', vaultRoot: '/vaults/Next', active: null, draft: '', query: '', directoryListing: null,
    })
    expect(closed).toBe(1)
  })

  it('does not open the vault chooser with unsaved note changes', async () => {
    const api = apiWithNotes([Promise.resolve(home)])
    const store = new VaultStore({ open() {}, close() {} }, api)
    await store.openNote('Home.md')
    store.setDraft('# Unsaved')
    await store.openVaultChooser()
    expect(store.getSnapshot().directoryListing).toBeNull()
    expect(store.getSnapshot().error).toContain('Save or discard')
  })

  it('allows the workbench to switch tabs while retaining a dirty draft', async () => {
    const api = apiWithNotes([Promise.resolve(home), Promise.resolve(roadmap), Promise.resolve(home)])
    const store = new VaultStore({ open() {}, close() {} }, api)
    await store.openNote('Home.md')
    store.setDraft('# Draft kept in tab')
    await store.openNote('Projects/Roadmap.md', { allowDirty: true })
    expect(store.getSnapshot().active?.path).toBe('Projects/Roadmap.md')
    await store.openNote('Home.md', { allowDirty: true })
    expect(store.getSnapshot().draft).toBe(home.content)
  })

  it('keeps typing during a pending save and remains dirty after its completion', async () => {
    const save = deferred<typeof home>()
    const api = apiWithNotes([Promise.resolve(home)])
    api.write = async () => save.promise
    const store = new VaultStore({ open() {}, close() {} }, api)
    await store.openNote('Home.md')
    store.setDraft('# Saved request')
    const pending = store.save()
    store.setDraft('# Typed while saving')
    save.resolve({ ...home, content: '# Saved request', modifiedMs: 2, size: 15 })
    await pending
    expect(store.getSnapshot().draft).toBe('# Typed while saving')
    expect(store.dirty).toBe(true)
  })

  it('ignores a pending poll after a user starts typing', async () => {
    const poll = deferred<typeof home>()
    const api = apiWithNotes([Promise.resolve(home), poll.promise])
    const store = new VaultStore({ open() {}, close() {} }, api)
    await store.openNote('Home.md')
    const pending = store.pollActive()
    store.setDraft('# Typed while polling')
    poll.resolve({ ...home, content: '# External', modifiedMs: 2, size: 10 })
    await pending
    expect(store.getSnapshot().draft).toBe('# Typed while polling')
    expect(store.dirty).toBe(true)
  })

  it('clears saving when a pending save is invalidated by closing the note', async () => {
    const save = deferred<typeof home>()
    const api = apiWithNotes([Promise.resolve(home)])
    api.write = async () => save.promise
    const store = new VaultStore({ open() {}, close() {} }, api)
    await store.openNote('Home.md')
    store.setDraft('# Pending')
    const pending = store.save()
    store.setDraft(home.content)
    store.closeNote()
    expect(store.getSnapshot().saving).toBe(false)
    save.resolve({ ...home, content: '# Pending', modifiedMs: 2 })
    await pending
    expect(store.getSnapshot().active).toBeNull()
    expect(store.getSnapshot().saving).toBe(false)
  })

  it('loads the tag index and nested-tag note paths as a separate vault view', async () => {
    const api = apiWithNotes([])
    api.tags = async () => ({ tags: [{ name: 'project', count: 2 }] })
    api.tag = async () => ({ paths: ['Projects/One.md', 'Projects/Two.md'] })
    const store = new VaultStore({ open() {}, close() {} }, api)

    store.setView('tags')
    await store.refreshTags()
    await store.selectTag('project')
    expect(store.getSnapshot()).toMatchObject({
      view: 'tags', selectedTag: 'project', tagPaths: ['Projects/One.md', 'Projects/Two.md'],
      tags: [{ name: 'project', count: 2 }],
    })
    store.clearSelectedTag()
    expect(store.getSnapshot().selectedTag).toBeNull()
  })
})
