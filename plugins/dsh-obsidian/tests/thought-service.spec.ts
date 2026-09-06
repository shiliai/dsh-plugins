import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ThoughtService } from '../src/thought-service.ts'

describe('ThoughtService', () => {
  it('persists, filters, updates, and moves individual thoughts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-thoughts-')); const service = new ThoughtService(root)
    const first = await service.create('Capture release notes', '2026-09-06'); await service.create('Buy milk', '2026-09-06')
    expect((await service.list()).map(item => item.text)).toEqual(['Buy milk', 'Capture release notes'])
    await service.update(first.id, 'done'); expect((await service.list({ status: 'done' }))[0]?.text).toBe('Capture release notes')
    await service.archive(first.id); expect((await service.list()).some(item => item.id === first.id)).toBe(false)
    expect(await readFile(join(root, '.archive/2026-09-06.md'), 'utf8')).toContain(first.id)
    await service.restore(first.id); expect((await service.list()).some(item => item.id === first.id)).toBe(true)
  })
})
