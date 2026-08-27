import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { RemoteConfig, RemoteStatus } from './contracts.ts'
import { RemoteGateway } from './gateway.ts'
import { RemoteStateStore } from './state-store.ts'
import { TunnelSupervisor } from './tunnel-supervisor.ts'

export class RemoteService {
  private constructor(
    private readonly remoteOrigin: string,
    private readonly state: RemoteStateStore,
    private readonly gateway: RemoteGateway,
    private readonly tunnel: TunnelSupervisor | null,
  ) {}

  static async start(webServer: WebServer, config: RemoteConfig): Promise<RemoteService> {
    const resolved = resolveRuntimeConfig(webServer, config)
    const state = await RemoteStateStore.open(resolved.stateFile, { initialToken: resolved.initialToken })
    const gateway = new RemoteGateway({
      targetPort: webServer.port,
      remoteOrigin: resolved.remoteOrigin,
      state,
      host: resolved.gatewayHost,
      port: resolved.gatewayPort,
      ...(resolved.mode === 'host' ? { agentSocketPath: resolved.agentSocketPath } : {}),
    })
    await gateway.listen()
    const tunnel = resolved.mode === 'ssh' || resolved.sshCompatibility ? new TunnelSupervisor({
      sshTarget: resolved.sshTarget,
      remoteSocketPath: resolved.remoteSocketPath,
      localPort: gateway.port,
      reconnectBaseMs: resolved.reconnectBaseMs,
      reconnectMaxMs: resolved.reconnectMaxMs,
      reconnectMaxRetries: resolved.reconnectMaxRetries,
      stabilityDelayMs: resolved.tunnelStabilityDelayMs,
    }) : null
    tunnel?.start()
    return new RemoteService(resolved.remoteOrigin, state, gateway, tunnel)
  }

  status(): RemoteStatus {
    const state = this.state.current()
    return {
      accessUrl: `${this.remoteOrigin}/#/access/${state.token}`,
      gatewayPort: this.gateway.port,
      sessionVersion: state.sessionVersion,
      tunnel: this.tunnel?.status() ?? { phase: 'online', attempts: 0, reason: null },
    }
  }

  async rotate(): Promise<RemoteStatus> {
    const state = await this.state.rotate()
    this.gateway.closeSessionsBefore(state.sessionVersion)
    return this.status()
  }

  reconnect(): RemoteStatus {
    this.tunnel?.reconnect()
    return this.status()
  }

  async close(): Promise<void> {
    this.tunnel?.stop()
    await this.gateway.close()
  }
}

export function managementOrigins(config: RemoteConfig, webServer: WebServer): readonly string[] {
  const resolved = resolveRuntimeConfig(webServer, config)
  const local = config.managementOrigin === undefined
    ? `http://${webServer.host}:${webServer.port}`
    : requiredHttpOrigin(config.managementOrigin, 'managementOrigin')
  return [local, resolved.remoteOrigin]
}

export interface ResolvedRemoteConfig {
  mode: 'ssh' | 'host'
  sshCompatibility: boolean
  instanceId: string | undefined
  remoteOrigin: string
  sshTarget: string
  remoteSocketPath: string
  agentSocketPath: string
  stateFile: string
  initialToken: string | undefined
  gatewayHost: '127.0.0.1'
  gatewayPort: number
  reconnectBaseMs: number
  reconnectMaxMs: number
  reconnectMaxRetries: number
  tunnelStabilityDelayMs: number
}

