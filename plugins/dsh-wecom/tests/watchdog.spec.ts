import { describe, expect, it, vi } from 'vitest'
import {
  AuthWatchdog,
  resolveWatchdogConfig,
  extractWatchdogCode,
  renderWatchdogAlert,
  type AuthWatchdogConfig,
  type WatchdogStatus,
} from '../src/watchdog.ts'
import { SILENT_LOGGER } from '../src/log.ts'

function makeWatchdog(config?: AuthWatchdogConfig) {
  const now = vi.fn(() => 1_000_000)
  const send = vi.fn(async (_alert: { kind: string; code?: string | undefined; detail?: string | undefined }) => {})
  const resolved = resolveWatchdogConfig(config)
  const watchdog = new AuthWatchdog({ config: resolved, send, now, log: SILENT_LOGGER })
  return { watchdog, now, send }
}

function tick(now: ReturnType<typeof vi.fn>, ms: number): void {
  now.mockReturnValue(now() + ms)
}

const authError = Object.assign(new Error('Authentication failed: invalid token (code: 853004)'), { code: 'UNUSED' }) as never
const authExhausted = Object.assign(new Error('Authentication failed (code: WS_AUTH_FAILURE_EXHAUSTED)'), { code: 'WS_AUTH_FAILURE_EXHAUSTED' }) as never
const reconnectExhausted = Object.assign(new Error('Reconnect attempts exhausted'), { code: 'WS_RECONNECT_EXHAUSTED' }) as never

describe('resolveWatchdogConfig', () => {
  it('applies safe defaults and bounds', () => {
    expect(resolveWatchdogConfig(undefined)).toEqual({
      enabled: true, checkIntervalMs: 60_000, minDowntimeMs: 120_000, alertCooldownMs: 3_600_000, alertChatId: undefined, webhookUrl: undefined,
    })
    expect(resolveWatchdogConfig({ enabled: false })).toMatchObject({ enabled: false })
    expect(resolveWatchdogConfig({ checkIntervalMs: -1, minDowntimeMs: 0, alertCooldownMs: 1 })).toMatchObject({
      checkIntervalMs: 5_000, minDowntimeMs: 5_000, alertCooldownMs: 30_000,
    })
    expect(resolveWatchdogConfig({ alertChatId: 'user-a', webhookUrl: 'https://hook' })).toMatchObject({ alertChatId: 'user-a', webhookUrl: 'https://hook' })
  })
})

describe('extractWatchdogCode', () => {
  it('prefers an explicit code property, then parses the SDK auth message', () => {
    expect(extractWatchdogCode(authExhausted)).toBe('WS_AUTH_FAILURE_EXHAUSTED')
    expect(extractWatchdogCode(Object.assign(new Error('boom'), { code: 'WS_RECONNECT_EXHAUSTED' }))).toBe('WS_RECONNECT_EXHAUSTED')
    expect(extractWatchdogCode(new Error('Authentication failed: denied (code: 853004)'))).toBe('853004')
    expect(extractWatchdogCode(new Error('errcode: 40001'))).toBe('40001')
    expect(extractWatchdogCode(undefined)).toBeUndefined()
    expect(extractWatchdogCode(new Error('plain'))).toBeUndefined()
  })
})

describe('renderWatchdogAlert', () => {
  it('produces a safe, guiding message that never embeds raw error detail', () => {
    const { summary, body } = renderWatchdogAlert({ kind: 'auth', code: '853004', detail: 'supersecret' })
    expect(summary).toContain('auth')
    expect(summary).toContain('853004')
    expect(body).toContain('90 天')
    expect(body).toContain('auth_data_permission')
    expect(body).not.toContain('supersecret')
  })
})

