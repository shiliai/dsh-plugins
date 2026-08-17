import { describe, expect, it } from 'vitest'
import { VaultStore } from '../src/client/store.ts'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(innerResolve => { resolve = innerResolve }), resolve }
}

const home = { path: 'Home.md', content: '# Home', modifiedMs: 1, size: 6 }

function apiWithNotes(notes: Array<Promise<typeof home>>) {
  return {
    info: async () => ({ name: 'Vault', root: '/vault' }),
    tree: async () => ({ nodes: [] }),
    note: async () => {
      const next = notes.shift()
      if (next === undefined) throw new Error('unexpected note read')
      return next
    },
    search: async () => ({ results: [] }),
    write: async () => home,
    move: async () => home,
    delete: async () => undefined,
  }
}

describe('VaultStore request generations', () => {
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
})
