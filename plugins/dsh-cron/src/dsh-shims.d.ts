/**
 * Ambient declarations for the browser ClientContext surfaces dsh-cron's
 * client consumes (shell overlay slot, sidebar footer action, session
 * navigation). Mirrors the dsh-obsidian shim pattern: the shapes are
 * hand-declared because the plugins only depend on the runtime's structural
 * face. On dsh 0.2 the client Context is the plain cordis `Context` — the
 * client-runtime augmentations are gone — so the members live here, with the
 * 0.2 faces: session navigation moved from `sessions.open` to
 * `uiWorkspace.openSession` (dsh-client-ui-workspace).
 *
 * Server-side services are typed by the host packages themselves.
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    /** Service read without the inject requirement (cordis reflection seat). */
    get(name: string, strict?: boolean): any
    slots: {
      inject(name: string, register: () => (() => void)): void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    uiWorkspace: {
      /** Select the session and show its conversation (0.2 cross-Controller navigation). */
      openSession(target: string): void
    }
    effect(disposer: () => (() => void) | (() => Promise<void>), label: string): void
  }
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {}
declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}
declare module '@deepseek-ai/dsh-client-ui-slots' {}

/** Injected by tsdown `define` from package.json at build time. */
declare const __PLUGIN_VERSION__: string
