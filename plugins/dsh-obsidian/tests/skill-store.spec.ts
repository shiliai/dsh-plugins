import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSkillInput } from '../src/contracts.ts'
import { SkillStore } from '../src/skill-store.ts'

const roots: string[] = []

function input(overrides: Partial<AgentSkillInput> = {}): AgentSkillInput {
  return {
    name: 'vault-summary',
    description: '结合 vault 笔记生成总结',
    whenToUse: '需要结合 vault 知识总结时',
    modelInvocable: true,
    userInvocable: true,
    instructions: '1. 检索相关笔记\n2. 读取\n3. 总结',
    ...overrides,
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-obsidian-skill-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SkillStore', () => {
  it('creates a skill, writes SKILL.md, and lists it', async () => {
    const store = new SkillStore(await tempRoot())
    expect((await store.list()).skills).toHaveLength(0)

    const doc = await store.create(input())
    expect(doc.name).toBe('vault-summary')
    expect(doc.revision).toMatch(/^[0-9a-f]{64}$/)
    expect((await store.list()).skills).toHaveLength(1)

    const raw = await readFile(join(await store.root, 'vault-summary', 'SKILL.md'), 'utf8')
    expect(raw).toContain('name: vault-summary')
    expect(raw).toContain('1. 检索相关笔记')
  })

  it('rejects a duplicate skill name with a collision error', async () => {
    const store = new SkillStore(await tempRoot())
    await store.create(input())
    await expect(store.create(input())).rejects.toThrow('already exists')
  })

  it('rejects an invalid skill name', async () => {
    const store = new SkillStore(await tempRoot())
    await expect(store.create(input({ name: 'Bad Name' }))).rejects.toThrow('Skill name must contain lowercase')
    await expect(store.create(input({ name: '' }))).rejects.toThrow('required')
  })

  it('requires a description and instructions', async () => {
    const store = new SkillStore(await tempRoot())
    await expect(store.create(input({ description: '  ' }))).rejects.toThrow('required')
    await expect(store.create(input({ instructions: '   ' }))).rejects.toThrow('required')
  })

  it('updates content only with a matching revision (optimistic lock)', async () => {
    const store = new SkillStore(await tempRoot())
    const doc = await store.create(input())
    const updated = await store.update(doc.name, doc.revision, input({ description: '新描述' }))
    expect(updated.description).toBe('新描述')
    await expect(
      store.update(doc.name, doc.revision, input({ description: '陈旧' })),
    ).rejects.toThrow('changed since it was loaded')
  })

  it('renames while preserving content and rejects collisions', async () => {
    const store = new SkillStore(await tempRoot())
    const doc = await store.create(input())
    const renamed = await store.update(doc.name, doc.revision, input({ name: 'renamed-skill' }))
    expect(renamed.name).toBe('renamed-skill')
    await store.create(input({ name: 'other-skill' }))
    const other = await store.list()
    const otherDoc = other.skills.find(s => s.name === 'other-skill')
    expect(otherDoc).toBeDefined()
    await expect(
      store.update('renamed-skill', renamed.revision, input({ name: 'other-skill' })),
    ).rejects.toThrow('already exists')
  })

  it('deletes with a matching revision', async () => {
    const store = new SkillStore(await tempRoot())
    const doc = await store.create(input())
    await store.delete(doc.name, doc.revision)
    expect((await store.list()).skills).toHaveLength(0)
    // A second delete against the now-missing package reports not found.
    await expect(store.delete(doc.name, doc.revision)).rejects.toThrow('SKILL.md not found')
  })

  it('reports diagnostics for malformed skill packages instead of failing', async () => {
    const root = await tempRoot()
    const store = new SkillStore(root)
    await store.create(input())
    // Corrupt the frontmatter.
    const dir = join(store.root, 'vault-summary')
    await mkdir(dir, { recursive: true })
    await store.create(input({ name: 'good-skill' }))
    await writeFile(join(store.root, 'vault-summary', 'SKILL.md'), 'not frontmatter', 'utf8')
    const result = await store.list()
    expect(result.skills.map(s => s.name)).toEqual(['good-skill'])
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]?.directoryPath).toBe('.agents/skills/vault-summary')
  })
})
