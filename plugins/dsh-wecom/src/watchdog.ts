/**
 * dsh-wecom authorization watchdog.
 *
 * WeCom authorization has two independent layers whose lifecycles must be
 * handled differently:
 *
 *  1. The WebSocket long-connection credential (botId + botSecret). The SDK
 *     (`@wecom/aibot-node-sdk`) already owns connect/auth/heartbeat/reconnect
 *     and surfaces typed `WS_AUTH_FAILURE_EXHAUSTED` / `WS_RECONNECT_EXHAUSTED`
 *     errors plus an `Authentication failed: ... (code: <errcode>)` error when
 *     the subscription handshake is rejected.
 *  2. WeCom "数据权限 / 定期授权" (data-permission periodic authorization), valid
 *     90 days. WeCom pushes an `auth_data_permission` (指令回调) event once, 7
 *     days before expiry, and shows admin-side reminders at 7/3/1 days and the
 *     expiry day; re-authorizing restarts the 90 days. This event is delivered
 *     over WeCom's HTTP callback (指令回调) server, not over the WS long
 *     connection, so this plugin cannot receive it in-process — see
 *     {@link AuthWatchdog.notifyDataPermissionExpiry} for the documented
 *     external wiring point and README for the backend settings to enable.
 *
 * This watchdog observes the WS lifecycle events the plugin already emits,
 * enters a `degraded` state when authorization becomes unavailable (auth
 * failure, an SDK error, or a connection that has been down for a while) and,
 * after a configurable `minDowntimeMs`, fires an alert to a configurable
 * destination (a WeCom chat via the existing bot, and/or a generic HTTP webhook
 * for log/email bridges). It never blocks the bot: it is purely observational
 * and reports.
 *
 * Privacy: the watchdog surfaces only a safe error *code* (an errcode integer
 * or a known SDK error code), never a message body, token, secret, or raw
 * frame.
 */

import type { WecomLifecycleEvent } from './bot.ts'
import type { Logger } from './log.ts'

/** What kind of degradation the watchdog currently believes it is seeing. */
export type WatchdogDegradedKind = 'auth' | 'connection' | 'unknown'
export type WatchdogState = 'initializing' | 'healthy' | 'degraded' | 'disabled'

/** Raw user-facing watchdoog settings. Every field is optional; see resolveWatchdogConfig. */
export interface AuthWatchdogConfig {
  /** Master switch. Defaults to true. */
  enabled?: boolean | undefined
  /** How often (ms) the watchdog re-evaluates degradation and re-alerts. Defaults to 60000. */
  checkIntervalMs?: number | undefined
  /** Sustain a degradation this long (ms) before alerting, filtering reconnect noise. Defaults to 120000. */
  minDowntimeMs?: number | undefined
  /** Minimum gap (ms) between repeated alerts while a degradation persists. Defaults to 3600000. */
  alertCooldownMs?: number | undefined
  /** WeCom chat id/userid to send alert messages to via the resident bot. Optional. */
  alertChatId?: string | undefined
  /** Generic HTTP(S) webhook (JSON POST) for log/email bridges. Optional. */
  webhookUrl?: string | undefined
}

export interface ResolvedWatchdogConfig {
  enabled: boolean
  checkIntervalMs: number
  minDowntimeMs: number
  alertCooldownMs: number
  alertChatId?: string | undefined
  webhookUrl?: string | undefined
}

/** Safe alert payload handed to the configured sink. Never contains secrets or frames. */
export interface WatchdogAlert {
  kind: WatchdogDegradedKind
  code?: string | undefined
  detail?: string | undefined
}

/** Observable watchdog state, exposed through the plugin status surface. */
export interface WatchdogStatus {
  enabled: boolean
  state: WatchdogState
  /** Timestamp when the current degradation started (undefined while healthy). */
  degradedSince?: number | undefined
  /** Last time the authorization was last confirmed healthy. */
  lastHealthyAt?: number | undefined
  /** Last time an alert was delivered. */
  lastAlertAt?: number | undefined
  /** Number of alerts delivered this process. */
  alertCount: number
  kind?: WatchdogDegradedKind | undefined
  /** The real WeCom errcode / SDK code observed, for diagnosis (may be absent). */
  code?: string | undefined
}

