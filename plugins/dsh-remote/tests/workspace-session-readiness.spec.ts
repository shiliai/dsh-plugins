import type { ClientContext, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { Context } from '@deepseek-ai/cordis'
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

function createClientContext() {
  const { sessions, workspaces } = fixture()
  sessions.set({ byId: { [sessionId]: { id: sessionId, cwd: '/project' } } })
  workspaces.set({ items: [{ workspaceId, path: '/project', sessionIds: [sessionId] }] })
  const ctx = new Context()
  ctx.provide('sessions', { list: sessions })
  ctx.provide('workspaces', { list: workspaces })
  ctx.provide('modelDirectories', { directoryFor: () => ({ load: async () => {} }) })
  return { ctx: ctx as unknown as ClientContext, sessions, workspaces }
}

function connector(result = sessionId) {
  return {
    marker: result,
    calls: 0,
    async connectWorkspace(this: { marker: SessionId; calls: number }, _workspaceId: WorkspaceId) {
      this.calls += 1
      return this.marker
    },
  }
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

  it('does not release the legacy connector until membership and model projection are ready', async () => {
    const { sessions, workspaces } = fixture()
    let resolveModel: () => void = () => {}
    const modelReady = new Promise<void>(resolve => { resolveModel = resolve })
    const load = vi.fn(() => modelReady)
    const workspaceConnector = connector()
    const original = workspaceConnector.connectWorkspace
    const workspaceService = { list: workspaces, ...workspaceConnector }
    const ctx = {
      sessions: { list: sessions },
      workspaces: workspaceService,
      modelDirectories: { directoryFor: () => ({ load }) },
      inject: () => ({ dispose: async () => {} }),
    } as unknown as ClientContext & { modelDirectories: { directoryFor(id: SessionId): { load(): Promise<void> } } }
    const dispose = installWorkspaceSessionReadiness(ctx)

    const connected = workspaceService.connectWorkspace(workspaceId)
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
    await dispose()
    expect(workspaceService.calls).toBe(1)
    expect(workspaceService.connectWorkspace).toBe(original)
  })

  it('patches a modern provider that activates after installation and restores it on unload', async () => {
    const { ctx } = createClientContext()
    const modern = connector()
    const original = modern.connectWorkspace
    const disposeInstall = installWorkspaceSessionReadiness(ctx)

    expect(modern.connectWorkspace).toBe(original)
    const disposeProvider = (ctx as unknown as Context).provide('uiWorkspace', modern)
    await Promise.resolve()
    expect(modern.connectWorkspace).not.toBe(original)
    await modern.connectWorkspace(workspaceId)
    expect(modern.calls).toBe(1)

    await disposeProvider()
    expect(modern.connectWorkspace).toBe(original)
    await disposeInstall()
  })

  it('moves the guard when the modern provider is replaced', async () => {
    const { ctx } = createClientContext()
    const first = connector()
    const second = connector()
    const firstOriginal = first.connectWorkspace
    const secondOriginal = second.connectWorkspace
    const disposeInstall = installWorkspaceSessionReadiness(ctx)
    const disposeFirst = (ctx as unknown as Context).provide('uiWorkspace', first)
    await Promise.resolve()
    expect(first.connectWorkspace).not.toBe(firstOriginal)

    await disposeFirst()
    expect(first.connectWorkspace).toBe(firstOriginal)
    const disposeSecond = (ctx as unknown as Context).provide('uiWorkspace', second)
    await Promise.resolve()
    expect(second.connectWorkspace).not.toBe(secondOriginal)

    await disposeSecond()
    expect(second.connectWorkspace).toBe(secondOriginal)
    await disposeInstall()
  })

  it('keeps overlapping installs stack-safe when the older owner disposes first', async () => {
    const { ctx } = createClientContext()
    const modern = connector()
    const original = modern.connectWorkspace
    const disposeProvider = (ctx as unknown as Context).provide('uiWorkspace', modern)
    const disposeA = installWorkspaceSessionReadiness(ctx)
    const disposeB = installWorkspaceSessionReadiness(ctx)
    await Promise.resolve()
    const guarded = modern.connectWorkspace
    expect(guarded).not.toBe(original)

    await disposeA()
    expect(modern.connectWorkspace).toBe(guarded)
    await modern.connectWorkspace(workspaceId)
    expect(modern.calls).toBe(1)

    await disposeB()
    expect(modern.connectWorkspace).toBe(original)
    await disposeProvider()
  })

  it('leaves the client usable when neither workspace navigation service exposes connectWorkspace', async () => {
    const { ctx } = createClientContext()

    let dispose: ReturnType<typeof installWorkspaceSessionReadiness> | undefined
    expect(() => { dispose = installWorkspaceSessionReadiness(ctx) }).not.toThrow()
    await dispose?.()
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
