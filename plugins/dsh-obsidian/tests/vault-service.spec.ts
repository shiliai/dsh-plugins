import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VaultError, VaultService } from '../src/vault-service.ts'

const roots: string[] = []

async function fixture(): Promise<{ root: string; vault: VaultService }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-obsidian-'))
  roots.push(root)
  await mkdir(join(root, 'Projects'), { recursive: true })
  await writeFile(join(root, 'Home.md'), '# Home\nWelcome to the vault.\n')
  await writeFile(join(root, 'Projects', 'Roadmap.md'), '# Roadmap\nShip the preview.\n')
  return { root, vault: await VaultService.create(root, 4096, 20) }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('VaultService', () => {
  it('lists, reads, writes, searches, moves, and deletes Markdown notes', async () => {
    const { root, vault } = await fixture()
    expect(await vault.listNotePaths()).toEqual(['Projects/Roadmap.md', 'Home.md'])
    expect((await vault.readNote('Home.md')).content).toContain('Welcome')

    const created = await vault.writeNote('Daily/Today.md', '# Today\nOne task')
    expect(created.path).toBe('Daily/Today.md')
    expect(await readFile(join(root, 'Daily', 'Today.md'), 'utf8')).toContain('One task')
    expect(await vault.searchNotes('preview')).toEqual([
      { path: 'Projects/Roadmap.md', line: 2, excerpt: 'Ship the preview.' },
    ])

    const moved = await vault.moveNote('Daily/Today.md', 'Archive/Today.md')
    expect(moved.path).toBe('Archive/Today.md')
    await vault.deleteNote('Archive/Today.md')
    await expect(vault.readNote('Archive/Today.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects traversal, absolute paths, non-Markdown files, and oversized content', async () => {
    const { vault } = await fixture()
    const rejected = ['../outside.md', '/tmp/outside.md', 'nested//note.md', 'note.txt']
    for (const path of rejected) {
      await expect(vault.writeNote(path, 'x')).rejects.toBeInstanceOf(VaultError)
    }
    await expect(vault.writeNote('large.md', 'x'.repeat(4097))).rejects.toMatchObject({ code: 'NOTE_TOO_LARGE' })
  })

  it('rejects symlinks that leave the vault for reads and creates', async () => {
    const { root, vault } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-obsidian-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'Secret.md'), 'secret')
    await symlink(outside, join(root, 'Escape'))

    await expect(vault.readNote('Escape/Secret.md')).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
    await expect(vault.writeNote('Escape/New.md', 'nope')).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
    expect(await vault.listNotePaths()).not.toContain('Escape/Secret.md')
  })

  it('detects stale saves using the observed modification time', async () => {
    const { vault } = await fixture()
    const note = await vault.readNote('Home.md')
    await vault.writeNote('Home.md', '# Changed elsewhere', note.modifiedMs)
    await expect(vault.writeNote('Home.md', '# Stale editor', note.modifiedMs))
      .rejects.toMatchObject({ code: 'NOTE_CONFLICT', status: 409 })
  })

  it('serializes concurrent replacements and never overwrites a concurrent move target', async () => {
    const { vault } = await fixture()
    const note = await vault.readNote('Home.md')
    const writes = await Promise.allSettled([
      vault.writeNote('Home.md', '# First', note.modifiedMs),
      vault.writeNote('Home.md', '# Second', note.modifiedMs),
    ])
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1)

    await vault.writeNote('One.md', '# One')
    await vault.writeNote('Two.md', '# Two')
    const moves = await Promise.allSettled([
      vault.moveNote('One.md', 'Target.md'),
      vault.moveNote('Two.md', 'Target.md'),
    ])
    expect(moves.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(moves.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await vault.readNote('Target.md')).content).toMatch(/^# (One|Two)$/u)
  })

  it('keeps searching past oversized notes and preserves only round-trippable paths', async () => {
    const { root, vault } = await fixture()
    await writeFile(join(root, 'Large.md'), 'needle '.repeat(700))
    await writeFile(join(root, ' Later.md'), 'needle here')
    await writeFile(join(root, 'slash\\name.md'), 'hidden')
    expect(await vault.searchNotes('needle')).toContainEqual({ path: ' Later.md', line: 1, excerpt: 'needle here' })
    expect(await vault.listNotePaths()).toContain(' Later.md')
    expect(await vault.listNotePaths()).not.toContain('slash\\name.md')
    await expect(vault.readNote('slash\\name.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('never follows symlinks for note reads, assets, tree traversal, or mutations', async () => {
    const { root, vault } = await fixture()
    await mkdir(join(root, 'Assets'))
    await writeFile(join(root, 'Assets', 'image.png'), 'png')
    await symlink(join(root, 'Projects'), join(root, 'Alias'))
    await symlink(join(root, 'Assets', 'image.png'), join(root, 'Alias.png'))

    await expect(vault.readNote('Alias/Roadmap.md')).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
    await expect(vault.openAsset('Alias.png')).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
    await expect(vault.writeNote('Alias/New.md', 'no')).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
    expect(await vault.listNotePaths()).not.toContain('Alias/Roadmap.md')
  })

  it('returns note and asset metadata from opened handles', async () => {
    const { root, vault } = await fixture()
    await mkdir(join(root, 'Assets'))
    await writeFile(join(root, 'Assets', 'image.png'), 'png')
    const note = await vault.readNote('Home.md')
    expect(note.size).toBe(Buffer.byteLength(note.content))
    const asset = await vault.openAsset('Assets/image.png')
    try {
      expect(asset.size).toBe(3)
      expect(await asset.handle.readFile({ encoding: 'utf8' })).toBe('png')
    } finally {
      await asset.handle.close()
    }
  })
})
