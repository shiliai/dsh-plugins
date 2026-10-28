/** Issue #135: land the conversation in the vault workspace after Add to chat. */

/**
 * Loose structural view of the session list, for pure helpers and tests.
 *
 * dsh 0.2 removed `current` from the list snapshot (selection belongs to view
 * owners there): the conversation's main view retains its session under the
 * `mainView` reference source, so the row carrying a positive `mainView` count
 * IS the current session (see `currentSessionIdOf`). `current` stays optional
 * here for hosts that still expose it.
 */
export interface SessionListView {
  current?: string | undefined
  byId: Record<string, {
    blank?: boolean
    cwd?: string
    displayTitle?: string
    title?: string
    /** Local reference-source counts; the conversation main view retains `mainView`. */
    retainedBy?: { mainView?: number } | undefined
  }>
}

/**
 * The session the conversation main view is showing, resolved the way the
 * host's own ui-session layer does: the listed row retained under `mainView`.
 * Falls back to a legacy explicit `current` when the host still publishes one.
 */
export function currentSessionIdOf(sessions: SessionListView): string | undefined {
  const retained = Object.entries(sessions.byId).find(([, row]) => (row.retainedBy?.mainView ?? 0) > 0)
  if (retained !== undefined) return retained[0]
  return sessions.current
}

/**
 * Structural faces used to land the conversation. 0.1 carried
 * `connectWorkspace` (and the `open` selector) on `ctx.workspaces`/
 * `ctx.sessions`; 0.2 moved workspace connection and session navigation to
 * `ctx.uiWorkspace`. Every navigation face is optional and resolved at call
 * time; absence just disables the auto-landing.
 */
export interface VaultLandingContext {
  uiWorkspace?: {
    connectWorkspace(workspaceId: string): Promise<string>
    /** Select a session as the conversation main view (0.2 navigation). */
    openSession?(id: string): void
  } | undefined
  /** Legacy (0.1) connect face; 0.2 hosts carry it only on `uiWorkspace`. */
  workspaces?: { connectWorkspace?(workspaceId: string): Promise<string> } | undefined
  sessions: {
    list: { getSnapshot(): SessionListView }
    /** Resolve the session-scope context; defined only for materialized sessions. */
    scope(id: string): unknown
    /** Legacy (0.1) current-session selector; 0.2 navigates via `uiWorkspace.openSession`. */
    open?(id: string): void
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

/** Resolve whichever face can select the conversation main view. */
function openSessionFaceOf(ctx: VaultLandingContext): ((id: string) => void) | undefined {
  return ctx.uiWorkspace?.openSession?.bind(ctx.uiWorkspace)
    ?? (ctx.sessions.open?.bind(ctx.sessions) as ((id: string) => void) | undefined)
}

/**
 * Whether the current conversation is still blank (safe to move into the
 * vault workspace). A conversation in progress stays in its own workspace.
 */
export function currentSessionIsBlank(sessions: SessionListView): boolean {
  const current = currentSessionIdOf(sessions)
  return current === undefined || sessions.byId[current]?.blank !== false
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
  const openSession = openSessionFaceOf(ctx)
  if (connect === undefined || openSession === undefined) return undefined
  const original = currentSessionIdOf(ctx.sessions.list.getSnapshot())
  try {
    const sessionId = await connect(workspaceId)
    // The reusable blank session may already be the current conversation
    // (cwd already matches the vault); no navigation is needed then.
    if (sessionId === original) return sessionId
    const listed = await until(() => ctx.sessions.list.getSnapshot().byId[sessionId] !== undefined, wait)
    if (!listed) return undefined
    openSession(sessionId)
    const scoped = await until(() => ctx.sessions.scope(sessionId) !== undefined, wait)
    if (!scoped) {
      if (original !== undefined) openSession(original)
      return undefined
    }
    return sessionId
  } catch (error) {
    console.warn('dsh-obsidian: landing in the vault workspace failed:', error)
    return undefined
  }
}
