import type { ClientContext, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

interface ModelDirectory {
  load(): Promise<unknown>
}

interface ModelDirectories {
  directoryFor(sessionId: SessionId): ModelDirectory
}

const DEFAULT_TIMEOUT_MS = 15_000

export function waitForWorkspaceSession(
  ctx: Pick<ClientContext, 'sessions' | 'workspaces'>,
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const ready = (): boolean => {
    const workspace = ctx.workspaces.list.getSnapshot().items
      .find(candidate => candidate.workspaceId === workspaceId)
    const session = ctx.sessions.list.getSnapshot().byId[sessionId]
    return workspace !== undefined
      && workspace.sessionIds.includes(sessionId)
      && session?.cwd === workspace.path
  }
  if (ready()) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let stopSessions = (): void => {}
    let stopWorkspaces = (): void => {}
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopSessions()
      stopWorkspaces()
      if (error === undefined) resolve()
      else reject(error)
    }
    const check = (): void => {
      if (ready()) finish()
    }
    const timer = setTimeout(() => {
      finish(new Error(`dsh-remote: session ${String(sessionId)} did not attach to workspace ${String(workspaceId)}.`))
    }, timeoutMs)
    stopSessions = ctx.sessions.list.subscribe(check)
    stopWorkspaces = ctx.workspaces.list.subscribe(check)
    check()
  })
}

export function installWorkspaceSessionReadiness(ctx: ClientContext): () => void {
  const workspaces = ctx.workspaces
  const modelDirectories = (ctx as ClientContext & { modelDirectories: ModelDirectories }).modelDirectories
  const originalMethod = workspaces.connectWorkspace
  const original = originalMethod.bind(workspaces)
  const guarded = async (workspaceId: WorkspaceId): Promise<SessionId> => {
    const sessionId = await original(workspaceId)
    await Promise.all([
      waitForWorkspaceSession(ctx, workspaceId, sessionId),
      modelDirectories.directoryFor(sessionId).load(),
    ])
    return sessionId
  }
  workspaces.connectWorkspace = guarded

  return () => {
    if (workspaces.connectWorkspace === guarded) workspaces.connectWorkspace = originalMethod
  }
}
