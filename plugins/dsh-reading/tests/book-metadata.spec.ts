import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalLibrary } from '../src/library.ts'

let dir: string
let library: LocalLibrary

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-reading-meta-'))
  library = new LocalLibrary(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LocalLibrary metadata sidecar', () => {
  it('overlays title/author from metadata.json and keeps the raw metadata on the book', async () => {
    const imported = await library.importBook(Buffer.from('%PDF-1.4 fake'), 'Some.File.Name.pdf')
    expect(imported.title).toBe('Some File Name')

    const saved = await library.saveMetadata(imported.id, { title: '重写标题', author: '某作者', tags: ['甲', '乙'], summary: '概要' })
    expect(saved.title).toBe('重写标题')
    expect(saved.author).toBe('某作者')
    expect(saved.metadata).toMatchObject({ title: '重写标题', author: '某作者', tags: ['甲', '乙'], summary: '概要' })

    const listed = await library.listBooks({})
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ title: '重写标题', author: '某作者' })
    expect(listed[0]!.metadata?.tags).toEqual(['甲', '乙'])
  })

  it('merges partial patches and clears fields with empty strings', async () => {
    const imported = await library.importBook(Buffer.from('%PDF-1.4 fake'), 'merge-test.pdf')
    await library.saveMetadata(imported.id, { title: '标题', author: '作者', tags: ['旧标签'], summary: '旧概要' })

    const merged = await library.saveMetadata(imported.id, { summary: '新概要' })
    expect(merged.metadata).toMatchObject({ title: '标题', author: '作者', tags: ['旧标签'], summary: '新概要' })

    const cleared = await library.saveMetadata(imported.id, { author: '' })
    expect(cleared.metadata?.author).toBe('')
    // Empty author no longer overrides the derived value.
    expect(cleared.author).toBeUndefined()
    expect(cleared.title).toBe('标题')
  })

  it('clearing the title responds with the file-derived title, not the stale sidecar title', async () => {
    const imported = await library.importBook(Buffer.from('%PDF-1.4 fake'), 'clear-title-test.pdf')
    await library.saveMetadata(imported.id, { title: '自定义标题' })

    const cleared = await library.saveMetadata(imported.id, { title: '' })
    // listBooks overlays the sidecar title, so the response must fall back to
    // the file-derived title (what the next GET /library will show).
    expect(cleared.title).toBe('clear-title-test')
    expect((await library.listBooks({}))[0]!.title).toBe('clear-title-test')
  })

  it('clearing tags and summary with empty values works for every field', async () => {
    const imported = await library.importBook(Buffer.from('%PDF-1.4 fake'), 'clear-all.pdf')
    await library.saveMetadata(imported.id, { title: 'T', author: 'A', tags: ['X'], summary: 'S' })

    const clearedTags = await library.saveMetadata(imported.id, { tags: [] })
    expect(clearedTags.metadata?.tags).toEqual([])

    const clearedSummary = await library.saveMetadata(imported.id, { summary: '' })
    expect(clearedSummary.metadata?.summary).toBe('')

    const relisted = await library.listBooks({})
    expect(relisted[0]).toMatchObject({ title: 'T', author: 'A' })
    expect(relisted[0]!.metadata?.tags).toEqual([])
    expect(relisted[0]!.metadata?.summary).toBe('')
  })

  it('trims tags and drops empties', async () => {
    const imported = await library.importBook(Buffer.from('%PDF-1.4 fake'), 'tags-test.pdf')
    const saved = await library.saveMetadata(imported.id, { tags: [' 甲 ', '', '乙'] })
    expect(saved.metadata?.tags).toEqual(['甲', '乙'])
  })

  it('ignores malformed sidecars and reports unknown books', async () => {
    await library.importBook(Buffer.from('%PDF-1.4 fake'), 'broken-sidecar.pdf')
    const found = (await library.listBooks({}))[0]!
    const bookDir = dirname(found.filePath)
    await writeFile(join(bookDir, 'metadata.json'), '{not json', 'utf8')

    const listed = await library.listBooks({})
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('broken-sidecar')
    expect(listed[0]!.metadata).toBeUndefined()

    await expect(library.saveMetadata('local:missing', { title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('keeps progress attached when saving metadata', async () => {
    const imported = await library.importBook(Buffer.from('%PDF-1.4 fake'), 'progress-meta.pdf')
    const progress = { [imported.id]: { bookId: imported.id, locator: { type: 'pdf' as const, page: 3, scrollRatio: 0.5 }, percent: 0.4, updatedAt: new Date().toISOString() } }
    const saved = await library.saveMetadata(imported.id, { title: '带进度' }, progress)
    expect(saved.progress?.percent).toBe(0.4)
  })
})
