import { afterEach, describe, expect, it, vi } from 'vitest'

const { replyStream } = vi.hoisted(() => ({
  replyStream: vi.fn(async (_frame: unknown, _streamId: string, _content: string, _finish: boolean) => ({})),
}))

vi.mock('@wecom/aibot-node-sdk', () => {
  class WSClient {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    connect() { return this }
    disconnect() {}
    replyStream = replyStream
    sendMessage = vi.fn(async () => ({}))
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
      return true
    }
  }
  return { WSClient, generateReqId: (prefix: string) => `${prefix}-sdk-id` }
})

import { WecomBot } from '../src/bot.ts'

afterEach(() => vi.clearAllMocks())

function frame(msgid: string, content = 'hello') {
  return {
    body: { chatid: 'chat-1', chattype: 'single', msgid, from: { userid: 'user-1' }, text: { content } },
    headers: { req_id: `request-${msgid}` },
  }
}

describe('WecomBot inbound boundary', () => {
  it('catches async handler failures, sends a generic fallback, and continues later messages', async () => {
    const unhandled = vi.fn()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.once('unhandledRejection', unhandled)
    try {
      const bot = new WecomBot({ botId: 'bot-1', botSecret: 'secret' })
      replyStream.mockRejectedValueOnce(new Error('fallback transport failure'))
      let calls = 0
      await bot.start(async () => {
        calls += 1
        if (calls === 1) throw new Error('message body must not leak')
      })
      bot.client.emit('message.text', frame('one') as never)
      await new Promise(resolve => setTimeout(resolve, 0))
      bot.client.emit('message.text', frame('two') as never)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toBe(2)
      expect(unhandled).not.toHaveBeenCalled()
      expect(replyStream).toHaveBeenCalledWith(expect.anything(), 'stream-sdk-id', expect.stringContaining('抱歉'), true)
    } finally {
      process.removeListener('unhandledRejection', unhandled)
      errorLog.mockRestore()
    }
  })

  it('catches a synchronous handler throw at the EventEmitter boundary', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bot = new WecomBot({ botId: 'bot-1', botSecret: 'secret' })
    try {
      await bot.start(() => {
        throw new Error('synchronous failure')
      })
      bot.client.emit('message.text', frame('sync') as never)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(replyStream).toHaveBeenCalledWith(expect.anything(), 'stream-sdk-id', expect.stringContaining('抱歉'), true)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('deduplicates normal messages and slash commands by bot identity and msgid', async () => {
    const bot = new WecomBot({ botId: 'bot-1', botSecret: 'secret' })
    const received = vi.fn()
    await bot.start(received)
    bot.client.emit('message.text', frame('normal', 'normal') as never)
    bot.client.emit('message.text', frame('normal', 'normal') as never)
    bot.client.emit('message.text', frame('command', '/new') as never)
    bot.client.emit('message.text', frame('command', '/new') as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toHaveBeenCalledTimes(2)
  })

  it('uses SDK request ids and applies a UTF-8 byte cap to replies', async () => {
    const bot = new WecomBot({ botId: 'bot-1', botSecret: 'secret' })
    await bot.replyText(frame('reply') as never, 'a'.repeat(20_479) + '😀')
    const calls = replyStream.mock.calls as unknown as Array<[unknown, string, string, boolean]>
    const content = calls[0]![2]
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(20_480)
    expect(content.endsWith('😀')).toBe(false)
    expect(calls[0]![1]).toBe('stream-sdk-id')
  })

  it('clears readiness after disconnect and reports reconnect lifecycle changes', async () => {
    const bot = new WecomBot({ botId: 'bot-1', botSecret: 'secret' })
    const events: string[] = []
    bot.onLifecycle(event => events.push(event.type))
    await bot.start(() => undefined)
    bot.client.emit('authenticated')
    expect(bot.isReady()).toBe(true)
    bot.client.emit('reconnecting', 1)
    expect(bot.isReady()).toBe(false)
    bot.client.emit('disconnected', 'network')
    expect(bot.isReady()).toBe(false)
    expect(events).toEqual(['authenticated', 'reconnecting', 'disconnected'])
  })

  it('uses a fixed log category for adversarial SDK error names', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bot = new WecomBot({ botId: 'bot-1', botSecret: 'secret' })
    await bot.start(() => undefined)
    const hostile = new Error('message body')
    hostile.name = 'token-value'
    bot.client.emit('error', hostile)
    expect(errorLog).toHaveBeenCalledWith('[dsh-wecom] sdk error (OperationError)')
    errorLog.mockRestore()
  })
})
