import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerRemoteApi } from './http-api.ts'
import { managementOrigins, RemoteService } from './remote-service.ts'
import type { RemoteConfig } from './contracts.ts'

export const name = 'dsh-remote'
export const inject = ['webServer']

export async function apply(ctx: Context, config: RemoteConfig): Promise<void> {
  const service = await RemoteService.start(ctx.webServer, config)
  const disposeApi = registerRemoteApi(ctx.webServer, service, managementOrigins(config, ctx.webServer))
  ctx.effect(() => () => {
    disposeApi()
    void service.close()
  }, 'dsh-remote: gateway and management API')
}

export { RemoteGateway } from './gateway.ts'
export { RemoteService } from './remote-service.ts'
export { RemoteStateStore } from './state-store.ts'
export { TunnelSupervisor, sshArgs } from './tunnel-supervisor.ts'
export type { RemoteConfig, RemoteStatus, TunnelPhase, TunnelStatus } from './contracts.ts'
