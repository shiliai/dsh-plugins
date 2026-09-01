import { generateReqId, WSClient } from '@wecom/aibot-node-sdk'
import type { TemplateCard, WsFrame } from '@wecom/aibot-node-sdk'
import { makeLogger, sdkLogger, type Logger, type LogLevel } from './log.ts'
import { safeErrorKind, truncateUtf8 } from './safety.ts'

export interface WecomBotOptions {
  botId: string
  botSecret: string
  heartbeatInterval?: number
  maxReconnectAttempts?: number
  /** Diagnostic verbosity. Defaults to 'info' (SDK auth/connect visible). */
  logLevel?: LogLevel
}

export interface InboundMessage {
  /** stable identity of the chat (chatid) that sent this message */
  chatId: string
  /** text content, empty for non-text media */
  text: string
  /** raw frame for replying */
  frame: WsFrame
  /** unique message id for dedup */
  msgId: string
  /** "single" | "group" | unknown */
  chatType: string
  /** sender userid when available */
  senderId?: string | undefined
}

/**
 * A normalized user interaction with a template card we rendered. Carries the
 * `task_id` we set on the card (to correlate with the originating question) and
 * the `event_key` WeCom includes for the tapped/submitted element.
 */
export interface InboundCardEvent {
  /** stable identity of the chat (chatid) that tapped the card */
  chatId: string
  /** "single" | "group" | unknown */
  chatType: string
  /** sender userid when available */
  senderId?: string | undefined
  /** task_id we assigned when the card was sent (correlates to a question) */
  taskId: string
  /** opaque element key WeCom reports for the interaction */
  eventKey?: string | undefined
  /** unique event id for dedup */
  msgId: string
  /** raw event frame for replying/updating */
  frame: WsFrame
}

export interface WecomBotEvents {
  ready: () => void
  'message.text': (msg: InboundMessage) => void | Promise<void>
  'template_card_event': (evt: InboundCardEvent) => void | Promise<void>
  error: (err: unknown) => void
}

export type WecomLifecycleEvent =
  | { type: 'connected' }
  | { type: 'authenticated' }
  | { type: 'disconnected' }
  | { type: 'reconnecting' }
  | { type: 'error'; error: unknown }

/**
 * Thin wrapper over the WeCom smart-robot Node SDK (WebSocket long connection).
 * Owns connect/auth/heartbeat/reconnect and normalizes inbound text messages.
 * Sending is delegated to the raw WSClient (replyStream / sendMessage).
 */
export class WecomBot {
  readonly client: WSClient
  private readyFired = false
  private readonly options: WecomBotOptions
  private readonly seen = new Map<string, number>()
  private readonly dedupTtlMs = 10 * 60_000
  private readonly maxDedupEntries = 10_000
  private readonly log: Logger
  private readonly lifecycleListeners = new Set<(event: WecomLifecycleEvent) => void>()
  private readonly cardEventListeners = new Set<(evt: InboundCardEvent) => void | Promise<void>>()

  constructor(options: WecomBotOptions) {
    this.options = options
    this.log = makeLogger(options.logLevel ?? 'info')
    this.client = new WSClient({
      botId: options.botId,
      secret: options.botSecret,
      heartbeatInterval: options.heartbeatInterval ?? 30000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? -1,
      // Forward SDK info/warn/error (auth, connect, disconnect) but DROP debug,
      // because the SDK logs full inbound frame bodies at debug. Our own debug
      // lines (identity-only) go through the bridge logger instead.
      logger: sdkLogger(this.log),
    })
  }

  get identity(): string {
    return this.options.botId
  }

  onLifecycle(listener: (event: WecomLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  /** Subscribe to normalized template-card interactions (user taps a rendered card). */
  onCardEvent(listener: (evt: InboundCardEvent) => void | Promise<void>): () => void {
    this.cardEventListeners.add(listener)
    return () => this.cardEventListeners.delete(listener)
  }

  private emitLifecycle(event: WecomLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) listener(event)
  }

  private isDuplicate(msgId: string): boolean {
    if (!msgId) return false
    const now = Date.now()
    for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key)
    const key = `${this.identity}:${msgId}`
    if (this.seen.has(key)) return true
    this.seen.set(key, now + this.dedupTtlMs)
    while (this.seen.size > this.maxDedupEntries) this.seen.delete(this.seen.keys().next().value!)
    return false
  }

  private async handleMessageFailure(frame: WsFrame, error: unknown): Promise<void> {
    // Never include a message body, token, or raw SDK frame in logs.
    // eslint-disable-next-line no-console
    console.error(`[dsh-wecom] inbound handler failed (${safeErrorKind(error)})`)
    try {
      await this.replyText(frame, '抱歉，处理这条消息时发生错误。请稍后重试。')
    } catch (replyError) {
      // eslint-disable-next-line no-console
      console.error(`[dsh-wecom] failure reply failed (${safeErrorKind(replyError)})`)
    }
  }

