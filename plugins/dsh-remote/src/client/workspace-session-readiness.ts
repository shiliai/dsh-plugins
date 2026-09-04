import type { ClientContext, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

interface ModelDirectory {
  load(): Promise<unknown>
}

interface ModelDirectories {
  directoryFor(sessionId: SessionId): ModelDirectory
}

interface WorkspaceConnector {
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
}

interface ReadinessOwner {
  wait(workspaceId: WorkspaceId, sessionId: SessionId): Promise<void>
}

interface ConnectorPatch {
  originalMethod: WorkspaceConnector['connectWorkspace']
  original: WorkspaceConnector['connectWorkspace']
  owners: ReadinessOwner[]
  guarded: WorkspaceConnector['connectWorkspace']
}

const connectorPatches = new WeakMap<WorkspaceConnector, ConnectorPatch>()

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

function addReadinessOwner(connector: WorkspaceConnector, owner: ReadinessOwner): () => void {
  let patch = connectorPatches.get(connector)
  if (patch === undefined || connector.connectWorkspace !== patch.guarded) {
    const originalMethod = connector.connectWorkspace
    const original = originalMethod.bind(connector)
    const owners: ReadinessOwner[] = []
    const guarded = async (workspaceId: WorkspaceId): Promise<SessionId> => {
      const sessionId = await original(workspaceId)
      const activeOwner = owners.at(-1)
      if (activeOwner !== undefined) await activeOwner.wait(workspaceId, sessionId)
      return sessionId
    }
    patch = { originalMethod, original, owners, guarded }
    connectorPatches.set(connector, patch)
    connector.connectWorkspace = guarded
  }
  patch.owners.push(owner)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const index = patch.owners.indexOf(owner)
    if (index !== -1) patch.owners.splice(index, 1)
    if (patch.owners.length !== 0) return
    if (connector.connectWorkspace === patch.guarded) connector.connectWorkspace = patch.originalMethod
    if (connectorPatches.get(connector) === patch) connectorPatches.delete(connector)
  }
}

export function installWorkspaceSessionReadiness(ctx: ClientContext): () => void | Promise<void> {
  const modelDirectories = (ctx as ClientContext & { modelDirectories: ModelDirectories }).modelDirectories
  const owner: ReadinessOwner = {
    async wait(workspaceId, sessionId) {
      await Promise.all([
        waitForWorkspaceSession(ctx, workspaceId, sessionId),
        modelDirectories.directoryFor(sessionId).load(),
      ])
    },
  }
  const legacyConnector = ctx.workspaces as typeof ctx.workspaces & Partial<WorkspaceConnector>
  const disposeLegacy = legacyConnector.connectWorkspace === undefined
    ? () => {}
    : addReadinessOwner(legacyConnector as WorkspaceConnector, owner)
  const uiWorkspaceFiber = ctx.inject(['uiWorkspace'], scope => {
    const connector = scope.get('uiWorkspace') as WorkspaceConnector
    return addReadinessOwner(connector, owner)
  })

  return () => {
    disposeLegacy()
    return uiWorkspaceFiber.dispose()
  }
}
