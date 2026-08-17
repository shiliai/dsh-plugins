import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { VaultService } from './vault-service.ts'

interface PathArgs { path: string }
interface WriteArgs extends PathArgs { content: string; expectedModifiedMs?: number }
interface MoveArgs { from: string; to: string }
interface SearchArgs { query: string }
interface ListArgs { cursor?: string; limit?: number }
interface SearchValue { results: { path: string; line: number; excerpt: string }[] }

const MESSAGE_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      message: { type: 'string' as const, required: true as const },
      path: { type: 'string' as const },
    },
  },
  render: (_args: unknown, value: { message: string }) => [{ type: 'text' as const, text: value.message }],
} as const

export function registerNoteTools(ctx: Context, vault: VaultService): void {
  ctx.tools.register(defineTool({
    name: 'obsidian_list_notes',
    description: 'List every Markdown note path in the current Obsidian vault.',
    parameters: {
      cursor: { type: 'string', description: 'Cursor returned by a previous page.' },
      limit: { type: 'integer', description: 'Maximum paths to return (1-500).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', required: true, items: { type: 'string' } },
          nextCursor: { type: 'string' },
        },
      },
      render: (_args: ListArgs, value: { paths: string[] }) => [{ type: 'text', text: value.paths.join('\n') || 'No notes found.' }],
    },
    isConcurrencySafe: () => true,
    execute: async (args: ListArgs) => vault.listNotePathsPage(args.cursor, args.limit),
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'List vault notes', locations: [] }),
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_read_note',
    description: 'Read one Markdown note from the current Obsidian vault using a vault-relative path.',
    parameters: { path: { type: 'string', required: true, description: 'Vault-relative .md path.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          modifiedMs: { type: 'number', required: true },
        },
      },
      render: (_args: PathArgs, value: { content: string }) => [{ type: 'text', text: value.content }],
    },
    isConcurrencySafe: () => true,
    execute: async (args: PathArgs) => {
      const note = await vault.readNote(args.path)
      return { path: note.path, content: note.content, modifiedMs: note.modifiedMs }
    },
    presentCall: (args: PathArgs) => ({ card: 'generic', kind: 'read', title: 'Read Obsidian note', rawInput: args.path, locations: [{ path: args.path }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_search_notes',
    description: 'Search note paths and Markdown content in the current Obsidian vault.',
    parameters: { query: { type: 'string', required: true, description: 'Case-insensitive search text.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array', required: true, items: {
              type: 'object', additionalProperties: false, properties: {
                path: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                excerpt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: SearchArgs, value: SearchValue) => [{ type: 'text', text: value.results.map(item => `${item.path}:${item.line}: ${item.excerpt}`).join('\n') || 'No matches.' }],
    },
    isConcurrencySafe: () => true,
    execute: async (args: SearchArgs) => ({ results: await vault.searchNotes(args.query) }),
    presentCall: (args: SearchArgs) => ({ card: 'generic', kind: 'search', title: 'Search Obsidian notes', rawInput: args.query, locations: [] }),
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_write_note',
    description: 'Create or replace a Markdown note in the current Obsidian vault. Use obsidian_read_note first before replacing an existing note.',
    parameters: {
      path: { type: 'string', required: true, description: 'Vault-relative .md path.' },
      content: { type: 'string', required: true, description: 'Complete Markdown content.' },
      expectedModifiedMs: { type: 'number', description: 'Required when replacing an existing note; use the value returned by obsidian_read_note.' },
    },
    output: MESSAGE_OUTPUT,
    execute: async (args: WriteArgs) => {
      const note = await vault.writeNote(args.path, args.content, args.expectedModifiedMs)
      return { message: `Saved ${note.path}`, path: note.path }
    },
    presentCall: (args: WriteArgs) => args.expectedModifiedMs === undefined
      ? { card: 'diff', title: `Create ${args.path}`, diffs: [{ path: args.path, oldText: null, newText: args.content }], locations: [{ path: args.path }] }
      : { card: 'generic', kind: 'write', title: `Replace ${args.path}`, rawInput: { path: args.path, expectedModifiedMs: args.expectedModifiedMs }, locations: [{ path: args.path }] },
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_move_note',
    description: 'Move or rename a Markdown note inside the current Obsidian vault without overwriting an existing note.',
    parameters: {
      from: { type: 'string', required: true, description: 'Existing vault-relative .md path.' },
      to: { type: 'string', required: true, description: 'New vault-relative .md path.' },
    },
    output: MESSAGE_OUTPUT,
    execute: async (args: MoveArgs) => {
      const note = await vault.moveNote(args.from, args.to)
      return { message: `Moved ${args.from} to ${note.path}`, path: note.path }
    },
    presentCall: (args: MoveArgs) => ({ card: 'generic', kind: 'move', title: 'Move Obsidian note', rawInput: { from: args.from, to: args.to }, locations: [{ path: args.from }, { path: args.to }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_delete_note',
    description: 'Permanently delete one Markdown note from the current Obsidian vault. Only call when the user explicitly requested deletion.',
    parameters: { path: { type: 'string', required: true, description: 'Vault-relative .md path.' } },
    output: MESSAGE_OUTPUT,
    execute: async (args: PathArgs) => {
      await vault.deleteNote(args.path)
      return { message: `Deleted ${args.path}`, path: args.path }
    },
    presentCall: (args: PathArgs) => ({ card: 'generic', kind: 'delete', title: 'Delete Obsidian note', rawInput: args.path, locations: [{ path: args.path }] }),
  }))
}
