declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: { register(definition: unknown): () => void }
    webServer: import('@deepseek-ai/dsh-host-webserver').WebServer
    effect(disposer: () => (() => void), label: string): void
  }
}

declare module '@deepseek-ai/dsh-host-webserver' {
  import type { IncomingMessage, ServerResponse } from 'node:http'

  export interface WebRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }

  export interface WebServer {
    register(route: WebRoute): () => void
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool<const T>(options: T): T
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    slots: {
      inject(name: string, register: () => (() => void)): void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    layout: {
      openDetails(): void
      closeDetails(): void
    }
    effect(disposer: () => (() => void), label: string): void
  }
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {}
declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface SlotMap {}
}
