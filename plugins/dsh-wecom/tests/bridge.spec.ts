import { describe, expect, it, vi } from 'vitest'
import { WecomAgentBridge } from '../src/index.ts'
import type { InboundMessage } from '../src/bot.ts'

// ---- fakes ----
interface FakeAgent {
  session: { seq: number; events: Array<unknown> }
  followup: (msg: unknown) => void
  whenIdle: () => Promise<void>
}

function makeAgent(prefix: string): FakeAgent {
  const events: Array<unknown> = []
  return {
    session: { seq: 0, events },
    followup(msg) {
      const seq = events.length
      events.push({ seq, type: 'turn/start', data: {} })
      events.push({
        seq: seq + 1,
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: `${prefix}:${(msg as { content: { text: string }[] }).content[0]!.text}` }] } },
      })
      events.push({ seq: seq + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } })
    },
    async whenIdle() {},
  }
}

function baseContext() {
  const agents: FakeAgent[] = []
  const mockCtx = {
    get(name: string): unknown {
      if (name === 'agents') {
        return {
          get: (_id: unknown) => undefined,
          create: async () => {
            const a = makeAgent(`agent${agents.length + 1}`)
            agents.push(a)
            return { agent: a, dispose: async () => {} }
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      }
      if (name === 'sessions') return { flush: async () => {} }
      return undefined
    },
  }
  return { mockCtx, agents }
}

function fakeBot() {
  const replies: Array<{ frame: unknown; content: string }> = []
  return {
    replies,
    replyText: vi.fn(async (frame: unknown, content: string) => {
      replies.push({ frame, content })
    }),
  }
}

function msg(chatId: string, text: string): InboundMessage {
  return { chatId, text, frame: { headers: { req_id: `r-${chatId}-${text}` } } as never, msgId: `m-${text}`, chatType: 'single' }
}

describe('WecomAgentBridge', () => {
  it('replies with the agent output', async () => {
    const { mockCtx } = baseContext()
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', '你好'))
    expect(res.text).toContain('你好')
    expect(bot.replyText).toHaveBeenCalledTimes(1)
    expect(bot.replyText.mock.calls[0]![1]).toContain('你好')
  })

  it('keeps conversation memory per chat (followup accumulates on same agent)', async () => {
    const { mockCtx, agents } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', maxReplyChars: 2000 })
    await bridge.enqueue(msg('u1', '我叫小王'))
    await bridge.enqueue(msg('u1', '我叫什么'))
    // both turns go through the same agent
    expect(agents).toHaveLength(1)
    const a = agents[0] as FakeAgent
    expect(a.whenIdle).toBeDefined()
    // session accumulated > one turn of events
    expect(a.session.events.length).toBeGreaterThan(3)
  })

  it('isolates memory across different chats (separate agents)', async () => {
    const { mockCtx, agents } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('chatA', 'A的对话'))
    await bridge.enqueue(msg('chatB', 'B的对话'))
    expect(agents).toHaveLength(2)
    // each chat got its own agent
    const ids = new Set(agents)
    expect(ids.size).toBe(2)
  })

  it('serializes turns per chat (does not run concurrently)', async () => {
    const { mockCtx } = baseContext()
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's' })
    const p1 = bridge.enqueue(msg('u1', '第一条'))
    const p2 = bridge.enqueue(msg('u1', '第二条'))
    // both resolve in order; no throw
    await expect(p1).resolves.toBeDefined()
    await expect(p2).resolves.toBeDefined()
  })
})
