import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReadingStateStore } from '../src/state-store.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-reading-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ReadingStateStore', () => {
  it('persists progress across reopen', async () => {
    const store = await ReadingStateStore.create(dir)
    await store.setProgress({
      bookId: 'local:abc',
      locator: { type: 'epub', cfi: 'epubcfi(/6/4!/2/2)', chapterHref: 'ch1.xhtml' },
      percent: 0.42,
      updatedAt: new Date().toISOString(),
    })
    const reopened = await ReadingStateStore.create(dir)
    expect(reopened.getProgress('local:abc')?.percent).toBe(0.42)
    expect(reopened.getProgress('local:abc')?.locator).toEqual({ type: 'epub', cfi: 'epubcfi(/6/4!/2/2)', chapterHref: 'ch1.xhtml' })
  })

  it('survives corrupt state.json', async () => {
    await readFile(join(dir, 'state.json'), 'utf8').catch(() => undefined)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'state.json'), 'not json{', 'utf8')
    const store = await ReadingStateStore.create(dir)
    expect(store.snapshot.progress).toEqual({})
    await store.setProgress({ bookId: 'x', locator: { type: 'article', scrollRatio: 0.5 }, percent: 0.5, updatedAt: 't' })
    expect((await readFile(join(dir, 'state.json'), 'utf8')).includes('"x"')).toBe(true)
  })

  it('clamps annotation add/remove and sorts by createdAt', async () => {
    const store = await ReadingStateStore.create(dir)
    await store.addAnnotation({ id: 'b', bookId: 'b1', locator: { type: 'epub', cfi: 'c2', chapterHref: '' }, quote: 'q2', color: 'green', createdAt: '2026-01-02' })
    await store.addAnnotation({ id: 'a', bookId: 'b1', locator: { type: 'epub', cfi: 'c1', chapterHref: '' }, quote: 'q1', color: 'yellow', createdAt: '2026-01-01' })
    expect(store.listAnnotations('b1').map(a => a.id)).toEqual(['a', 'b'])
    expect(await store.removeAnnotation('a')).toBe(true)
    expect(await store.removeAnnotation('a')).toBe(false)
    expect(store.listAnnotations('b1')).toHaveLength(1)
  })

  it('serializes concurrent updates', async () => {
    const store = await ReadingStateStore.create(dir)
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.setProgress({
      bookId: `b${i}`, locator: { type: 'article', scrollRatio: 0 }, percent: i / 100, updatedAt: 't',
    })))
    const reopened = await ReadingStateStore.create(dir)
    expect(Object.keys(reopened.snapshot.progress)).toHaveLength(20)
  })
})
