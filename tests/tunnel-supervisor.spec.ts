import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sshArgs, TunnelSupervisor } from '../src/tunnel-supervisor.ts'

afterEach(() => { vi.useRealTimers() })

describe('TunnelSupervisor', () => {
  it('uses argument-array SSH hardening and stops after its bounded retry count', async () => {
    vi.useFakeTimers()
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ChildProcess
    })
    const supervisor = new TunnelSupervisor({
      sshTarget: 'vps-tencent-tokyo',
      remoteSocketPath: '/var/run/dsh-remote/dsh.sock',
      localPort: 4100,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      reconnectMaxRetries: 1,
      stabilityDelayMs: 250,
      spawn: spawn as never,
      random: () => 0,
    })

    supervisor.start()
    expect(spawn).toHaveBeenCalledWith('ssh', sshArgs({ sshTarget: 'vps-tencent-tokyo', remoteSocketPath: '/var/run/dsh-remote/dsh.sock', localPort: 4100 }), expect.objectContaining({ shell: false, stdio: ['ignore', 'ignore', 'ignore'] }))
    expect(supervisor.status()).toMatchObject({ phase: 'starting', attempts: 1 })

    children[0]?.emit('exit', 255, null)
    expect(supervisor.status()).toMatchObject({ phase: 'reconnecting', attempts: 1 })
    await vi.advanceTimersByTimeAsync(80)
    expect(children).toHaveLength(2)
    children[1]?.emit('exit', 255, null)
    expect(supervisor.status()).toMatchObject({ phase: 'failed', attempts: 2, reason: 'SSH retry limit reached.' })
  })

  it('reports online only after the configured stability interval survives', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const supervisor = new TunnelSupervisor({
      sshTarget: 'dsh@vps-tencent-tokyo',
      remoteSocketPath: '/home/chriswang/.local/share/dsh-remote/tunnel.sock',
      localPort: 4100,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      reconnectMaxRetries: 1,
      stabilityDelayMs: 250,
      spawn: vi.fn(() => child as unknown as ChildProcess) as never,
      random: () => 0,
    })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(249)
    expect(supervisor.status()).toMatchObject({ phase: 'starting', attempts: 1 })
    await vi.advanceTimersByTimeAsync(1)
    expect(supervisor.status()).toMatchObject({ phase: 'online', attempts: 1, reason: null })
  })
})

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true)
}
