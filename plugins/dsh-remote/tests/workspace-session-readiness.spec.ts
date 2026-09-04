import type { ClientContext, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import {
  installWorkspaceSessionReadiness,
  waitForWorkspaceSession,
} from '../src/client/workspace-session-readiness.ts'

class Store<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private snapshot: T) {}

  getSnapshot = (): T => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(snapshot: T): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

const workspaceId = 'workspace-1' as WorkspaceId
const sessionId = 'session-1' as SessionId

function fixture() {
  const sessions = new Store<{ byId: Record<string, { id: SessionId; cwd: string | undefined }> }>({
    byId: { [sessionId]: { id: sessionId, cwd: undefined } },
  })
  const workspaces = new Store({
    items: [{ workspaceId, path: '/project', sessionIds: [] as SessionId[] }],
  })
  return { sessions, workspaces }
}

describe('workspace session readiness', () => {
  it('waits for session cwd when workspace membership arrives first', async () => {
    const { sessions, workspaces } = fixture()
    const waiting = waitForWorkspaceSession({
      sessions: { list: sessions },
      workspaces: { list: workspaces },
    } as never, workspaceId, sessionId, 100)

    workspaces.set({ items: [{ workspaceId, path: '/project', sessionIds: [sessionId] }] })
    let resolved = false
    void waiting.then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)

    sessions.set({ byId: { [sessionId]: { id: sessionId, cwd: '/project' } } })
    await expect(waiting).resolves.toBeUndefined()
  })

  it('waits for workspace membership when session cwd arrives first', async () => {
    const { sessions, workspaces } = fixture()
    const waiting = waitForWorkspaceSession({
      sessions: { list: sessions },
      workspaces: { list: workspaces },
    } as never, workspaceId, sessionId, 100)

    sessions.set({ byId: { [sessionId]: { id: sessionId, cwd: '/project' } } })
    let resolved = false
    void waiting.then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)

    workspaces.set({ items: [{ workspaceId, path: '/project', sessionIds: [sessionId] }] })
    await expect(waiting).resolves.toBeUndefined()
  })

  it.each([
    ['legacy workspaces service', false],
    ['DSH 0.1.2 uiWorkspace service', true],
  ] as const)('does not release connectWorkspace on the %s until membership and model projection are ready', async (_name, modern) => {
    const { sessions, workspaces } = fixture()
    let resolveModel: () => void = () => {}
    const modelReady = new Promise<void>(resolve => { resolveModel = resolve })
    const load = vi.fn(() => modelReady)
    const original = vi.fn(async (_workspaceId: WorkspaceId) => sessionId)
    const workspaceService = { list: workspaces, ...(modern ? {} : { connectWorkspace: original }) }
    const uiWorkspace = modern ? { connectWorkspace: original } : undefined
    const ctx = {
      sessions: { list: sessions },
      workspaces: workspaceService,
      modelDirectories: { directoryFor: () => ({ load }) },
      get: (name: string) => name === 'uiWorkspace' ? uiWorkspace : undefined,
    } as unknown as ClientContext & { modelDirectories: { directoryFor(id: SessionId): { load(): Promise<void> } } }
    const dispose = installWorkspaceSessionReadiness(ctx)

    const connector = modern ? uiWorkspace! : workspaceService as typeof workspaceService & { connectWorkspace: typeof original }
    const connected = connector.connectWorkspace(workspaceId)
    let resolved = false
    void connected.then(() => { resolved = true })
    await Promise.resolve()
    expect(load).toHaveBeenCalledOnce()
    expect(resolved).toBe(false)

    sessions.set({ byId: { [sessionId]: { id: sessionId, cwd: '/project' } } })
    workspaces.set({ items: [{ workspaceId, path: '/project', sessionIds: [sessionId] }] })
    await Promise.resolve()
    expect(resolved).toBe(false)

    resolveModel()
    await expect(connected).resolves.toBe(sessionId)
    dispose()
    expect(connector.connectWorkspace).toBe(original)
  })

  it('leaves the client usable when neither workspace navigation service exposes connectWorkspace', () => {
    const { sessions, workspaces } = fixture()
    const ctx = {
      sessions: { list: sessions },
      workspaces: { list: workspaces },
      modelDirectories: { directoryFor: () => ({ load: async () => {} }) },
      get: () => undefined,
    } as unknown as ClientContext

    expect(() => installWorkspaceSessionReadiness(ctx)).not.toThrow()
  })

  it('rejects instead of opening an unassociated session after the bounded wait', async () => {
    vi.useFakeTimers()
    const { sessions, workspaces } = fixture()
    const waiting = waitForWorkspaceSession({
      sessions: { list: sessions },
      workspaces: { list: workspaces },
    } as never, workspaceId, sessionId, 50)
    const rejection = expect(waiting).rejects.toThrow('did not attach to workspace')

    await vi.advanceTimersByTimeAsync(50)
    await rejection
    vi.useRealTimers()
  })
})
