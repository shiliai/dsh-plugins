import { describe, expect, it } from 'vitest'
import { inferWorkspaceState, samePath, vaultWorkspaceTitle, type WorkspaceSummary } from '../src/client/workspace-status.ts'

const vaultWorkspace = (overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  workspaceId: 'ws-vault',
  path: '/Users/chris/obsidian/MyVault',
  title: 'MyVault',
  sessionIds: ['sess-1'],
  ...overrides,
})

describe('samePath', () => {
  it('is case-insensitive and ignores trailing slashes', () => {
    expect(samePath('/Users/chris/obsidian/MyVault', '/users/chris/obsidian/MyVault/')).toBe(true)
    expect(samePath('/a/b', '/a/b/')).toBe(true)
  })
  it('rejects empty and different paths', () => {
    expect(samePath('', '/a')).toBe(false)
    expect(samePath('/a', '')).toBe(false)
    expect(samePath('/a/b', '/a/c')).toBe(false)
  })
})

describe('inferWorkspaceState', () => {
  it('uses the session cwd as the primary source', () => {
    const input = { vaultRoot: '/vault', currentSessionId: 's1', sessionCwd: '/vault', workspaces: [vaultWorkspace({ path: '/vault' })] }
    expect(inferWorkspaceState({ ...input, sessionCwd: '/vault' })).toBe('vault')
    expect(inferWorkspaceState({ ...input, sessionCwd: '/elsewhere' })).toBe('other')
  })

  it('falls back to workspace group membership when cwd is unknown', () => {
    const workspaces = [vaultWorkspace({ path: '/vault', sessionIds: ['s1'] })]
    expect(inferWorkspaceState({ vaultRoot: '/vault', currentSessionId: 's1', sessionCwd: undefined, workspaces })).toBe('vault')
    expect(inferWorkspaceState({ vaultRoot: '/vault', currentSessionId: 's2', sessionCwd: undefined, workspaces })).toBe('unknown')
  })

  it('is unknown without a vault root or any source', () => {
    expect(inferWorkspaceState({ vaultRoot: '', currentSessionId: 's1', sessionCwd: '/vault', workspaces: [] })).toBe('unknown')
    expect(inferWorkspaceState({ vaultRoot: '/vault', currentSessionId: undefined, sessionCwd: undefined, workspaces: undefined })).toBe('unknown')
    expect(inferWorkspaceState({ vaultRoot: '/vault', currentSessionId: 's1', sessionCwd: undefined, workspaces: undefined })).toBe('unknown')
  })
})

describe('vaultWorkspaceTitle', () => {
  it('names the workspace Obsidian · basename', () => {
    expect(vaultWorkspaceTitle('/Users/chris/obsidian/MyVault', [])).toBe('Obsidian · MyVault')
  })
  it('appends the parent directory when the base is taken', () => {
    expect(vaultWorkspaceTitle('/Users/chris/obsidian/notes', ['dsh-plugins', 'Obsidian · notes'])).toBe('Obsidian · notes (obsidian)')
    expect(vaultWorkspaceTitle('/notes', ['Obsidian · notes'])).toBe('Obsidian · notes')
  })
  it('keeps a free base untouched', () => {
    expect(vaultWorkspaceTitle('/a/notes', ['Obsidian · other'])).toBe('Obsidian · notes')
  })
})
