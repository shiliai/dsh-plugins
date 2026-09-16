import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ScopedSkillProvider, SkillStore } from '../src/index.ts'

describe('scoped skill provider', () => {
  it('publishes the source scope with candidates and definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-reading-core-'))
    const store = new SkillStore(root)
    await store.create({ name: 'summarize', description: 'Summarize reading', modelInvocable: true, userInvocable: true, instructions: 'Read the selected source first.' })
    const provider = new ScopedSkillProvider('reading-workspace', store, 'reading', 'Reading workspace', false)
    const [candidate] = await provider.list({})
    expect(candidate?.scope).toMatchObject({ id: 'reading', label: 'Reading workspace', writable: false })
    const definition = candidate === undefined ? undefined : await provider.get(candidate, {})
    expect(definition?.content).toContain('Read the selected source first.')
  })
})