  async start(onMessage: (msg: InboundMessage) => void | Promise<void>): Promise<void> {
    if (!this.options.botId || !this.options.botSecret) {
      throw new Error('dsh-wecom: botId and botSecret are required')
    }
    this.client.on('authenticated', () => {
      this.readyFired = true
      this.emitLifecycle({ type: 'authenticated' })
    })
    this.client.on('connected', () => {
      this.emitLifecycle({ type: 'connected' })
    })
    this.client.on('disconnected', () => {
      this.readyFired = false
      this.emitLifecycle({ type: 'disconnected' })
    })
    this.client.on('reconnecting', () => {
      this.readyFired = false
      this.emitLifecycle({ type: 'reconnecting' })
    })
    this.client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[dsh-wecom] sdk error (${safeErrorKind(err)})`)
      this.emitLifecycle({ type: 'error', error: err })
    })
    this.client.on('message.text', (frame: WsFrame) => {
      const body = frame?.body ?? {}
      const text = (body.text?.content ?? '').trim()
      const msg: InboundMessage = {
        chatId: (body.chatid ?? body.from?.userid ?? '') as string,
        text,
        frame,
        msgId: (body.msgid ?? '') as string,
        chatType: (body.chattype ?? '') as string,
        senderId: body?.from?.userid as string | undefined,
      }
      if (text === '' || this.isDuplicate(msg.msgId)) return
      this.log.info('inbound text', {
        chatId: msg.chatId === '' ? undefined : msg.chatId,
        chatType: msg.chatType,
        msgId: msg.msgId === '' ? undefined : msg.msgId,
        bytes: Buffer.byteLength(text, 'utf8'),
      })
      // EventEmitter intentionally ignores returned promises. Own this boundary
      // so a failed turn cannot become an unhandled rejection or stop later work.
      void Promise.resolve().then(() => onMessage(msg)).catch((error: unknown) => this.handleMessageFailure(frame, error))
    })
    this.client.on('event.template_card_event', (frame: WsFrame) => {
      const body = frame?.body ?? {}
      const event = (body.event ?? {}) as { event_key?: string; task_id?: string }
      const evt: InboundCardEvent = {
        chatId: (body.chatid ?? body.from?.userid ?? '') as string,
        chatType: (body.chattype ?? '') as string,
        senderId: (body.from?.userid ?? undefined) as string | undefined,
        taskId: (event.task_id ?? '') as string,
        eventKey: event.event_key,
        msgId: (body.msgid ?? '') as string,
        frame,
      }
      if (evt.taskId === '' || this.isDuplicate(evt.msgId)) return
      this.log.info('inbound card event', {
        chatId: evt.chatId === '' ? undefined : evt.chatId,
        chatType: evt.chatType,
        msgId: evt.msgId === '' ? undefined : evt.msgId,
        taskId: evt.taskId,
        hasEventKey: Boolean(evt.eventKey),
      })
      for (const listener of this.cardEventListeners) {
        void Promise.resolve().then(() => listener(evt)).catch((error: unknown) => this.handleMessageFailure(frame, error))
      }
    })
    this.client.connect()
  }

  isReady(): boolean {
    return this.readyFired
  }

  async replyText(frame: WsFrame, content: string): Promise<void> {
    this.log.debug('reply outbound', {
      chatId: (frame?.body?.chatid ?? frame?.body?.from?.userid ?? '') as string,
      bytes: Buffer.byteLength(content, 'utf8'),
    })
    await this.client.replyStream(frame, generateReqId('stream'), truncateUtf8(content), true)
  }

  /**
   * Open a streaming reply showing a "thinking" placeholder (finish=false) and
   * return its stream id. Call {@link finishReply} with the same id and the real
   * content to replace that bubble in place. Lets WeCom show progress while the
   * bot works, so the user is not left wondering whether the message was
   * received.
   */
  openThinking(frame: WsFrame, text: string): string {
    const streamId = generateReqId('stream')
    void this.client.replyStream(frame, streamId, truncateUtf8(text), false).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[dsh-wecom] thinking opener failed (${safeErrorKind(error)})`)
    })
    return streamId
  }

  /** Finalize an opened thinking stream (same stream id) with the real reply content. */
  async finishReply(frame: WsFrame, streamId: string, content: string): Promise<void> {
    this.log.debug('reply outbound (stream finish)', {
      chatId: (frame?.body?.chatid ?? frame?.body?.from?.userid ?? '') as string,
      bytes: Buffer.byteLength(content, 'utf8'),
    })
    await this.client.replyStream(frame, streamId, truncateUtf8(content), true)
  }

  async sendText(chatId: string, content: string): Promise<void> {
    this.log.debug('send outbound', {
      chatId,
      bytes: Buffer.byteLength(content, 'utf8'),
    })
    await this.client.sendMessage(chatId, {
      msgtype: 'markdown',
      markdown: { content: truncateUtf8(content) },
    })
  }

  /** Reply to an inbound frame with a template card (interactive options). */
  async replyTemplateCard(frame: WsFrame, card: TemplateCard): Promise<void> {
    this.log.debug('reply card outbound', {
      chatId: (frame?.body?.chatid ?? frame?.body?.from?.userid ?? '') as string,
      taskId: card.task_id,
      cardType: card.card_type,
    })
    await this.client.replyTemplateCard(frame, card)
  }

  /** Actively push a template card to a chat (does not depend on a reply window). */
  async sendTemplateCard(chatId: string, card: TemplateCard): Promise<void> {
    this.log.debug('send card outbound', {
      chatId,
      taskId: card.task_id,
      cardType: card.card_type,
    })
    await this.client.sendMessage(chatId, {
      msgtype: 'template_card',
      template_card: card,
    })
  }

  /** Reflect a card update after a user interaction (must be used with the event frame). */
  async updateTemplateCard(frame: WsFrame, card: TemplateCard, userids?: string[]): Promise<void> {
    this.log.debug('update card', {
      chatId: (frame?.body?.chatid ?? frame?.body?.from?.userid ?? '') as string,
      taskId: card.task_id,
      userids: userids?.length ? userids.length : undefined,
    })
    await this.client.updateTemplateCard(frame, card, userids)
  }

  disconnect(): void {
    this.client.disconnect()
  }
}