export interface WatchdogOptions {
  config: ResolvedWatchdogConfig
  /** Alert delivery hook (WeCom chat, webhook, log). */
  send: (alert: WatchdogAlert) => Promise<void>
  /** Injectable clock for tests. */
  now?: () => number
  log: Logger
}

const DEFAULT_CHECK_INTERVAL_MS = 60_000
const DEFAULT_MIN_DOWNTIME_MS = 120_000
const DEFAULT_ALERT_COOLDOWN_MS = 3_600_000

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Apply defaults and bounds to user-supplied watchdog settings. Kept pure so it
 * can be shared by config normalization and the lifecycle controller, and
 * unit-tested without a running plugin.
 */
export function resolveWatchdogConfig(raw?: AuthWatchdogConfig): ResolvedWatchdogConfig {
  const config = raw ?? {}
  return {
    enabled: config.enabled !== false,
    checkIntervalMs: clamp(config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS, 5_000, 3_600_000),
    minDowntimeMs: clamp(config.minDowntimeMs ?? DEFAULT_MIN_DOWNTIME_MS, 5_000, 24 * 3_600_000),
    alertCooldownMs: clamp(config.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS, 30_000, 7 * 24 * 3_600_000),
    alertChatId: config.alertChatId,
    webhookUrl: config.webhookUrl,
  }
}

/**
 * Extract a safe diagnostic code from an SDK/WS error. The smart-robot SDK
 * reports authentication failures as `Authentication failed: <errmsg> (code:
 * <errcode>)` and carries well-known typed codes (`WS_AUTH_FAILURE_EXHAUSTED`,
 * `WS_RECONNECT_EXHAUSTED`). We return only that code — never the surrounding
 * message, which may contain sensitive values.
 */
export function extractWatchdogCode(error: unknown): string | undefined {
  if (error == null) return undefined
  const maybe = error as { code?: unknown }
  if (typeof maybe.code === 'string' && maybe.code !== '') return maybe.code
  const message = typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error)
  const parenthesized = /\(code:\s*([^)]+)\)/i.exec(message)
  if (parenthesized?.[1] !== undefined) return parenthesized[1].trim()
  const errcode = /errcode[:=]\s*([0-9]+)/i.exec(message)
  if (errcode?.[1] !== undefined) return errcode[1]
  return undefined
}

function classifyError(error: unknown): { kind: WatchdogDegradedKind; code?: string | undefined } {
  const code = extractWatchdogCode(error)
  if (code === 'WS_AUTH_FAILURE_EXHAUSTED') return { kind: 'auth', code }
  const message = typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error ?? '')
  if (/authentication failed|auth.?fail|凭证|secret|gettoken/i.test(message)) return { kind: 'auth', code }
  if (code === 'WS_RECONNECT_EXHAUSTED') return { kind: 'connection', code }
  return { kind: 'unknown', code }
}

/**
 * Build a safe, human-readable alert message. `summary` is a one-line log
 * caption; `body` is a Markdown message for the WeCom chat / webhook.
 */
