import { describe, expect, it, vi } from 'vitest'
import { sep } from 'node:path'
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

const PRESET_ROWS = [
  { id: 'standard', name: '标准模式', description: '功能完整的编码 Agent' },
  { id: 'minimal', name: '极简模式', description: '双工具编码 Agent' },
]

function presetsService() {
  return {
    defaultId: 'standard',
    list: async () => PRESET_ROWS,
    resolve: async (id?: string) => {
      const hit = PRESET_ROWS.find((r) => r.id === id)
      if (!hit) throw new Error(`unknown preset: ${id}`)
      return hit
    },
    mount: async () => Promise.resolve(),
    composedPreset: () => PRESET_ROWS[0]!.id,
  }
}

function baseContext(opts: { withPresets?: boolean } = {}) {
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
      if (name === 'agentPresets' && opts.withPresets) return presetsService()
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

describe('slash commands', () => {
  it('/help replies with command list and creates no agent', async () => {
    const { mockCtx, agents } = baseContext()
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', '/help'))
    expect(res.text).toContain('可用命令')
    expect(res.text).toContain('/new')
    expect(res.text).toContain('/cd')
    expect(res.text).toContain('/agent')
    expect(agents).toHaveLength(0)
    expect(bot.replyText).toHaveBeenCalledTimes(1)
  })

  it('/new starts a fresh conversation (new agent on next turn)', async () => {
    const { mockCtx, agents } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('u1', '第一句'))
    expect(agents).toHaveLength(1)
    await bridge.enqueue(msg('u1', '/new'))
    // /new itself created no agent
    expect(agents).toHaveLength(1)
    await bridge.enqueue(msg('u1', '新会话第一句'))
    // fresh agent spawned for the new generation
    expect(agents).toHaveLength(2)
  })

  it('/pwd reports the working directory', async () => {
    const { mockCtx } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultCwd: process.cwd() })
    const res = await bridge.enqueue(msg('u1', '/pwd'))
    expect(res.text).toContain(process.cwd())
  })

  it('/cd switches working directory and starts a fresh conversation', async () => {
    const { mockCtx, agents } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultCwd: process.cwd() })
    await bridge.enqueue(msg('u1', '旧会话'))
    expect(agents).toHaveLength(1)
    const res = await bridge.enqueue(msg('u1', '/cd src'))
    expect(res.ok).toBe(true)
    expect(res.text).toContain('已切换')
    const pwd = await bridge.enqueue(msg('u1', '/pwd'))
    expect(pwd.text).toContain(`${process.cwd()}${sep}src`)
  })

  it('/cd rejects a non-existent directory', async () => {
    const { mockCtx } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', '/cd /definitely/not/a/real/dir-xyz-998'))
    expect(res.ok).toBe(false)
    expect(res.text).toContain('不存在')
  })

  it('/agent lists presets when the roster is available', async () => {
    const { mockCtx } = baseContext({ withPresets: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultPreset: 'standard' })
    const res = await bridge.enqueue(msg('u1', '/agent'))
    expect(res.ok).toBe(true)
    expect(res.text).toContain('standard')
    expect(res.text).toContain('minimal')
    expect(res.text).toContain('【当前】')
  })

  it('/agent <name> switches agent and starts a fresh conversation', async () => {
    const { mockCtx, agents } = baseContext({ withPresets: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultPreset: 'standard' })
    await bridge.enqueue(msg('u1', '旧会话'))
    expect(agents).toHaveLength(1)
    const res = await bridge.enqueue(msg('u1', '/agent minimal'))
    expect(res.ok).toBe(true)
    expect(res.text).toContain('极简模式')
    await bridge.enqueue(msg('u1', '新会话第一句'))
    expect(agents).toHaveLength(2)
  })

  it('/agent rejects an unknown name', async () => {
    const { mockCtx } = baseContext({ withPresets: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', '/agent nope-zzz'))
    expect(res.ok).toBe(false)
    expect(res.text).toContain('未找到')
  })

  it('/status shows session, cwd, agent and model', async () => {
    const { mockCtx } = baseContext({ withPresets: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultPreset: 'standard' })
    const res = await bridge.enqueue(msg('u1', '/status'))
    expect(res.text).toContain('会话')
    expect(res.text).toContain('工作目录')
    expect(res.text).toContain('Agent')
    expect(res.text).toContain('模型')
    expect(res.text).toContain('standard')
  })

  it('unknown slash command replies with an error but no agent', async () => {
    const { mockCtx, agents } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', '/frobnicate'))
    expect(res.text).toContain('未知命令')
    expect(agents).toHaveLength(0)
  })
})
