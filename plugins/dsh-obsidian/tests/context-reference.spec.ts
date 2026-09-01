import { describe, expect, it } from 'vitest'
import { appendVaultContext, formatVaultContext } from '../src/client/context-reference.ts'

describe('vault context references', () => {
  it('formats note and recursive directory scopes with validated absolute paths', () => {
    expect(formatVaultContext({
      kind: 'directory', vaultRoot: '/vault', value: 'Projects', absolutePath: '/vault/Projects', entries: [],
    })).toBe('[Obsidian context]\ntype: directory\nvault: "/vault"\ndirectory: "Projects"\nabsolutePath: "/vault/Projects"\nrecursive: true')
  })

  it('freezes tag and search result file lists in the draft', () => {
    const reference = {
      kind: 'tag' as const,
      vaultRoot: '/vault',
      value: 'project',
      entries: [{ path: 'Project.md', absolutePath: '/vault/Project.md' }],
    }
    expect(appendVaultContext('Summarize this', reference)).toContain('Summarize this\n\n[Obsidian context]')
    expect(formatVaultContext(reference)).toContain('files:\n- absolutePath: "/vault/Project.md"; vaultRelativePath: "Project.md"')
  })
})
