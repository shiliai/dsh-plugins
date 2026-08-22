export type TunnelPhase = 'starting' | 'online' | 'reconnecting' | 'failed' | 'stopped'

export interface RemoteState {
  schema: 2
  token: string
  sessionVersion: number
  createdAt: string
  rotatedAt: string
  hostSessions: HostSessionDigest[]
}

export interface HostSessionDigest {
  digest: string
  expiresAt: number
}

export interface TunnelStatus {
  phase: TunnelPhase
  attempts: number
  reason: string | null
}

export interface RemoteStatus {
  accessUrl: string
  gatewayPort: number
  sessionVersion: number
  tunnel: TunnelStatus
}

export interface RemoteConfig {
  mode?: 'ssh' | 'host'
  sshCompatibility?: boolean
  remoteOrigin: string
  sshTarget: string
  remoteSocketPath: string
  agentSocketPath?: string
  instanceId?: string
  baseDomain?: string
  stateFile?: string
  gatewayHost?: '127.0.0.1'
  gatewayPort?: number
  managementOrigin?: string
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  reconnectMaxRetries?: number
  tunnelStabilityDelayMs?: number
}
