import type { Context } from '@deepseek-ai/cordis'
import { WecomAgentBridge, type Config } from './index.ts'
import { WecomBot } from './bot.ts'
import { isAllowed, safeErrorKind } from './safety.ts'
import type { InboundMessage } from './bot.ts'

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
}

type RunningPair = { bot: WecomBot; bridge: WecomAgentBridge }

export class WecomLifecycleController {
  private current: RunningPair | undefined
  private restartTask: Promise<WecomStatus> | undefined
  private snapshot: WecomStatus

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly version: string,
    private readonly createBot: (config: Config) => WecomBot = config => new WecomBot({ botId: config.botId, botSecret: config.botSecret, logLevel: config.logLevel ?? 'info' }),
    private readonly createBridge: (ctx: Context, bot: WecomBot, config: Config) => WecomAgentBridge = (ctx, bot, config) => new WecomAgentBridge(ctx, bot, config),
  ) {
    this.snapshot = this.unconfigured() ?? this.status('offline')
  }

  private unconfigured(): WecomStatus | undefined {
    if (this.config.botId && this.config.botSecret) return undefined
    return this.status('unconfigured', { error: 'Set both WECOM_BOT_ID and WECOM_BOT_SECRET, then restart the plugin.' })
  }

  private status(state: WecomConnectionState, details: Partial<WecomStatus> = {}): WecomStatus {
    return { state, changedAt: Date.now(), restarting: this.restartTask !== undefined, version: this.version, ...details }
  }

  private update(state: WecomConnectionState, details: Partial<WecomStatus> = {}): void {
    this.snapshot = this.status(state, {
      authenticatedAt: this.snapshot.authenticatedAt,
      disconnectedAt: this.snapshot.disconnectedAt,
      botIdentity: this.snapshot.botIdentity,
      ...details,
    })
  }

  getStatus(): WecomStatus {
    return { ...this.snapshot, restarting: this.restartTask !== undefined }
  }

  async start(): Promise<WecomStatus> {
    if (this.current !== undefined) return this.getStatus()
    const unavailable = this.unconfigured()
    if (unavailable !== undefined) {
      this.snapshot = unavailable
      return this.getStatus()
    }
    return this.startReplacement()
  }

  private async startReplacement(): Promise<WecomStatus> {
    this.update('connecting', { error: undefined, botIdentity: this.redactedIdentity() })
    let bot: WecomBot | undefined
    let bridge: WecomAgentBridge | undefined
    try {
      bot = this.createBot(this.config)
      bot.onLifecycle(event => {
        if (this.current?.bot !== bot) return
        if (event.type === 'connected') this.update('connecting', { error: undefined })
        if (event.type === 'authenticated') this.update('online', { authenticatedAt: Date.now(), error: undefined })
        if (event.type === 'reconnecting') this.update('reconnecting', { error: undefined })
        if (event.type === 'disconnected') this.update('offline', { disconnectedAt: Date.now(), error: 'Connection closed. Use Restart if it does not reconnect.' })
        if (event.type === 'error') this.update('error', { error: `Connection error (${safeErrorKind(event.error)}). Check credentials and network, then restart.` })
      })
      bridge = this.createBridge(this.ctx, bot, this.config)
      this.current = { bot, bridge }
      await bot.start(async message => {
        if (!this.isInboundAuthorized(message)) return
        await bridge!.enqueue(message)
      })
      return this.getStatus()
    } catch (error) {
      this.current = undefined
      bot?.disconnect()
      await bridge?.dispose()
      this.update('error', { error: `Connection could not start (${safeErrorKind(error)}). Check credentials and network, then restart.` })
      return this.getStatus()
    }
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
    if (this.restartTask !== undefined) return this.restartTask
    this.restartTask = this.doRestart()
    try {
      return await this.restartTask
    } finally {
      this.restartTask = undefined
    }
  }

  private async doRestart(): Promise<WecomStatus> {
    const unavailable = this.unconfigured()
    if (unavailable !== undefined) {
      this.snapshot = unavailable
      return this.getStatus()
    }
    this.update('connecting', { error: undefined, botIdentity: this.redactedIdentity() })
    const previous = this.current
    this.current = undefined
    if (previous !== undefined) {
      try {
        previous.bot.disconnect()
        await previous.bridge.dispose()
      } catch (error) {
        this.update('error', { error: `Previous connection could not stop (${safeErrorKind(error)}). Check the plugin status and restart once more.` })
        return this.getStatus()
      }
    }
    return this.startReplacement()
  }

  async sendText(chatId: string, content: string): Promise<void> {
    if (this.current === undefined) throw new Error('dsh-wecom: WeCom connection is unavailable')
    await this.current.bot.sendText(chatId, content)
  }

  async dispose(): Promise<void> {
    const current = this.current
    this.current = undefined
    if (current !== undefined) {
      current.bot.disconnect()
      await current.bridge.dispose()
    }
    this.update('offline', { disconnectedAt: Date.now(), error: undefined })
  }
}
