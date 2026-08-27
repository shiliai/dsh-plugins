declare module '@deepseek-ai/cordis' {
  export interface Context {
    get(name: string): any
    on(event: string, listener: (session: unknown, event: unknown) => void): () => void
    tools: { register(definition: unknown): () => void }
    webServer: import('@deepseek-ai/dsh-host-webserver').WebServer
    effect(disposer: () => (() => void) | (() => Promise<void>), label: string): void
  }
}

declare module '@deepseek-ai/dsh-host-webserver' {
  import type { IncomingMessage, ServerResponse } from 'node:http'
  export interface WebServer {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    slots: { inject(name: string, register: () => (() => void)): void; register(options: Record<string, unknown>, component: unknown): () => void }
    effect(disposer: () => (() => void), label: string): void
  }
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {}
declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}
declare module '@deepseek-ai/dsh-client-ui-slots' {}