describe('AuthWatchdog state machine and alerting', () => {
  it('starts healthy, heals on authenticated, and surfaces degraded after an auth error', async () => {
    const { watchdog, now } = makeWatchdog()
    expect(watchdog.status()).toMatchObject({ enabled: true, state: 'healthy', alertCount: 0 })
    watchdog.observe({ type: 'authenticated' })
    expect(watchdog.status()).toMatchObject({ state: 'healthy' })
    watchdog.observe({ type: 'error', error: authExhausted })
    expect(watchdog.status()).toMatchObject({ state: 'degraded', kind: 'auth', code: 'WS_AUTH_FAILURE_EXHAUSTED', degradedSince: expect.any(Number) })
    // Below the alert threshold we do not alert yet.
    await watchdog.check()
    expect(watchdog.status()).toMatchObject({ state: 'degraded' })
  })

  it('fires exactly one alert only after minDowntime, and re-alerts after cooldown while still degraded', async () => {
    const { watchdog, now, send } = makeWatchdog()
    watchdog.observe({ type: 'error', error: authError })
    tick(now, 5_000)
    await watchdog.check()
    expect(send).not.toHaveBeenCalled()
    expect(watchdog.status()).toMatchObject({ alertCount: 0 })

    tick(now, 120_000) // crosses 5s minDowntime -> cumulative > minDowntime
    await watchdog.check()
    expect(send).toHaveBeenCalledTimes(1)
    expect(watchdog.status()).toMatchObject({ alertCount: 1, state: 'degraded' })
    expect(watchdog.status().lastAlertAt).toBe(now())

    // Cooldown not elapsed yet -> still degraded but no repeat alert.
    tick(now, 3_000)
    await watchdog.check()
    expect(send).toHaveBeenCalledTimes(1)

    // Cooldown elapsed -> reminder re-fires.
    tick(now, 3_600_000)
    await watchdog.check()
    expect(send).toHaveBeenCalledTimes(2)
    expect(watchdog.status()).toMatchObject({ alertCount: 2 })
  })

  it('treats a transient connection blip that heals before minDowntime as a non-event', async () => {
    const { watchdog, now, send } = makeWatchdog()
    watchdog.observe({ type: 'disconnected' })
    tick(now, 10_000)
    watchdog.observe({ type: 'connected' })
    expect(watchdog.status()).toMatchObject({ state: 'healthy' })
    tick(now, 120_000)
    await watchdog.check()
    expect(send).not.toHaveBeenCalled()
  })

  it('maps the SDK connection-exhausted code to a connection degradation', () => {
    const { watchdog } = makeWatchdog()
    watchdog.observe({ type: 'error', error: reconnectExhausted })
    expect(watchdog.status()).toMatchObject({ state: 'degraded', kind: 'connection', code: 'WS_RECONNECT_EXHAUSTED' })
  })

  it('classifies an unlabeled error without leaking its message', () => {
    const { watchdog } = makeWatchdog()
    watchdog.observe({ type: 'error', error: new Error('bot-secret and token body') })
    const status = watchdog.status()
    expect(status.state).toBe('degraded')
    expect(JSON.stringify(status)).not.toContain('bot-secret')
    expect(JSON.stringify(status)).not.toContain('token body')
  })

  it('notifyDataPermissionExpiry raises an immediate renewal reminder alert', async () => {
    const { watchdog, send } = makeWatchdog()
    const detail = '数据权限即将到期'
    await watchdog.notifyDataPermissionExpiry(detail)
    expect(send).toHaveBeenCalledTimes(1)
    const alert = send.mock.calls[0]![0] as unknown as { kind: string; code: string }
    expect(alert).toMatchObject({ kind: 'auth', code: 'auth_data_permission' })
    expect(watchdog.status()).toMatchObject({ state: 'degraded', kind: 'auth', code: 'auth_data_permission', alertCount: 1 })
  })

  it('is inert and reported as disabled when disabled', async () => {
    const { watchdog, send } = makeWatchdog({ enabled: false })
    expect(watchdog.status()).toMatchObject({ enabled: false, state: 'disabled' })
    watchdog.observe({ type: 'error', error: authError })
    watchdog.start()
    await watchdog.notifyDataPermissionExpiry()
    await watchdog.check()
    expect(send).not.toHaveBeenCalled()
    expect(watchdog.status()).toMatchObject({ state: 'disabled', alertCount: 0 })
    watchdog.stop()
  })

  it('start schedules a periodic check that alerts once the degradation matures', async () => {
    const { watchdog, now, send } = makeWatchdog({ checkIntervalMs: 5000 })
    vi.useFakeTimers()
    try {
      watchdog.observe({ type: 'disconnected' })
      watchdog.start()
      tick(now, 130_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect((watchdog.status() as WatchdogStatus).alertCount).toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      watchdog.stop()
      vi.useRealTimers()
    }
  })
})
