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
})
