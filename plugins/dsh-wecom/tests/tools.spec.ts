import { describe, expect, it, vi } from 'vitest'
import { registerWecomTools } from '../src/tools.ts'

describe('wecom_send_message', () => {
  it('defaults to deny and only sends to explicitly allowed targets', async () => {
    let tool: { execute(args: { chatId: string; content: string }): Promise<{ ok: boolean }>; presentCall(args: { chatId: string; content: string }): { rawInput: string } } | undefined
    const sendText = vi.fn(async (_chatId: string, _content: string) => {})
    registerWecomTools({ tools: { register: (value: unknown) => { tool = value as typeof tool } } } as never, { sendText } as never)
    expect((await tool!.execute({ chatId: 'u1', content: 'hello' })).ok).toBe(false)
    expect(sendText).not.toHaveBeenCalled()
    expect(tool!.presentCall({ chatId: 'u1', content: 'hello' }).rawInput).toContain('u1')
  })

  it('uses an independent outbound allowlist and UTF-8 safe content', async () => {
    let tool: { execute(args: { chatId: string; content: string }): Promise<{ ok: boolean }> } | undefined
    const sendText = vi.fn(async (_chatId: string, _content: string) => {})
    registerWecomTools({ tools: { register: (value: unknown) => { tool = value as typeof tool } } } as never, { sendText } as never, ['u1'])
    expect((await tool!.execute({ chatId: 'u1', content: 'a'.repeat(20_479) + '😀' })).ok).toBe(true)
    const calls = sendText.mock.calls as unknown as Array<[string, string]>
    expect(Buffer.byteLength(calls[0]![1], 'utf8')).toBeLessThanOrEqual(20_480)
  })
})
