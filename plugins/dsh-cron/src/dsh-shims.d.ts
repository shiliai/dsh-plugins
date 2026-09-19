/**
 * Ambient declarations for the browser ClientContext surfaces dsh-cron's
 * client consumes (shell overlay slot, sidebar footer action, session
 * navigation). Mirrors the dsh-obsidian shim pattern: the shapes are
 * hand-declared because the plugins only depend on the runtime's structural
 * face. Server-side services are typed by the host packages themselves.
 */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    slots: {
      inject(name: string, register: () => (() => void)): void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    sessions: {
      open(id: string): void
      list: {
        subscribe(listener: () => void): () => void
        getSnapshot(): {
          current: string | undefined
          byId: Record<string, { blank: boolean }>
        }
      }
    }
    effect(disposer: () => (() => void), label: string): void
  }
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {}
declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}
declare module '@deepseek-ai/dsh-client-ui-slots' {}

/** Injected by tsdown `define` from package.json at build time. */
declare const __PLUGIN_VERSION__: string
