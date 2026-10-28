/**
 * Ambient faces for the host surfaces dsh-reading consumes on dsh 0.2.
 *
 * 0.2 moved the browser ClientContext onto the plain cordis `Context` (the
 * client-runtime augmentations are gone), so the members reading's client and
 * server code rely on are re-declared here, mirroring dsh-wecom/dsh-cron's
 * hand-declared shim pattern. Augmenting this interface suppresses cordis's
 * own d.ts augmentation seats, so `effect`/`get`-style core members used by
 * this plugin are restated alongside the plugin-facing ones:
 *
 * - `webServer`: host-webserver Context seat (server HTTP API).
 * - `slots`: slot registry (0.2 keeps the service; its typing ships with the
 *   host renderer, not in this plugin's resolution graph).
 * - `sessions`: 0.2 controller face — the list snapshot no longer carries
 *   `current`; the shell's session is the `retainedBy.mainView` row.
 * - `workspaces` / `uiWorkspace`: 0.2 moved `connectWorkspace` and session
 *   navigation to the cross-Controller `uiWorkspace` face
 *   (dsh-client-ui-workspace); the controller keeps only catalog verbs.
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Service read without the inject requirement (cordis reflection seat). */
    get(name: string, strict?: boolean): any
    effect(disposer: () => (() => void) | (() => Promise<void>), label: string): void
    webServer: import('@deepseek-ai/dsh-host-webserver').WebServer
    slots: {
      inject(name: string, register: () => (() => void)): void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    sessions: {
      list: {
        subscribe(listener: () => void): () => void
        getSnapshot(): {
          ids: readonly string[]
          byId: Record<string, { retainedBy?: Partial<Record<'mainView' | 'controllerOperation' | 'gateway', number>> }>
        }
      }
      /** Session-scoped agent context; structural face only. */
      scope(id: string): Context | undefined
      sessionOf(ctx: Context): SessionFace | undefined
    }
    workspaces: {
      create(input: { path: string }): Promise<{ workspaceId: string }>
    }
    uiWorkspace: {
      /** Select the session and show its conversation (0.2 cross-Controller navigation). */
      openSession(target: string): void
      /** Connect a Workspace and resolve its session (moved off IWorkspaces in 0.2). */
      connectWorkspace(workspaceId: string): Promise<string>
    }
  }
  /** Session conversation face used by the reading workbench. */
  interface SessionFace {
    getSnapshot(): {
      nodes: ReadonlyArray<{
        seq: number
        kind: string
        interrupted?: boolean
        blocks: ReadonlyArray<{ kind: string; text?: string }>
      }>
      running: boolean
      partial: unknown
      promptError: { error: { message?: string } } | null
    }
    subscribe(listener: () => void): () => void
    prompt(blocks: ReadonlyArray<{ type: 'text'; text: string }>, mode: 'queue' | 'steer'): Promise<{ ok: true } | { ok: false; error: { message?: string } }>
  }
}
