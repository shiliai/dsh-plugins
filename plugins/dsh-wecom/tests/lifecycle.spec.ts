import { describe, expect, it, vi } from 'vitest'
import { WecomLifecycleController } from '../src/lifecycle.ts'
import { normalizeConfig, type Config } from '../src/index.ts'
import type { WecomLifecycleEvent } from '../src/bot.ts'

class FakeBot {
  readonly listeners = new Set<(event: WecomLifecycleEvent) => void>()
  starts = 0
  disconnects = 0
  constructor(private readonly fails = false) {}
  onLifecycle(listener: (event: WecomLifecycleEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async start(_handler: unknown) { this.starts += 1; if (this.fails) throw new Error('credential secret must not leak') }
  disconnect() { this.disconnects += 1 }
  async sendText() {}
  emit(event: WecomLifecycleEvent) { for (const listener of this.listeners) listener(event) }
}

function config(overrides: Partial<Config> = {}): Config {
  return { botId: 'bot-123456', botSecret: 'secret-value', ...overrides }
}

describe('WecomLifecycleController', () => {
  it('normalizes an invalid runtime log level to the former info default', () => {
    const normalized = normalizeConfig({ ...config(), logLevel: 'verbose' as never })
    expect(normalized.logLevel).toBe('info')
  })

  it('keeps missing credentials observable without exposing a secret', async () => {
    const controller = new WecomLifecycleController({} as never, config({ botSecret: '' }), '0.1.1')
    const status = await controller.start()
    expect(status).toMatchObject({ state: 'unconfigured', version: '0.1.1' })
    expect(status.error).toContain('WECOM_BOT_SECRET')
    expect(JSON.stringify(status)).not.toContain('secret-value')
  })

  it('maps connection lifecycle events and timestamps without leaking runtime errors', async () => {
    const bot = new FakeBot()
    const bridge = { dispose: vi.fn(async () => {}) }
    const controller = new WecomLifecycleController({} as never, config(), '0.1.1', () => bot as never, () => bridge as never)
    expect((await controller.start()).state).toBe('connecting')
    bot.emit({ type: 'authenticated' })
    expect(controller.getStatus()).toMatchObject({ state: 'online', authenticatedAt: expect.any(Number), botIdentity: 'bot-...' })
    bot.emit({ type: 'reconnecting' })
    expect(controller.getStatus().state).toBe('reconnecting')
    bot.emit({ type: 'disconnected' })
    expect(controller.getStatus()).toMatchObject({ state: 'offline', disconnectedAt: expect.any(Number) })
    bot.emit({ type: 'error', error: new Error('secret-value and message body') })
    expect(controller.getStatus().state).toBe('error')
    expect(JSON.stringify(controller.getStatus())).not.toContain('secret-value')
  })

  it('serializes repeated restarts and disposes the old pair before one replacement', async () => {
    const bots: FakeBot[] = []
    const bridges: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
    const controller = new WecomLifecycleController(
      {} as never, config(), '0.1.1',
      () => { const bot = new FakeBot(); bots.push(bot); return bot as never },
      () => { const bridge = { dispose: vi.fn(async () => {}) }; bridges.push(bridge); return bridge as never },
    )
    await controller.start()
    await Promise.all([controller.restart(), controller.restart(), controller.restart()])
    expect(bots).toHaveLength(2)
    expect(bots[0]!.disconnects).toBe(1)
    expect(bridges[0]!.dispose).toHaveBeenCalledOnce()
    expect(bots[1]!.starts).toBe(1)
  })

  it('recovers from a failed replacement on a later restart without retaining the failed connection', async () => {
    const bots = [new FakeBot(true), new FakeBot()]
    const controller = new WecomLifecycleController({} as never, config(), '0.1.1', () => bots.shift()! as never, () => ({ dispose: async () => {} }) as never)
    expect((await controller.start()).state).toBe('error')
    expect((await controller.restart()).state).toBe('connecting')
    expect(bots).toHaveLength(0)
  })

  it('reports a safe error when disposal prevents replacement', async () => {
    const bot = new FakeBot()
    const controller = new WecomLifecycleController({} as never, config(), '0.1.1', () => bot as never, () => ({ dispose: async () => { throw new Error('secret-value') } }) as never)
    await controller.start()
    const status = await controller.restart()
    expect(status.state).toBe('error')
    expect(status.error).toContain('Previous connection could not stop')
    expect(JSON.stringify(status)).not.toContain('secret-value')
  })
})
