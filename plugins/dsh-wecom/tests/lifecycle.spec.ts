import { describe, expect, it, vi } from 'vitest'
import { WecomLifecycleController } from '../src/lifecycle.ts'
import { normalizeConfig, type Config } from '../src/index.ts'
import type { WecomLifecycleEvent } from '../src/bot.ts'

class FakeBot {
  readonly listeners = new Set<(event: WecomLifecycleEvent) => void>()
  starts = 0
  disconnects = 0
  disconnectError: Error | undefined
  constructor(private readonly fails = false) {}
  onLifecycle(listener: (event: WecomLifecycleEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async start(_handler: unknown) { this.starts += 1; if (this.fails) throw new Error('credential secret must not leak') }
  disconnect() { this.disconnects += 1; if (this.disconnectError) throw this.disconnectError }
  async sendText() {}
  emit(event: WecomLifecycleEvent) { for (const listener of this.listeners) listener(event) }
}

function config(overrides: Partial<Config> = {}): Config {
  return { botId: 'bot-123456', botSecret: 'secret-value', ...overrides }
}

function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(next => { resolve = next }), resolve }
}

describe('WecomLifecycleController', () => {
  it('normalizes invalid runtime configuration and preserves local trusted origin', () => {
    const normalized = normalizeConfig({ ...config(), logLevel: 'verbose' as never })
    expect(normalized).toMatchObject({ logLevel: 'info', managementOrigin: 'http://127.0.0.1:3180' })
  })

  it('keeps missing credentials observable with profile-restart remediation', async () => {
    const createBot = vi.fn(() => new FakeBot() as never)
    const controller = new WecomLifecycleController({} as never, config({ botSecret: '' }), '0.2.0', createBot)
    const status = await controller.start()
    expect(status).toMatchObject({ state: 'unconfigured', version: '0.2.0' })
    expect(status.error).toContain('restart the DSH profile')
    expect(createBot).not.toHaveBeenCalled()
  })

  it('maps lifecycle events with fixed diagnostic categories despite hostile error names', async () => {
    const bot = new FakeBot()
    const controller = new WecomLifecycleController({} as never, config(), '0.2.0', () => bot as never, () => ({ dispose: async () => {} }) as never)
    await controller.start()
    bot.emit({ type: 'authenticated' })
    expect(controller.getStatus()).toMatchObject({ state: 'online', authenticatedAt: expect.any(Number) })
    const hostile = new Error('secret-value and message body')
    hostile.name = 'token-value'
    bot.emit({ type: 'error', error: hostile })
    expect(controller.getStatus()).toMatchObject({ state: 'error', error: 'Connection failure. Check credentials and network, then restart.' })
    expect(JSON.stringify(controller.getStatus())).not.toContain('token-value')
  })

  it('reports the exact startup stage with a stable secret-free code', async () => {
    const bot = new FakeBot()
    bot.start = async () => { throw new Error('credential secret-value must not leak') }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new WecomLifecycleController(
      {} as never, config(), '0.5.0', () => bot as never,
      () => ({ dispose: async () => {} }) as never,
    )

    try {
      const status = await controller.start()
      expect(status).toMatchObject({
        state: 'error', startupStage: 'connect', diagnosticCode: 'STARTUP_CONNECT',
      })
      expect(JSON.stringify(status)).not.toContain('secret-value')
      expect(logged.mock.calls.flat().join('\n')).not.toContain('secret-value')
      expect(logged.mock.calls.flat().join('\n')).toContain('[redacted]')
    } finally {
      logged.mockRestore()
    }
  })

  it('keeps connection startup available when optional question setup fails', async () => {
    const bot = new FakeBot()
    const controller = new WecomLifecycleController(
      {} as never, config(), '0.5.0', () => bot as never,
      () => ({
        registerUserQuestionsProvider: async () => { throw new Error('optional failure') },
        dispose: async () => {},
      }) as never,
    )

    const status = await controller.start()

    expect(bot.starts).toBe(1)
    expect(status).toMatchObject({
      state: 'connecting', startupStage: 'connect', questionCapability: 'degraded',
    })
  })

  it('serializes repeated restarts and returns completed snapshots with restarting false', async () => {
    const bots: FakeBot[] = []
    const bridges: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
    const controller = new WecomLifecycleController(
      {} as never, config(), '0.2.0',
      () => { const bot = new FakeBot(); bots.push(bot); return bot as never },
      () => { const bridge = { dispose: vi.fn(async () => {}) }; bridges.push(bridge); return bridge as never },
    )
    await controller.start()
    const results = await Promise.all([controller.restart(), controller.restart(), controller.restart()])
    expect(bots).toHaveLength(2)
    expect(bots[0]!.disconnects).toBe(1)
    expect(bridges[0]!.dispose).toHaveBeenCalledOnce()
    expect(results.every(status => status.restarting === false)).toBe(true)
  })

  it('reports restarting only while the serialized restart is in flight', async () => {
    const bot = new FakeBot()
    const stopping = deferred()
    const controller = new WecomLifecycleController({} as never, config(), '0.2.0', () => bot as never, () => ({ dispose: () => stopping.promise }) as never)
    await controller.start()
    const restart = controller.restart()
    expect(controller.getStatus().restarting).toBe(true)
    stopping.resolve()
    expect((await restart).restarting).toBe(false)
    expect(controller.getStatus().restarting).toBe(false)
  })

  it('attempts disconnect and agent disposal independently, retains failures, and retries before replacement', async () => {
    const first = new FakeBot()
    first.disconnectError = new Error('secret-value')
    const firstBridge = { dispose: vi.fn(async () => { throw new Error('message body') }) }
    const second = new FakeBot()
    const botQueue = [first, second]
    const bridgeQueue = [firstBridge, { dispose: async () => {} }]
    const createBot = vi.fn(() => botQueue.shift()! as never)
    const createBridge = vi.fn(() => bridgeQueue.shift()! as never)
    const controller = new WecomLifecycleController({} as never, config(), '0.2.0', createBot, createBridge)
    await controller.start()
    const failed = await controller.restart()
    expect(failed).toMatchObject({ state: 'error', error: 'Cleanup failure. Check plugin status and restart once more.', restarting: false })
    expect(first.disconnects).toBe(1)
    expect(firstBridge.dispose).toHaveBeenCalledOnce()
    expect(createBot).toHaveBeenCalledTimes(1)
    first.disconnectError = undefined
    firstBridge.dispose = vi.fn(async () => {})
    await controller.restart()
    expect(createBot).toHaveBeenCalledTimes(2)
  })

  it('prevents a replacement when terminal disposal races restart', async () => {
    const bots: FakeBot[] = []
    const stopping = deferred()
    const controller = new WecomLifecycleController(
      {} as never, config(), '0.2.0',
      () => { const bot = new FakeBot(); bots.push(bot); return bot as never },
      () => ({ dispose: () => stopping.promise }) as never,
    )
    await controller.start()
    const dispose = controller.dispose()
    const restart = controller.restart()
    stopping.resolve()
    await Promise.all([dispose, restart])
    expect(bots).toHaveLength(1)
    expect(controller.getStatus()).toMatchObject({ state: 'offline', restarting: false })
  })

  it('feeds lifecycle events to the authorization watchdog and surfaces its status', async () => {
    const bot = new FakeBot()
    const controller = new WecomLifecycleController({} as never, config(), '0.2.0', () => bot as never, () => ({ dispose: async () => {} }) as never)
    await controller.start()
    expect(controller.getStatus().watchdog).toMatchObject({ enabled: true, state: 'initializing' })
    bot.emit({ type: 'error', error: new Error('Authentication failed (code: 853004)') })
    expect(controller.getStatus().watchdog).toMatchObject({ state: 'degraded', kind: 'auth', code: '853004' })
    // Healthy events heal the watchdog.
    bot.emit({ type: 'authenticated' })
    expect(controller.getStatus().watchdog).toMatchObject({ state: 'healthy' })
  })

  it('reflects a watchdog disabled via config', async () => {
    const bot = new FakeBot()
    const controller = new WecomLifecycleController({} as never, config({ authWatchdog: { enabled: false } }), '0.2.0', () => bot as never, () => ({ dispose: async () => {} }) as never)
    await controller.start()
    expect(controller.getStatus().watchdog).toMatchObject({ enabled: false, state: 'disabled' })
    bot.emit({ type: 'error', error: new Error('Authentication failed (code: 853004)') })
    expect(controller.getStatus().watchdog).toMatchObject({ state: 'disabled' })
  })
})
