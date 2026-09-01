import type { Context } from '@deepseek-ai/cordis'
import { WecomAgentBridge, type Config } from './index.ts'
import { WecomBot } from './bot.ts'
import { isAllowed, safeErrorKind } from './safety.ts'
import { makeLogger } from './log.ts'
import type { InboundMessage } from './bot.ts'
import { AuthWatchdog, resolveWatchdogConfig, renderWatchdogAlert, type WatchdogAlert, type WatchdogStatus } from './watchdog.ts'

export type WecomConnectionState = 'unconfigured' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'error'

/** The complete browser-facing contract. It deliberately has no secret or frame fields. */
export interface WecomStatus {
  state: WecomConnectionState
  changedAt: number
  authenticatedAt?: number | undefined
  disconnectedAt?: number | undefined
  error?: string | undefined
  botIdentity?: string | undefined
  restarting: boolean
  version: string
  /** Authorization watchdog state. */
  watchdog?: WatchdogStatus | undefined
}

type Snapshot = Omit<WecomStatus, 'restarting'>
type RunningPair = { bot: WecomBot; bridge?: WecomAgentBridge | undefined }

const DIAGNOSTIC = {
  unconfigured: 'Configure WECOM_BOT_ID and WECOM_BOT_SECRET in the DSH profile environment, then restart the DSH profile.',
  disconnected: 'Connection closed. Use Restart if it does not reconnect.',
  startup: 'Startup failure. Check credentials and network, then restart.',
  connection: 'Connection failure. Check credentials and network, then restart.',
  cleanup: 'Cleanup failure. Check plugin status and restart once more.',
} as const

