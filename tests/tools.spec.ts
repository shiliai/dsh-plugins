import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerNoteTools } from '../src/tools.ts'
import { VaultService } from '../src/vault-service.ts'

const roots: string[] = []

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

async function fixture(): Promise<{ vault: VaultService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-obsidian-tools-'))
  roots.push(root)
  await mkdir(join(root, 'Projects'), { recursive: true })
  await writeFile(join(root, 'Home.md'), '# Home\nWelcome to the vault.\n')
  await writeFile(join(root, 'Projects', 'Roadmap.md'), '# Roadmap\nShip the preview.\n')
  return { root, vault: await VaultService.create(root, 4096, 20) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('registerNoteTools', () => {
  it('registers and executes every provider-visible vault operation', async () => {
    const { vault } = await fixture()
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
      'obsidian_write_note',
      'obsidian_move_note',
      'obsidian_delete_note',
    ])
    const tool = (name: string): RegisteredTool => {
      const found = registered.find(candidate => candidate.name === name)
      if (found === undefined) throw new Error(`Missing registered tool: ${name}`)
      return found
    }

    await expect(tool('obsidian_list_notes').execute({})).resolves.toEqual({
      paths: ['Projects/Roadmap.md', 'Home.md'],
    })
    await expect(tool('obsidian_read_note').execute({ path: 'Home.md' })).resolves.toMatchObject({
      path: 'Home.md', content: '# Home\nWelcome to the vault.\n',
    })
    await expect(tool('obsidian_search_notes').execute({ query: 'preview' })).resolves.toEqual({
      results: [{ path: 'Projects/Roadmap.md', line: 2, excerpt: 'Ship the preview.' }],
    })
    await expect(tool('obsidian_write_note').execute({ path: 'Daily/Today.md', content: '# Today' })).resolves.toEqual({
      message: 'Saved Daily/Today.md', path: 'Daily/Today.md',
    })
    await expect(tool('obsidian_move_note').execute({ from: 'Daily/Today.md', to: 'Archive/Today.md' })).resolves.toEqual({
      message: 'Moved Daily/Today.md to Archive/Today.md', path: 'Archive/Today.md',
    })
    await expect(tool('obsidian_delete_note').execute({ path: 'Archive/Today.md' })).resolves.toEqual({
      message: 'Deleted Archive/Today.md', path: 'Archive/Today.md',
    })
    await expect(vault.readNote('Archive/Today.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
