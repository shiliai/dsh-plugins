import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { TunnelStatus } from './contracts.ts'

export interface TunnelSupervisorOptions {
  sshTarget: string
  remoteSocketPath: string
  localPort: number
  reconnectBaseMs: number
  reconnectMaxMs: number
  reconnectMaxRetries: number
  stabilityDelayMs: number
  spawn?: typeof nodeSpawn
  random?: () => number
}

export class TunnelSupervisor {
  private readonly spawn: typeof nodeSpawn
  private readonly random: () => number
  private child: ChildProcess | undefined
  private timer: NodeJS.Timeout | undefined
  private stabilityTimer: NodeJS.Timeout | undefined
  private running = false
  private attempts = 0
  private current: TunnelStatus = { phase: 'stopped', attempts: 0, reason: null }

  constructor(private readonly options: TunnelSupervisorOptions) {
    this.spawn = options.spawn ?? nodeSpawn
    this.random = options.random ?? Math.random
  }

  status(): TunnelStatus {
    return { ...this.current }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.attempts = 0
    this.openTunnel()
  }

  reconnect(): void {
    this.stop()
    this.start()
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.stabilityTimer !== undefined) clearTimeout(this.stabilityTimer)
    this.timer = undefined
    this.stabilityTimer = undefined
    const child = this.child
    this.child = undefined
    child?.kill('SIGTERM')
    this.setStatus('stopped', null)
  }

  private openTunnel(): void {
    if (!this.running) return
    this.attempts += 1
    this.setStatus(this.attempts === 1 ? 'starting' : 'reconnecting', null)
    let child: ChildProcess
    try {
      child = this.spawn('ssh', sshArgs(this.options), spawnOptions())
    } catch {
      this.retry('Unable to start SSH tunnel.')
      return
    }
    this.child = child
    let settled = false
    const failed = (reason: string): void => {
      if (settled || child !== this.child) return
      settled = true
      if (this.stabilityTimer !== undefined) clearTimeout(this.stabilityTimer)
      this.stabilityTimer = undefined
      this.child = undefined
      this.retry(reason)
    }
    child.once('error', () => { failed('SSH tunnel failed.') })
    child.once('exit', (code, signal) => {
      const detail = signal === null ? `SSH tunnel exited (${String(code)}).` : 'SSH tunnel exited.'
      failed(detail)
    })
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = undefined
      if (this.running && child === this.child && !settled) this.setStatus('online', null)
    }, this.options.stabilityDelayMs)
  }

  private retry(reason: string): void {
    if (!this.running) return
    if (this.attempts > this.options.reconnectMaxRetries) {
      this.setStatus('failed', 'SSH retry limit reached.')
      return
    }
    this.setStatus('reconnecting', reason)
    const exponential = Math.min(this.options.reconnectMaxMs, this.options.reconnectBaseMs * 2 ** (this.attempts - 1))
    const jitter = 0.8 + this.random() * 0.4
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.openTunnel()
    }, Math.round(exponential * jitter))
  }

  private setStatus(phase: TunnelStatus['phase'], reason: string | null): void {
    this.current = { phase, attempts: this.attempts, reason }
  }
}

export function sshArgs(options: Pick<TunnelSupervisorOptions, 'sshTarget' | 'remoteSocketPath' | 'localPort'>): string[] {
  return [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'StreamLocalBindUnlink=yes',
    '-o', 'StreamLocalBindMask=0117',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    '-R', `${options.remoteSocketPath}:127.0.0.1:${options.localPort}`,
    options.sshTarget,
  ]
}

function spawnOptions(): SpawnOptions {
  return { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
}
