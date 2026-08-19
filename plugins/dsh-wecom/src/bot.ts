import { generateReqId, WSClient } from '@wecom/aibot-node-sdk'
import type { WsFrame } from '@wecom/aibot-node-sdk'
import { safeErrorKind, truncateUtf8 } from './safety.ts'

export interface WecomBotOptions {
  botId: string
  botSecret: string
  heartbeatInterval?: number
  maxReconnectAttempts?: number
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

export interface WecomBotEvents {
  ready: () => void
  'message.text': (msg: InboundMessage) => void | Promise<void>
  error: (err: unknown) => void
}

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

  constructor(options: WecomBotOptions) {
    this.options = options
    this.client = new WSClient({
      botId: options.botId,
      secret: options.botSecret,
      heartbeatInterval: options.heartbeatInterval ?? 30000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? -1,
      // The SDK's default debug logger serializes inbound frame bodies.
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })
  }

  get identity(): string {
    return this.options.botId
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
    })
    this.client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[dsh-wecom] sdk error (${safeErrorKind(err)})`)
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
      // EventEmitter intentionally ignores returned promises. Own this boundary
      // so a failed turn cannot become an unhandled rejection or stop later work.
      void Promise.resolve().then(() => onMessage(msg)).catch((error: unknown) => this.handleMessageFailure(frame, error))
    })
    this.client.connect()
  }

  isReady(): boolean {
    return this.readyFired
  }

  async replyText(frame: WsFrame, content: string): Promise<void> {
    await this.client.replyStream(frame, generateReqId('stream'), truncateUtf8(content), true)
  }

  async sendText(chatId: string, content: string): Promise<void> {
    await this.client.sendMessage(chatId, {
      msgtype: 'markdown',
      markdown: { content: truncateUtf8(content) },
    })
  }

  disconnect(): void {
    this.client.disconnect()
  }
}
