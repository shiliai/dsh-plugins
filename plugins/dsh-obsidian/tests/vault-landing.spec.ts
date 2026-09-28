import { describe, expect, it, vi } from 'vitest'
import { currentSessionIsBlank, landInVaultWorkspace, type VaultLandingContext } from '../src/client/vault-landing.ts'

const immediateWait = async (): Promise<void> => undefined

interface Harness {
  ctx: VaultLandingContext
  opened: string[]
  listState: { current: string | undefined; byId: Record<string, { blank: boolean }> }
  scoped: Set<string>
}

function harness(options: {
  current: string | undefined
  connectResult?: string | Promise<string>
  connectOn?: 'uiWorkspace' | 'workspaces' | 'both' | 'neither'
  listedSessions?: string[]
  scopedSessions?: string[]
} = { current: 'current-1' }): Harness {
  const opened: string[] = []
  // A listed session is materialized unless the test scopes explicitly.
  const scopedIds = options.scopedSessions
    ?? [...(options.listedSessions ?? []), ...(options.current === undefined ? [] : [options.current])]
  const scoped = new Set(scopedIds)
  const listState: { current: string | undefined; byId: Record<string, { blank: boolean }> } = {
    current: options.current,
    byId: { ...(options.current === undefined ? {} : { [options.current]: { blank: true } }) },
  }
  const connectFace = { connectWorkspace: async () => await Promise.resolve(options.connectResult ?? 'vault-session') }
  const ctx: VaultLandingContext = {
    uiWorkspace: options.connectOn === 'uiWorkspace' || options.connectOn === 'both' || options.connectOn === undefined ? connectFace : undefined,
    workspaces: options.connectOn === 'workspaces' || options.connectOn === 'both' ? connectFace : undefined,
    sessions: {
      list: { getSnapshot: () => listState },
      scope: (id: string) => (scoped.has(id) ? { id } : undefined),
      open: (id: string) => { opened.push(id); listState.current = id },
    },
  }
  // Sessions that become visible in the list immediately.
  for (const id of options.listedSessions ?? []) listState.byId[id] = { blank: true }
  return { ctx, opened, listState, scoped }
}

describe('currentSessionIsBlank', () => {
  it('treats a missing current session or missing summary as blank', () => {
    expect(currentSessionIsBlank({ current: undefined, byId: {} })).toBe(true)
    expect(currentSessionIsBlank({ current: 's1', byId: {} })).toBe(true)
    expect(currentSessionIsBlank({ current: 's1', byId: { s1: { blank: true } } })).toBe(true)
  })

  it('treats a conversation in progress as not blank', () => {
    expect(currentSessionIsBlank({ current: 's1', byId: { s1: { blank: false } } })).toBe(false)
  })
})

describe('landInVaultWorkspace', () => {
  it('connects, opens, and returns the landed session id', async () => {
    const { ctx, opened } = harness({ current: 'current-1', listedSessions: ['vault-session'] })
    const landed = await landInVaultWorkspace(ctx, 'w1', immediateWait)
    expect(landed).toBe('vault-session')
    expect(opened).toEqual(['vault-session'])
  })

  it('keeps the current conversation when connect returns it (already the vault blank session)', async () => {
    const { ctx, opened } = harness({ current: 'vault-session', connectResult: 'vault-session', listedSessions: ['vault-session'] })
    const landed = await landInVaultWorkspace(ctx, 'w1', immediateWait)
    expect(landed).toBe('vault-session')
    expect(opened).toEqual([])
  })

  it('prefers uiWorkspace over the rc.6 workspaces face', async () => {
    const seen: string[] = []
    const ctx = harness({ current: 'current-1', connectOn: 'both', listedSessions: ['vault-session'] }).ctx
    const uiConnect = ctx.uiWorkspace!.connectWorkspace
    ctx.uiWorkspace = { connectWorkspace: async (id: string) => { seen.push(id); return await uiConnect(id) } }
    await landInVaultWorkspace(ctx, 'w1', immediateWait)
    expect(seen).toEqual(['w1'])
  })

  it('falls back to the rc.6 workspaces face when uiWorkspace is absent', async () => {
    const { ctx, opened } = harness({ current: 'current-1', connectOn: 'workspaces', listedSessions: ['vault-session'] })
    const landed = await landInVaultWorkspace(ctx, 'w1', immediateWait)
    expect(landed).toBe('vault-session')
    expect(opened).toEqual(['vault-session'])
  })

  it('disables landing entirely when no connect face exists (rc.6 host without the moved face)', async () => {
    const { ctx, opened } = harness({ current: 'current-1', connectOn: 'neither' })
    const landed = await landInVaultWorkspace(ctx, 'w1', immediateWait)
    expect(landed).toBeUndefined()
    expect(opened).toEqual([])
  })

  it('returns undefined without navigating when the session never appears in the list', async () => {
    const { ctx, opened } = harness({ current: 'current-1', listedSessions: [] })
    const landed = await landInVaultWorkspace(ctx, 'w1', immediateWait)
    expect(landed).toBeUndefined()
    expect(opened).toEqual([])
    expect(ctx.sessions.list.getSnapshot().current).toBe('current-1')
  })

  it('reopens the original session when the new scope never materializes', async () => {
    const { ctx, opened } = harness({ current: 'current-1', listedSessions: ['vault-session'], scopedSessions: ['current-1'] })
    const landed = await landInVaultWorkspace(ctx, 'w1', immediateWait)
    expect(landed).toBeUndefined()
    expect(opened).toEqual(['vault-session', 'current-1'])
    expect(ctx.sessions.list.getSnapshot().current).toBe('current-1')
  })

  it('degrades to undefined when connectWorkspace rejects, without touching navigation', async () => {
    const { ctx, opened } = harness({ current: 'current-1' })
    ctx.uiWorkspace = { connectWorkspace: async () => { throw new Error('boom') } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const landed = await landInVaultWorkspace(ctx, 'w1', immediateWait)
    expect(landed).toBeUndefined()
    expect(opened).toEqual([])
    warn.mockRestore()
  })
})
