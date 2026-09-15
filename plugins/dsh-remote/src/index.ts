import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerRemoteApi } from './http-api.ts'
import { managementOrigins, RemoteService } from './remote-service.ts'
import { installWebServerSocketCompatibility } from './webserver-socket-compat.ts'
import type { RemoteConfig } from './contracts.ts'

export const name = 'dsh-remote'
export const inject = ['webServer']

export async function apply(ctx: Context, config: RemoteConfig): Promise<void> {
  const disposeSocketCompatibility = installWebServerSocketCompatibility(ctx.webServer)
  let service: RemoteService
  try {
    service = await RemoteService.start(ctx.webServer, config)
  } catch (error) {
    disposeSocketCompatibility()
    throw error
  }
  // Optional on DSH releases without a browser-authenticated connection
  // service (rc.6-rc.8); when present (0.1.1+) its launch URL bridges the
  // upstream's own authority-bound cookie through this gateway.
  ctx.inject(['connection'], injected => {
    const connection = (injected as unknown as { connection?: { authenticatedUrl?: (baseUrl: string) => string } }).connection
    if (connection === undefined) return
    service.adoptConnection(connection)
    injected.effect(() => () => { service.releaseConnection() })
  })
  const disposeApi = registerRemoteApi(ctx.webServer, service, managementOrigins(config, ctx.webServer))
  ctx.effect(() => () => {
    disposeApi()
    void service.close()
    disposeSocketCompatibility()
  }, 'dsh-remote: gateway and management API')
}

export { RemoteGateway } from './gateway.ts'
export { assertSafeInstanceId, RemoteService } from './remote-service.ts'
export { RemoteStateStore } from './state-store.ts'
export { TunnelSupervisor, socketCleanupArgs, socketModeArgs, sshArgs } from './tunnel-supervisor.ts'
export { installWebServerSocketCompatibility } from './webserver-socket-compat.ts'
export type { RemoteConfig, RemoteStatus, TunnelPhase, TunnelStatus } from './contracts.ts'