export function renderWatchdogAlert(alert: WatchdogAlert): { summary: string; body: string } {
  const kindLabel: Record<WatchdogDegradedKind, string> = {
    auth: '授权/认证',
    connection: '长连接',
    unknown: '未知',
  }
  const codeLine = alert.code ? `- 诊断错误码：\`${alert.code}\`\n` : ''
  const authGuidance =
    alert.kind === 'auth'
      ? '该错误可能表示机器人凭据无效，或**数据权限定期授权（90 天）**已到期。若凭据正确，请在企微管理后台重新进行数据权限授权，授权后 90 天周期重新开始。企微会在到期前 7 天推送 `auth_data_permission` 指令回调事件。'
      : alert.kind === 'connection'
        ? '长连接层异常。请检查网络与机器人凭据后重启插件。'
        : '请结合日志中的诊断错误码判断。'
  const summary = `WeCom authorization degraded (${alert.kind}${alert.code ? ` code=${alert.code}` : ''})`
  const body = [
    '**WeCom 授权监控告警**',
    '',
    '当前授权/连接状态已降级（degraded），机器人可能静默停止工作。',
    '',
    `- 类型：${kindLabel[alert.kind]}`,
    codeLine,
    authGuidance,
    '',
    '详细诊断请参考插件运维文档中「授权监控与诊断」一节。',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return { summary, body }
}

export class AuthWatchdog {
  private degradedSince: number | undefined
  private lastHealthyAt: number | undefined
  private healthyObserved = false
  private lastAlertAt: number | undefined
  private alertCount = 0
  private kind: WatchdogDegradedKind | undefined
  private code: string | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly now: () => number
  private readonly log: Logger

  constructor(private readonly options: WatchdogOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log
  }

  observe(event: WecomLifecycleEvent): void {
    if (!this.options.config.enabled) return
    switch (event.type) {
      case 'authenticated':
      case 'connected':
        this.heal()
        break
      case 'error':
        this.beginDegradation(classifyError(event.error))
        break
      case 'disconnected':
      case 'reconnecting':
        this.beginDegradation({ kind: 'connection' })
        break
      default:
        break
    }
  }

  private heal(): void {
    if (this.degradedSince !== undefined || this.kind !== undefined) {
      this.log.info('watchdog: authorization healthy', { kind: this.kind, code: this.code })
    }
    this.degradedSince = undefined
    this.kind = undefined
    this.code = undefined
    this.healthyObserved = true
    this.lastHealthyAt = this.now()
  }

  private beginDegradation(signal: { kind: WatchdogDegradedKind; code?: string | undefined }): void {
    this.kind = signal.kind
    if (signal.code !== undefined && signal.code !== '') this.code = signal.code
    if (this.degradedSince === undefined) {
      this.degradedSince = this.now()
      this.log.warn('watchdog: degradation began', { kind: signal.kind, code: this.code })
    }
  }

  /**
   * Periodic evaluation (and any alerting). Called by the watchdog's own timer
   * and available for manual/test invocation.
   */
  async check(): Promise<void> {
    if (!this.options.config.enabled) return
    if (this.degradedSince === undefined) return
    const at = this.now()
    if (at - this.degradedSince < this.options.config.minDowntimeMs) return
    const cooldownOk = this.lastAlertAt === undefined || at - this.lastAlertAt >= this.options.config.alertCooldownMs
    if (!cooldownOk) return
    await this.fireNow(this.kind ?? 'unknown', this.code)
  }

  /**
   * Proactive data-permission renewal reminder. This is the extension point for
   * WeCom's `auth_data_permission` (指令回调) expiry event: an operator-run HTTP
   * callback receiver that enables WeCom's callback server (see README) should
   * call this with the detail it received so an in-process reminder fires even
   * though the plugin itself hosts no callback server. Unlike a normal
   * degradation, it alerts immediately instead of waiting for `minDowntimeMs`.
   */
  async notifyDataPermissionExpiry(detail = '数据权限定期授权（90 天）可能即将到期，请在企微管理后台重新授权'): Promise<void> {
    if (!this.options.config.enabled) return
    this.configAuthSignal()
    this.log.warn('watchdog: data-permission expiry reminder', { code: 'auth_data_permission' })
    await this.fireNow('auth', 'auth_data_permission', detail)
  }

  private configAuthSignal(): void {
    this.kind = 'auth'
    this.code = 'auth_data_permission'
    if (this.degradedSince === undefined) this.degradedSince = this.now()
  }

  private async fireNow(kind: WatchdogDegradedKind, code: string | undefined, detail?: string): Promise<void> {
    this.lastAlertAt = this.now()
    this.alertCount += 1
    try {
      await this.options.send({ kind, code, detail })
    } catch (error) {
      this.log.error('watchdog alert delivery failed', { kind: error instanceof Error ? error.name : 'UnknownError' })
    }
  }

  start(): void {
    if (!this.options.config.enabled || this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.check()
    }, this.options.config.checkIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  status(): WatchdogStatus {
    const enabled = this.options.config.enabled
    return {
      enabled,
      state: !enabled
        ? 'disabled'
        : this.degradedSince !== undefined
          ? 'degraded'
          : this.healthyObserved ? 'healthy' : 'initializing',
      degradedSince: this.degradedSince,
      lastHealthyAt: this.lastHealthyAt,
      lastAlertAt: this.lastAlertAt,
      alertCount: this.alertCount,
      kind: this.kind,
      code: this.code,
    }
  }

  dispose(): void {
    this.stop()
  }
}
