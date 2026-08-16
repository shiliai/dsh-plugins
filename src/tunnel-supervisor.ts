import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { TunnelStatus } from './contracts.ts'

export type RemoteCommandRunner = (args: string[]) => Promise<void>

export interface TunnelSupervisorOptions {
  sshTarget: string
  remoteSocketPath: string
  localPort: number
  reconnectBaseMs: number
  reconnectMaxMs: number
  reconnectMaxRetries: number
  stabilityDelayMs: number
  spawn?: typeof nodeSpawn
  remoteCommand?: RemoteCommandRunner
  random?: () => number
}

export class TunnelSupervisor {
  private readonly spawn: typeof nodeSpawn
  private readonly remoteCommand: RemoteCommandRunner
  private readonly random: () => number
  private child: ChildProcess | undefined
  private timer: NodeJS.Timeout | undefined
  private stabilityTimer: NodeJS.Timeout | undefined
  private running = false
  private generation = 0
  private attempts = 0
  private current: TunnelStatus = { phase: 'stopped', attempts: 0, reason: null }

  constructor(private readonly options: TunnelSupervisorOptions) {
    this.spawn = options.spawn ?? nodeSpawn
    this.remoteCommand = options.remoteCommand ?? runSshCommand
    this.random = options.random ?? Math.random
  }

  status(): TunnelStatus {
    return { ...this.current }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.generation += 1
    this.attempts = 0
    void this.openTunnel(this.generation)
  }

  reconnect(): void {
    this.stop()
    this.start()
  }

  stop(): void {
    this.running = false
    this.generation += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.stabilityTimer !== undefined) clearTimeout(this.stabilityTimer)
    this.timer = undefined
    this.stabilityTimer = undefined
    const child = this.child
    this.child = undefined
    child?.kill('SIGTERM')
    this.setStatus('stopped', null)
  }

  private async openTunnel(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return
    this.attempts += 1
    this.setStatus(this.attempts === 1 ? 'starting' : 'reconnecting', null)
    try {
      await this.remoteCommand(socketCleanupArgs(this.options))
    } catch {
      if (this.isCurrent(generation)) this.retry('Unable to prepare remote socket.', generation)
      return
    }
    if (!this.isCurrent(generation)) return
    let child: ChildProcess
    try {
      child = this.spawn('ssh', sshArgs(this.options), spawnOptions())
    } catch {
      this.retry('Unable to start SSH tunnel.', generation)
      return
    }
    this.child = child
    let settled = false
    const failed = (reason: string, terminate = false): void => {
      if (settled || child !== this.child) return
      settled = true
      if (this.stabilityTimer !== undefined) clearTimeout(this.stabilityTimer)
      this.stabilityTimer = undefined
      this.child = undefined
      if (terminate) child.kill('SIGTERM')
      this.retry(reason, generation)
    }
    child.once('error', () => { failed('SSH tunnel failed.') })
    child.once('exit', (code, signal) => {
      const detail = signal === null ? `SSH tunnel exited (${String(code)}).` : 'SSH tunnel exited.'
      failed(detail)
    })
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = undefined
      if (!this.isCurrent(generation) || child !== this.child || settled) return
      void this.remoteCommand(socketModeArgs(this.options)).then(() => {
        if (this.isCurrent(generation) && child === this.child && !settled) this.setStatus('online', null)
      }).catch(() => {
        failed('Unable to secure remote socket.', true)
      })
    }, this.options.stabilityDelayMs)
  }

  private retry(reason: string, generation: number): void {
    if (!this.isCurrent(generation)) return
    if (this.attempts > this.options.reconnectMaxRetries) {
      this.setStatus('failed', 'SSH retry limit reached.')
      return
    }
    this.setStatus('reconnecting', reason)
    const exponential = Math.min(this.options.reconnectMaxMs, this.options.reconnectBaseMs * 2 ** (this.attempts - 1))
    const jitter = 0.8 + this.random() * 0.4
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.openTunnel(generation)
    }, Math.round(exponential * jitter))
  }

  private setStatus(phase: TunnelStatus['phase'], reason: string | null): void {
    this.current = { phase, attempts: this.attempts, reason }
  }

  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation
  }
}

export function sshArgs(options: Pick<TunnelSupervisorOptions, 'sshTarget' | 'remoteSocketPath' | 'localPort'>): string[] {
  return [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    '-R', `${options.remoteSocketPath}:127.0.0.1:${options.localPort}`,
    options.sshTarget,
  ]
}

export function socketCleanupArgs(options: Pick<TunnelSupervisorOptions, 'sshTarget' | 'remoteSocketPath'>): string[] {
  return [...remoteCommandBase(), options.sshTarget, 'rm', '-f', '--', options.remoteSocketPath]
}

export function socketModeArgs(options: Pick<TunnelSupervisorOptions, 'sshTarget' | 'remoteSocketPath'>): string[] {
  return [...remoteCommandBase(), options.sshTarget, 'chmod', '0660', '--', options.remoteSocketPath]
}

function spawnOptions(): SpawnOptions {
  return { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
}

function remoteCommandBase(): string[] {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10']
}

function runSshCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: 15_000, windowsHide: true }, error => {
      if (error === null) resolve()
      else reject(new Error('Remote socket command failed.'))
    })
  })
}
