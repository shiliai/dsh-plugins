import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerNoteTools } from '../src/tools.ts'
import { VaultManager } from '../src/vault-manager.ts'

const roots: string[] = []

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
  presentCall?: (args: Record<string, unknown>) => unknown
}

async function fixture(): Promise<{ vault: VaultManager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-obsidian-tools-'))
  roots.push(root)
  await mkdir(join(root, 'Projects'), { recursive: true })
  await writeFile(join(root, 'Home.md'), '---\ntags: home\n---\n# Home\nWelcome to the vault.\n')
  await writeFile(join(root, 'Projects', 'Roadmap.md'), '# Roadmap\nShip the preview. #project/atlas\n')
  return { root, vault: await VaultManager.create(root, 4096, 20) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('registerNoteTools', () => {
  it('registers and executes every provider-visible vault operation', async () => {
    const { vault, root } = await fixture()
    const registered: RegisteredTool[] = []
    const context = {
      tools: {
        register: (tool: RegisteredTool) => registered.push(tool),
      },
    } as unknown as Context
    registerNoteTools(context, vault)

    expect(registered.map(tool => tool.name)).toEqual([
      'obsidian_list_notes',
      'obsidian_read_note',
      'obsidian_search_notes',
      'obsidian_list_tags',
      'obsidian_search_by_tag',
      'obsidian_write_note',
      'obsidian_move_note',
      'obsidian_delete_note',
    ])
    const tool = (name: string): RegisteredTool => {
      const found = registered.find(candidate => candidate.name === name)
      if (found === undefined) throw new Error(`Missing registered tool: ${name}`)
      return found
    }

    await expect(tool('obsidian_list_notes').execute({ limit: 1 })).resolves.toEqual({
      paths: ['Projects/Roadmap.md'], nextCursor: 'Projects/Roadmap.md',
    })
    await expect(tool('obsidian_list_notes').execute({ cursor: 'Projects/Roadmap.md', limit: 1 })).resolves.toEqual({
      paths: ['Home.md'],
    })
    await expect(tool('obsidian_read_note').execute({ path: 'Home.md' })).resolves.toMatchObject({
      path: 'Home.md', content: '---\ntags: home\n---\n# Home\nWelcome to the vault.\n',
    })
    await expect(tool('obsidian_search_notes').execute({ query: 'preview' })).resolves.toEqual({
      results: [{ path: 'Projects/Roadmap.md', line: 2, excerpt: 'Ship the preview. #project/atlas' }],
    })
    await expect(tool('obsidian_list_tags').execute({})).resolves.toEqual({
      tags: [
        { name: 'home', count: 1 },
        { name: 'project', count: 1 },
        { name: 'project/atlas', count: 1 },
      ],
    })
    await expect(tool('obsidian_search_by_tag').execute({ tag: '#project' })).resolves.toEqual({ paths: ['Projects/Roadmap.md'] })
    await expect(tool('obsidian_list_notes').execute({ prefix: 'Projects' })).resolves.toEqual({ paths: ['Projects/Roadmap.md'] })
    await expect(tool('obsidian_write_note').execute({ path: 'Daily/Today.md', content: '# Today' })).resolves.toEqual({
      message: 'Saved Daily/Today.md', path: 'Daily/Today.md',
    })
    expect(tool('obsidian_write_note').presentCall?.({ path: 'Create.md', content: '# Create' })).toMatchObject({ card: 'diff', title: 'Create Create.md' })
    expect(tool('obsidian_write_note').presentCall?.({ path: 'Create.md', content: '# Replace', expectedModifiedMs: 1 })).toMatchObject({ card: 'generic', title: 'Replace Create.md' })
    await expect(tool('obsidian_move_note').execute({ from: 'Daily/Today.md', to: 'Archive/Today.md' })).resolves.toEqual({
      message: 'Moved Daily/Today.md to Archive/Today.md', path: 'Archive/Today.md',
    })
    await expect(tool('obsidian_delete_note').execute({ path: 'Archive/Today.md' })).resolves.toEqual({
      message: 'Deleted Archive/Today.md', path: 'Archive/Today.md',
    })
    await expect(vault.readNote('Archive/Today.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const alternate = join(root, 'Alternate')
    await mkdir(alternate)
    await writeFile(join(alternate, 'Selected.md'), '# Selected')
    await vault.select(alternate)
    await expect(tool('obsidian_read_note').execute({ path: 'Selected.md' })).resolves.toMatchObject({
      path: 'Selected.md', content: '# Selected',
    })
    await expect(tool('obsidian_read_note').execute({ path: 'Home.md' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
