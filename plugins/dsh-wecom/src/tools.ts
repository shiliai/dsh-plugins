import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WecomBot } from './bot.ts'

export function registerWecomTools(ctx: Context, bot: WecomBot): void {
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
      const content = (args.content ?? '').slice(0, 20000)
      if (!args.chatId || !content) return { ok: false, message: 'chatId and content are required' }
      try {
        await bot.sendText(args.chatId, content)
        return { ok: true, message: 'sent' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
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
