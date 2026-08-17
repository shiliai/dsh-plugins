export type TunnelPhase = 'starting' | 'online' | 'reconnecting' | 'failed' | 'stopped'

export interface RemoteState {
  schema: 1
  token: string
  sessionVersion: number
  createdAt: string
  rotatedAt: string
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
  remoteOrigin: string
  sshTarget: string
  remoteSocketPath: string
  stateFile?: string
  gatewayHost?: '127.0.0.1'
  gatewayPort?: number
  managementOrigin?: string
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  reconnectMaxRetries?: number
  tunnelStabilityDelayMs?: number
}
