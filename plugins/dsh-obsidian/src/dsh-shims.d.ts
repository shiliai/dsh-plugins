declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: { register(definition: unknown): () => void }
    webServer: import('@deepseek-ai/dsh-host-webserver').WebServer
    skills: {
      registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
      register(skill: unknown): () => void
    }
    effect(disposer: () => (() => void), label: string): void
  }

  export interface SkillProviderControl {
    readonly signal: AbortSignal
    readonly invalidate: () => void
  }

  export interface SkillProvider {
    readonly name: string
    list(options: { cwd?: string; signal?: AbortSignal }): Promise<readonly unknown[]>
    get(candidate: unknown, options: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
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
