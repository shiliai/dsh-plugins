import { WSClient } from '@wecom/aibot-node-sdk'
import type { WsFrame } from '@wecom/aibot-node-sdk'

export interface WecomBotOptions {
  botId: string
  botSecret: string
  heartbeInterval?: number
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
  'message.text': (msg: InboundMessage) => void
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

  constructor(options: WecomBotOptions) {
    this.options = options
    this.client = new WSClient({
      botId: options.botId,
      secret: options.botSecret,
      heartbeatInterval: options.heartbeInterval ?? 30000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? -1,
    })
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    if (!this.options.botId || !this.options.botSecret) {
      throw new Error('dsh-wecom: botId and botSecret are required')
    }
    this.client.connect()
    this.client.on('authenticated', () => {
      this.readyFired = true
    })
    this.client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[dsh-wecom] sdk error', err)
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
      if (text !== '') onMessage(msg)
    })
  }

  isReady(): boolean {
    return this.readyFired
  }

  async replyText(frame: WsFrame, content: string): Promise<void> {
    await this.client.replyStream(frame, `stream_${Date.now()}`, content, true)
  }

  async sendText(chatId: string, content: string): Promise<void> {
    await this.client.sendMessage(chatId, {
      msgtype: 'markdown',
      markdown: { content },
    })
  }

  disconnect(): void {
    this.client.disconnect()
  }
}
