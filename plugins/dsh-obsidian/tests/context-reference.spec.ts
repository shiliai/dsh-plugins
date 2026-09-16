import { describe, expect, it } from 'vitest'
import { appendVaultContext, formatVaultContext } from '../src/client/context-reference.ts'

describe('vault context references', () => {
  it('formats note and recursive directory scopes with validated absolute paths', () => {
    expect(formatVaultContext({
      kind: 'directory', vaultRoot: '/vault', value: 'Projects', absolutePath: '/vault/Projects', entries: [],
    })).toContain('[Reading context]\nsource: "obsidian-vault"')
    expect(formatVaultContext({
      kind: 'directory', vaultRoot: '/vault', value: 'Projects', absolutePath: '/vault/Projects', entries: [],
    })).toContain('absolutePath: "/vault/Projects"')
  })

  it('freezes tag and search result file lists in the draft', () => {
    const reference = {
      kind: 'tag' as const,
      vaultRoot: '/vault',
      value: 'project',
      entries: [{ path: 'Project.md', absolutePath: '/vault/Project.md' }],
    }
    expect(appendVaultContext('Summarize this', reference)).toContain('Summarize this\n\n[Reading context]')
    expect(formatVaultContext(reference)).toContain('absolutePath: "/vault/Project.md"')
  })
})
