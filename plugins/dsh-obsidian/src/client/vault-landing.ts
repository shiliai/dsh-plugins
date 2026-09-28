/** Issue #135: land the conversation in the vault workspace after Add to chat. */

/** Loose structural view of the session list, for pure helpers and tests. */
export interface SessionListView {
  current: string | undefined
  byId: Record<string, { blank?: boolean }>
}

/**
 * Structural faces used to land the conversation. `connectWorkspace` lives on
 * `ctx.workspaces` in dsh-client-runtime 0.1.0-rc.6 and moved to
 * `ctx.uiWorkspace` in 0.1.2-rc.1, so both are optional and resolved at call
 * time; either absence just disables the auto-landing.
 */
export interface VaultLandingContext {
  uiWorkspace?: { connectWorkspace(workspaceId: string): Promise<string> } | undefined
  workspaces?: { connectWorkspace(workspaceId: string): Promise<string> } | undefined
  sessions: {
    list: { getSnapshot(): SessionListView }
    /** Resolve the session-scope context; defined only for materialized sessions. */
    scope(id: string): unknown
    /** Select a session as current. */
    open(id: string): void
  }
}

const POLL_INTERVAL_MS = 50
const POLL_TIMEOUT_MS = 2000

/** Poll until `check` is true, with one final check after the timeout. */
async function until(check: () => boolean, wait: (ms: number) => Promise<void>): Promise<boolean> {
  for (let elapsed = POLL_INTERVAL_MS; elapsed < POLL_TIMEOUT_MS; elapsed += POLL_INTERVAL_MS) {
    if (check()) return true
    await wait(POLL_INTERVAL_MS)
  }
  return check()
}

/** Resolve whichever runtime face carries `connectWorkspace` in this version. */
function connectFaceOf(ctx: VaultLandingContext): ((workspaceId: string) => Promise<string>) | undefined {
  return ctx.uiWorkspace?.connectWorkspace?.bind(ctx.uiWorkspace)
    ?? ctx.workspaces?.connectWorkspace?.bind(ctx.workspaces)
}

/**
 * Whether the current conversation is still blank (safe to move into the
 * vault workspace). A conversation in progress stays in its own workspace.
 */
export function currentSessionIsBlank(sessions: SessionListView): boolean {
  return sessions.current === undefined || sessions.byId[sessions.current]?.blank !== false
}

/**
 * Connect the reusable blank session of a workspace, navigate to it, and
 * confirm its session scope is materialized. Returns the landed session id,
 * or undefined when any step fails — the caller then keeps the current
 * conversation untouched instead of leaving the view on an empty session.
 *
 * The reference draft is written by the caller AFTER this resolves, so a
 * failed landing never strands the reference in an invisible composer.
 */
export async function landInVaultWorkspace(
  ctx: VaultLandingContext,
  workspaceId: string,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<string | undefined> {
  const connect = connectFaceOf(ctx)
  if (connect === undefined) return undefined
  const original = ctx.sessions.list.getSnapshot().current
  try {
    const sessionId = await connect(workspaceId)
    // The reusable blank session may already be the current conversation
    // (cwd already matches the vault); no navigation is needed then.
    if (sessionId === original) return sessionId
    const listed = await until(() => ctx.sessions.list.getSnapshot().byId[sessionId] !== undefined, wait)
    if (!listed) return undefined
    ctx.sessions.open(sessionId)
    const scoped = await until(() => ctx.sessions.scope(sessionId) !== undefined, wait)
    if (!scoped) {
      if (original !== undefined) ctx.sessions.open(original)
      return undefined
    }
    return sessionId
  } catch (error) {
    console.warn('dsh-obsidian: landing in the vault workspace failed:', error)
    return undefined
  }
}