export function resolveRuntimeConfig(webServer: Pick<WebServer, 'host' | 'port'>, config: RemoteConfig): ResolvedRemoteConfig {
  if (webServer.host !== '127.0.0.1') throw new Error('dsh-remote: webServer must remain bound to loopback.')
  if (config.gatewayHost !== undefined && config.gatewayHost !== '127.0.0.1') throw new Error('dsh-remote: gatewayHost must be 127.0.0.1.')
  const instanceId = optionalInstanceId(environmentValue('DSH_REMOTE_INSTANCE_ID') ?? config.instanceId)
  const mode = requiredMode(environmentValue('DSH_REMOTE_MODE') ?? config.mode ?? 'ssh')
  const sshCompatibility = optionalBoolean(environmentValue('DSH_REMOTE_SSH_COMPATIBILITY')) ?? config.sshCompatibility ?? false
  const baseDomain = requiredDomain(environmentValue('DSH_REMOTE_BASE_DOMAIN') ?? config.baseDomain ?? 'dsh.onlyservice.io', 'baseDomain')
  const remoteOrigin = requiredHttpsOrigin(
    environmentValue('DSH_REMOTE_ORIGIN') ?? (instanceId === undefined ? config.remoteOrigin : `https://${instanceId}.${baseDomain}`),
    'remoteOrigin',
  )
  const sshTarget = environmentValue('DSH_REMOTE_SSH_TARGET') ?? config.sshTarget
  const remoteSocketPath = environmentValue('DSH_REMOTE_SOCKET_PATH')
    ?? (instanceId === undefined ? config.remoteSocketPath : `/home/chriswang/.local/share/dsh-remote/instances/${instanceId}.sock`)
  assertSafeSshTarget(sshTarget)
  assertSafeRemoteSocketPath(remoteSocketPath)
  const agentSocketPath = environmentValue('DSH_REMOTE_AGENT_SOCKET_PATH') ?? config.agentSocketPath ?? defaultAgentSocketPath()
  assertSafeRemoteSocketPath(agentSocketPath)
  const stateFile = environmentValue('DSH_REMOTE_STATE_FILE') ?? config.stateFile
    ?? (instanceId === undefined ? defaultStatePath() : defaultInstanceStatePath(instanceId))
  if (!posix.isAbsolute(stateFile)) throw new Error('dsh-remote: stateFile must be absolute.')
  return {
    mode,
    sshCompatibility,
    instanceId,
    remoteOrigin,
    sshTarget,
    remoteSocketPath,
    agentSocketPath,
    stateFile,
    initialToken: environmentValue('DSH_REMOTE_INITIAL_TOKEN'),
    gatewayHost: '127.0.0.1',
    gatewayPort: hostGatewayPort(mode, config.gatewayPort),
    reconnectBaseMs: boundedInteger(config.reconnectBaseMs ?? 500, 100, 60_000, 'reconnectBaseMs'),
    reconnectMaxMs: boundedInteger(config.reconnectMaxMs ?? 30_000, 100, 300_000, 'reconnectMaxMs'),
    reconnectMaxRetries: boundedInteger(config.reconnectMaxRetries ?? 5, 0, 20, 'reconnectMaxRetries'),
    tunnelStabilityDelayMs: boundedInteger(config.tunnelStabilityDelayMs ?? 750, 100, 10_000, 'tunnelStabilityDelayMs'),
  }
}

export function assertSafeInstanceId(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value) || value.includes('--')) {
    throw new Error('dsh-remote: instanceId must be a lowercase DNS label without consecutive hyphens.')
  }
}

export function assertSafeSshTarget(value: string): void {
  const parts = value.split('@')
  const host = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : undefined
  const user = parts.length === 2 ? parts[0] : undefined
  if (host === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u.test(host) || host.includes('..') || host.endsWith('.') || host.endsWith('-')
    || (user !== undefined && !/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/u.test(user))) {
    throw new Error('dsh-remote: sshTarget must be a safe alias or user@host.')
  }
}

export function assertSafeRemoteSocketPath(value: string): void {
  const segments = value.split('/')
  if (!posix.isAbsolute(value) || value.length > 240 || value.includes(':') || /[\u0000-\u001f\u007f]/u.test(value)
    || segments.some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)))) {
    throw new Error('dsh-remote: remoteSocketPath must be a safe absolute Unix socket path.')
  }
}

function defaultStatePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'dsh-remote', 'state.json')
}

function defaultInstanceStatePath(instanceId: string): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'dsh-remote', 'instances', `${instanceId}.json`)
}

function defaultAgentSocketPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'dsh-remote-agent', 'agent.sock')
}

function requiredMode(value: string): 'ssh' | 'host' {
  if (value !== 'ssh' && value !== 'host') throw new Error('dsh-remote: mode must be ssh or host.')
  return value
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('dsh-remote: boolean environment values must be true or false.')
}

function hostGatewayPort(mode: 'ssh' | 'host', value: number | undefined): number {
  const port = boundedInteger(value ?? (mode === 'host' ? 29321 : 0), 0, 65535, 'gatewayPort')
  if (mode === 'host' && port === 0) throw new Error('dsh-remote: host mode requires a fixed gatewayPort.')
  return port
}

function optionalInstanceId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  assertSafeInstanceId(value)
  return value
}

function requiredDomain(value: string, name: string): string {
  if (value.length > 253 || value.includes('..') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)) {
    throw new Error(`dsh-remote: ${name} must be a lowercase DNS name.`)
  }
  return value
}

function requiredHttpsOrigin(value: string, name: string): string {
  const origin = requiredHttpOrigin(value, name)
  if (!origin.startsWith('https://')) throw new Error(`dsh-remote: ${name} must use HTTPS.`)
  return origin
}

function requiredHttpOrigin(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`dsh-remote: ${name} must be an HTTP(S) origin.`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`dsh-remote: ${name} must be an HTTP(S) origin without a path.`)
  }
  return url.origin
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-remote: ${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value
}