export class WecomLifecycleController {
  private current: RunningPair | undefined
  private lifecycleOperation: Promise<void> = Promise.resolve()
  private restartTask: Promise<WecomStatus> | undefined
  private terminalDispose = false
  private snapshot: Snapshot
  private readonly log = makeLogger('info')
  private readonly watchdog: AuthWatchdog

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly version: string,
    private readonly createBot: (config: Config) => WecomBot = config => new WecomBot({ botId: config.botId, botSecret: config.botSecret, logLevel: config.logLevel ?? 'info' }),
    private readonly createBridge: (ctx: Context, bot: WecomBot, config: Config) => WecomAgentBridge = (ctx, bot, config) => new WecomAgentBridge(ctx, bot, config),
  ) {
    this.snapshot = this.unconfigured() ?? this.status('offline')
    this.watchdog = new AuthWatchdog({
      config: resolveWatchdogConfig(config.authWatchdog),
      send: (alert) => this.deliverAlert(alert),
      log: this.log,
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycleOperation.then(operation, operation)
    this.lifecycleOperation = next.catch(() => undefined)
    return next
  }

  private unconfigured(): Snapshot | undefined {
    if (this.config.botId && this.config.botSecret) return undefined
    return this.status('unconfigured', { error: DIAGNOSTIC.unconfigured })
  }

  private status(state: WecomConnectionState, details: Partial<Snapshot> = {}): Snapshot {
    return { state, changedAt: Date.now(), version: this.version, ...details }
  }

  private update(state: WecomConnectionState, details: Partial<Snapshot> = {}): void {
    this.snapshot = this.status(state, {
      authenticatedAt: this.snapshot.authenticatedAt,
      disconnectedAt: this.snapshot.disconnectedAt,
      botIdentity: this.snapshot.botIdentity,
      ...details,
    })
  }

  getStatus(): WecomStatus {
    return { ...this.snapshot, watchdog: this.watchdog.status(), restarting: !this.terminalDispose && this.restartTask !== undefined }
  }

  async start(): Promise<WecomStatus> {
    await this.enqueue(async () => {
      if (this.terminalDispose || this.current !== undefined) return
      const unavailable = this.unconfigured()
      if (unavailable !== undefined) this.snapshot = unavailable
      else await this.startReplacement()
    })
    this.watchdog.start()
    return this.getStatus()
  }

  private async startReplacement(): Promise<void> {
    if (this.terminalDispose) return
    this.update('connecting', { error: undefined, botIdentity: this.redactedIdentity() })
    let bot: WecomBot | undefined
    try {
      bot = this.createBot(this.config)
      bot.onLifecycle(event => {
        this.watchdog.observe(event)
        if (this.current?.bot !== bot) return
        if (event.type === 'connected') this.update('connecting', { error: undefined })
        if (event.type === 'authenticated') this.update('online', { authenticatedAt: Date.now(), error: undefined })
        if (event.type === 'reconnecting') this.update('reconnecting', { error: undefined })
        if (event.type === 'disconnected') this.update('offline', { disconnectedAt: Date.now(), error: DIAGNOSTIC.disconnected })
        if (event.type === 'error') this.update('error', { error: DIAGNOSTIC.connection })
      })
      this.current = { bot }
      const bridge = this.createBridge(this.ctx, bot, this.config)
      this.current.bridge = bridge
      await bot.start(async message => {
        if (!this.isInboundAuthorized(message)) return
        await bridge.enqueue(message)
      })
      if (this.terminalDispose) await this.teardownCurrent()
    } catch {
      await this.teardownCurrent()
      this.update('error', { error: DIAGNOSTIC.startup })
    }
  }

  /** Attempt every cleanup action; leave failed resources attached for a later retry. */
  private async teardownCurrent(): Promise<AggregateError | undefined> {
    const current = this.current
    if (current === undefined) return undefined
    const operations: Array<Promise<unknown>> = [Promise.resolve().then(() => current.bot.disconnect())]
    if (current.bridge !== undefined) operations.push(Promise.resolve().then(() => current.bridge!.dispose()))
    const settled = await Promise.allSettled(operations)
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      this.update('error', { error: DIAGNOSTIC.cleanup })
      return new AggregateError(failures, 'dsh-wecom cleanup failed')
    }
    if (this.current === current) this.current = undefined
    return undefined
  }

  private redactedIdentity(): string | undefined {
    if (!this.config.botId) return undefined
    return this.config.botId.length <= 4 ? 'configured' : `${this.config.botId.slice(0, 4)}...`
  }

  private isInboundAuthorized(message: InboundMessage): boolean {
    if (message.chatType === 'group') return isAllowed(message.chatId, this.config.allowChats) && isAllowed(message.senderId, this.config.allowGroupSenders)
    return isAllowed(message.chatId, this.config.allowChats) || isAllowed(message.senderId, this.config.allowChats)
  }

  async restart(): Promise<WecomStatus> {
    if (this.terminalDispose) return this.getStatus()
    if (this.restartTask !== undefined) return this.restartTask
    const run = this.enqueue(async () => {
      if (this.terminalDispose) return
      const unavailable = this.unconfigured()
      if (unavailable !== undefined) {
        this.snapshot = unavailable
        return
      }
      if ((await this.teardownCurrent()) !== undefined || this.terminalDispose) return
      await this.startReplacement()
    })
    const result = run.then(() => {
      if (this.restartTask === result) this.restartTask = undefined
      return this.getStatus()
    }, () => {
      this.update('error', { error: DIAGNOSTIC.cleanup })
      if (this.restartTask === result) this.restartTask = undefined
      return this.getStatus()
    })
    this.restartTask = result
    return result
  }

  async sendText(chatId: string, content: string): Promise<void> {
    if (this.current === undefined) throw new Error('dsh-wecom: WeCom connection is unavailable')
    await this.current.bot.sendText(chatId, content)
  }

  /** Distribute a watchdog alert to every configured destination (log always, WeCom chat and/or webhook). */
  private async deliverAlert(alert: WatchdogAlert): Promise<void> {
    const { summary, body } = renderWatchdogAlert(alert)
    this.log.error(`watchdog alert: ${summary}`)
    const settings = this.config.authWatchdog ?? {}
    const chatId = settings.alertChatId
    if (chatId) {
      if (this.current === undefined) {
        this.log.warn('watchdog alert not delivered to WeCom chat: connection unavailable', { chatId })
      } else {
        try {
          await this.current.bot.sendText(chatId, body)
          this.log.info('watchdog alert delivered to WeCom chat', { chatId })
        } catch (error) {
          this.log.error('watchdog WeCom chat delivery failed', { chatId, kind: safeErrorKind(error) })
        }
      }
    }
    const webhookUrl = settings.webhookUrl
    if (webhookUrl) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: body, summary, kind: alert.kind, code: alert.code, detail: alert.detail ?? null, at: new Date().toISOString() }),
        })
        if (!response.ok) this.log.warn('watchdog webhook alert non-ok response', { status: response.status })
      } catch (error) {
        this.log.error('watchdog webhook delivery failed', { kind: safeErrorKind(error) })
      }
    }
  }

  async dispose(): Promise<void> {
    this.terminalDispose = true
    this.watchdog.dispose()
    await this.enqueue(async () => {
      const cleanupFailure = await this.teardownCurrent()
      if (cleanupFailure === undefined) this.update('offline', { disconnectedAt: Date.now(), error: undefined })
    })
  }
}
