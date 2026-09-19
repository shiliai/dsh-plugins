import { afterEach, describe, expect, it, vi } from 'vitest'
import { readingApi } from '../src/client/api.ts'

afterEach(() => vi.unstubAllGlobals())

describe('reading client API', () => {
  it('accepts a 204 response for annotation deletion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(readingApi.removeAnnotation('annotation-1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/dsh-reading/api/annotations/annotation-1', { method: 'DELETE' })
  })
})

describe('ReadingStore.applyBook', () => {
  const baseBook = {
    id: 'local:abc',
    source: 'local' as const,
    title: '旧标题',
    author: '旧作者',
    format: 'pdf' as const,
    fileName: 'abc.pdf',
    fileSize: 10,
    addedAt: '2026-01-01T00:00:00.000Z',
  }

  it('replaces the entry so server-cleared keys disappear from the store', async () => {
    const { ReadingStore } = await import('../src/client/store.ts')
    const store = new ReadingStore()
    // Seed the list through the public API path: refresh() reads /library.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ books: [{ ...baseBook, progress: { abc: { page: 1 } } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await store.refresh()

    // The server cleared the author (key omitted) and renamed the title.
    const { author: _dropped, ...withoutAuthor } = baseBook
    const saved = { ...withoutAuthor, title: '新标题', metadata: { updatedAt: '2026-01-02T00:00:00.000Z' } }
    store.openBook({ ...baseBook })
    store.applyBook(saved)

    const { books, current } = store.snapshot
    expect(books[0]).toEqual(saved)
    expect(books[0]).not.toHaveProperty('author')
    expect(current).toEqual(saved)
  })

  it('leaves unrelated books untouched', async () => {
    const { ReadingStore } = await import('../src/client/store.ts')
    const store = new ReadingStore()
    const other = { ...baseBook, id: 'local:other', title: '其他' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ books: [{ ...baseBook }, other] }), { status: 200 })))
    await store.refresh()

    store.applyBook({ ...baseBook, title: '更新' })
    expect(store.snapshot.books.find(item => item.id === 'local:other')).toEqual(other)
  })
})
