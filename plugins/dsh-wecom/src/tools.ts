import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeLogger } from './log.ts'
import { isAllowed, truncateUtf8 } from './safety.ts'

interface OutboundConnection {
  sendText(chatId: string, content: string): Promise<void>
}

export function registerWecomTools(ctx: Context, bot: OutboundConnection, outboundAllowChats: readonly string[] = []): void {
  const log = makeLogger('info')
  ctx.tools.register(defineTool({
    name: 'wecom_send_message',
    description: 'Send a Markdown message to a WeCom chat (single user userid or group chatid) through the resident bot long connection.',
    parameters: {
      chatId: { type: 'string', required: true, description: 'Target chat: a user userid for single chat, or a group chatid for a group.' },
      content: { type: 'string', required: true, description: 'Markdown content to send, max 20000 chars.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string' },
        },
      },
      render: (_args: { chatId: string; content: string }, value: { ok: boolean; message?: string }) =>
        [{ type: 'text' as const, text: value.ok ? 'sent' : value.message ?? 'failed' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args: { chatId: string; content: string }) => {
      const content = truncateUtf8(args.content ?? '')
      if (!args.chatId || !content) return { ok: false, message: 'chatId and content are required' }
      if (!isAllowed(args.chatId, outboundAllowChats)) {
        log.warn('wecom_send_message denied', { chatId: args.chatId })
        return { ok: false, message: 'target chat is not authorized' }
      }
      try {
        await bot.sendText(args.chatId, content)
        log.info('wecom_send_message', { chatId: args.chatId, bytes: Buffer.byteLength(content, 'utf8') })
        return { ok: true, message: 'sent' }
      } catch (err) {
        log.error('wecom_send_message failed', { chatId: args.chatId, kind: err instanceof Error ? err.name : 'UnknownError' })
        return { ok: false, message: 'send failed; check the WeCom connection status' }
      }
    },
    presentCall: (args: { chatId: string; content: string }) => ({
      card: 'generic' as const,
      kind: 'other' as const,
      title: 'Send WeCom message',
      rawInput: args.chatId,
      locations: [],
    }),
  }))
}
