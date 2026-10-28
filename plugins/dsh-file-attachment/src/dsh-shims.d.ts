/**
 * Ambient face for the host surface dsh-file-attachment consumes on dsh 0.2.
 *
 * 0.2 host bundles no longer augment the plugin-resolvable cordis `Context`
 * with `webServer` in this program's dependency graph (the augmentation lives
 * on a pnpm-closure variant of cordis), so the seat is declared here — same
 * pattern as dsh-reading's dsh-shims.d.ts.
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Plugin fiber effect seat (restated: fiber augmentation not in this program's graph). */
    effect(disposer: () => (() => void) | (() => Promise<void>), label?: string): unknown
    /** Host web server: HTTP/upgrade route registries (server side). */
    webServer: import('@deepseek-ai/dsh-host-webserver').WebServer
  }
}
