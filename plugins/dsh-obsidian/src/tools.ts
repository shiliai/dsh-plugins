import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { VaultAccess } from './vault-manager.ts'

interface PathArgs { path: string }
interface WriteArgs extends PathArgs { content: string; expectedModifiedMs?: number }
interface MoveArgs { from: string; to: string }
interface SearchArgs { query: string; prefix?: string }
interface ListArgs { cursor?: string; limit?: number; prefix?: string }
interface ListTagsArgs { query?: string }
interface TagSearchArgs { tag: string; includeDescendants?: boolean }
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

export function registerNoteTools(ctx: Context, vault: VaultAccess): void {
  ctx.tools.register(defineTool({
    name: 'obsidian_list_notes',
    description: 'List every Markdown note path in the current Obsidian vault.',
    parameters: {
      cursor: { type: 'string', description: 'Cursor returned by a previous page.' },
      limit: { type: 'integer', description: 'Maximum paths to return (1-500).' },
      prefix: { type: 'string', description: 'Optional vault-relative directory; only list Markdown notes recursively under it.' },
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
    execute: async (args: ListArgs) => vault.listNotePathsPage(args.cursor, args.limit, args.prefix),
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
    parameters: {
      query: { type: 'string', required: true, description: 'Case-insensitive search text.' },
      prefix: { type: 'string', description: 'Optional vault-relative directory; only search Markdown notes recursively under it.' },
    },
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
    execute: async (args: SearchArgs) => ({ results: await vault.searchNotes(args.query, args.prefix) }),
    presentCall: (args: SearchArgs) => ({ card: 'generic', kind: 'search', title: 'Search Obsidian notes', rawInput: args.query, locations: [] }),
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_list_tags',
    description: 'List Obsidian tags in the current vault. Tags come from Markdown bodies and YAML frontmatter; parent tags include descendant note counts.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive substring used to filter tag names.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tags: {
            type: 'array', required: true, items: {
              type: 'object', additionalProperties: false, properties: {
                name: { type: 'string', required: true },
                count: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args: ListTagsArgs, value: { tags: Array<{ name: string; count: number }> }) => [{
        type: 'text', text: value.tags.map(tag => `#${tag.name} (${tag.count})`).join('\n') || 'No tags found.',
      }],
    },
    isConcurrencySafe: () => true,
    execute: async (args: ListTagsArgs) => ({ tags: await vault.listTags(args.query) }),
    presentCall: (args: ListTagsArgs) => ({ card: 'generic', kind: 'search', title: 'List Obsidian tags', rawInput: args.query, locations: [] }),
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_search_by_tag',
    description: 'Find Markdown note paths carrying an Obsidian tag in the current vault. Parent tags include nested descendants by default.',
    parameters: {
      tag: { type: 'string', required: true, description: 'Tag name with or without the leading #.' },
      includeDescendants: { type: 'boolean', description: 'Include nested child tags. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { paths: { type: 'array', required: true, items: { type: 'string' } } },
      },
      render: (_args: TagSearchArgs, value: { paths: string[] }) => [{ type: 'text', text: value.paths.join('\n') || 'No matching notes found.' }],
    },
    isConcurrencySafe: () => true,
    execute: async (args: TagSearchArgs) => ({ paths: await vault.searchNotesByTag(args.tag, args.includeDescendants ?? true) }),
    presentCall: (args: TagSearchArgs) => ({ card: 'generic', kind: 'search', title: 'Search Obsidian tag', rawInput: args.tag, locations: [] }),
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
