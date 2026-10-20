import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VaultService } from '../src/vault-service.ts'

const roots: string[] = []

async function fixture(maxNoteBytes = 4096): Promise<{ root: string; vault: VaultService }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-obsidian-property-'))
  roots.push(root)
  await mkdir(join(root, 'Projects', 'Deep'), { recursive: true })
  await writeFile(join(root, 'Projects', 'Roadmap.md'), '')
  await writeFile(join(root, 'Projects', '.hidden.md'), '')
  await writeFile(join(root, 'Home.md'), '---\ntags: home\n---\n# Home\nWelcome to the vault. #welcome\n')
  return { root, vault: await VaultService.create(root, maxNoteBytes, 20) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('VaultService.resolveEntry', () => {
  it('returns the canonical absolute path and entry kind', async () => {
    const { root, vault } = await fixture()
    expect(await vault.resolveEntry('Projects/Roadmap.md')).toEqual({
      path: 'Projects/Roadmap.md',
      absolutePath: join(vault.root, 'Projects', 'Roadmap.md'),
      kind: 'note',
    })
    expect(await vault.resolveEntry('Projects')).toEqual({
      path: 'Projects',
      absolutePath: join(vault.root, 'Projects'),
      kind: 'directory',
    })
  })

  it('rejects escaping, missing and symlinked entries', async () => {
    const { root, vault } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-obsidian-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'Elsewhere.md'), '# Elsewhere\n')
    await symlink(join(outside, 'Elsewhere.md'), join(root, 'Link.md'))

    await expect(vault.resolveEntry('../escape.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(vault.resolveEntry('Missing.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(vault.resolveEntry('Link.md')).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
  })
})

describe('VaultService.inspectEntry', () => {
  it('reports note metadata, text statistics and tags', async () => {
    const { root, vault } = await fixture()
    const content = '---\ntags: home\n---\n# Home\nWelcome to the vault. #welcome\n'
    const property = await vault.inspectEntry('Home.md')

    expect(property).toMatchObject({
      path: 'Home.md',
      name: 'Home.md',
      kind: 'note',
      absolutePath: join(vault.root, 'Home.md'),
      size: Buffer.byteLength(content),
      lines: 5,
      words: 11,
      characters: [...content].length,
      tags: ['home', 'welcome'],
    })
    expect(property.permissions).toMatch(/^-[rwx-]{9}$/u)
    expect(property.createdMs).toBeGreaterThan(0)
    expect(property.modifiedMs).toBeGreaterThan(0)
    expect(property.accessedMs).toBeGreaterThan(0)
    // Note statistics are note-only; directory counts stay absent.
    expect(property.files).toBeUndefined()
    expect(property.directories).toBeUndefined()
  })

  it('counts visible directory children without hidden entries', async () => {
    const { vault } = await fixture()
    const property = await vault.inspectEntry('Projects')
    expect(property).toMatchObject({
      path: 'Projects',
      name: 'Projects',
      kind: 'directory',
      files: 1,
      directories: 1,
    })
    expect(property.lines).toBeUndefined()
    expect(property.words).toBeUndefined()
    expect(property.tags).toBeUndefined()
    expect(property.permissions).toMatch(/^d[rwx-]{9}$/u)
  })

  it('omits text statistics for a note above maxNoteBytes', async () => {
    const { root, vault } = await fixture(10)
    await writeFile(join(root, 'Big.md'), '# Big\n'.repeat(20))
    const property = await vault.inspectEntry('Big.md')
    expect(property.kind).toBe('note')
    expect(property.size).toBeGreaterThan(10)
    expect(property.lines).toBeUndefined()
    expect(property.words).toBeUndefined()
    expect(property.tags).toBeUndefined()
  })

  it('surfaces missing entries as NOT_FOUND', async () => {
    const { vault } = await fixture()
    await expect(vault.inspectEntry('Nowhere.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
