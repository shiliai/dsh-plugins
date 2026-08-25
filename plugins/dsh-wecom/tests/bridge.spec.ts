import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { WecomAgentBridge, isInboundAuthorized } from '../src/index.ts'
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
  }
}

function baseContext(opts: {
  withPresets?: boolean
  selection?: { provider: string; model: string }
  whenIdle?: (index: number) => Promise<void>
  dispose?: (index: number) => Promise<void>
  /** If provided, `sessionPersistence.listSnapshots` returns these session ids. */
  persisted?: string[]
  /** If true, `agents.resume` creates a real agent (mirrors create). */
  resumeHandler?: boolean
  /** Session ids reported as already live (e.g. active in the browser). */
  liveIds?: string[]
  /** If true, mock `workspaceRegistry` and capture attach calls. */
  withRegistry?: boolean
} = {}) {
  const agents: FakeAgent[] = []
  const creates: Array<Record<string, unknown>> = []
  const resumes: Array<Record<string, unknown>> = []
  const attaches: Array<{ path: string; session: string }> = []
  const listeners = new Map<string, Set<Function>>()
  const selection = opts.selection ?? { provider: 'p', model: 'm' }
  const makeHandle = (options: Record<string, unknown>) => {
    const index = agents.length
    const a = makeAgent(`agent${index + 1}`)
    if (opts.whenIdle) a.whenIdle = () => opts.whenIdle!(index)
    agents.push(a)
    return { agent: a, dispose: async () => opts.dispose?.(index) }
  }
  const mockCtx = {
    on(event: string, listener: Function) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
      return () => void set.delete(listener)
    },
    get(name: string): unknown {
      if (name === 'agents') {
        return {
          get: (id: unknown) => (opts.liveIds ?? []).includes(String(id)) ? { id } : undefined,
          create: async (options: Record<string, unknown>) => {
            creates.push(options)
            return makeHandle(options)
          },
          resume: async (options: Record<string, unknown>) => {
            resumes.push(options)
            if (opts.resumeHandler) return makeHandle(options)
            throw new Error('resume not expected')
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => selection }
      }
      if (name === 'sessions') return { flush: async () => {} }
      if (name === 'agentPresets' && opts.withPresets !== false) return presetsService()
      if (name === 'sessionPersistence') {
        return {
          listSnapshots: async () => (opts.persisted ?? []).map((id) => ({ header: { id } })),
        }
      }
      if (name === 'workspaceRegistry' && opts.withRegistry) {
        return {
          resolveByPath: async (path: string) => {
            attaches.push({ path, session: 'RESOLVE' })
            return undefined
          },
          create: async (path: string) => ({
            attachSession: async (id: unknown) => { attaches.push({ path, session: String(id) }) },
          }),
        }
      }
      return undefined
    },
  }
  const emit = (event: string, ...args: unknown[]) => {
    const set = listeners.get(event)
    if (!set) return
    for (const listener of [...set]) listener(...args)
  }
  return { mockCtx, agents, creates, resumes, selection, attaches, emit }
}

function fakeBot() {
  const replies: Array<{ frame: unknown; content: string; via: 'replyText' | 'finishReply' }> = []
  const sends: Array<{ chatId: string; content: string }> = []
  let opens = 0
  let streamCounter = 0
  return {
    identity: 'bot-a',
    replies,
    sends,
    opens,
    replyText: vi.fn(async (frame: unknown, content: string) => {
      replies.push({ frame, content, via: 'replyText' })
    }),
    sendText: vi.fn(async (chatId: string, content: string) => {
      sends.push({ chatId, content })
    }),
    openThinking: vi.fn((_frame: unknown, _text: string) => {
      opens += 1
      streamCounter += 1
      return `stream-${streamCounter}`
    }),
    finishReply: vi.fn(async (frame: unknown, _streamId: string, content: string) => {
      replies.push({ frame, content, via: 'finishReply' })
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
    // real turn opens a thinking stream and finalizes it with the agent output
    expect(bot.openThinking).toHaveBeenCalledTimes(1)
    expect(bot.finishReply).toHaveBeenCalledTimes(1)
    expect(bot.finishReply.mock.calls[0]![2]).toContain('你好')
    expect(bot.replyText).not.toHaveBeenCalled()
  })

  it('keeps conversation memory per chat (followup accumulates on same agent)', async () => {
    const { mockCtx, agents } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
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

  it('retains failed live handles for a later dispose retry while removing successful handles', async () => {
    let failFirst = true
    const { mockCtx } = baseContext({
      dispose: async index => {
        if (index === 0 && failFirst) throw new Error('fixture disposal failure')
      },
    })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('u1', 'first'))
    await bridge.enqueue(msg('u2', 'second'))
    await expect(bridge.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(bridge.resourceSnapshot()).toEqual({ states: 1, queues: 0, liveAgents: 1 })
    failFirst = false
    await expect(bridge.dispose()).resolves.toBeUndefined()
    expect(bridge.resourceSnapshot()).toEqual({ states: 0, queues: 0, liveAgents: 0 })
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
    const { mockCtx, agents, creates, resumes } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('u1', '第一句'))
    expect(agents).toHaveLength(1)
    await bridge.enqueue(msg('u1', '/new'))
    // /new itself created no agent
    expect(agents).toHaveLength(1)
    await bridge.enqueue(msg('u1', '新会话第一句'))
    // fresh agent spawned for the new generation
    expect(agents).toHaveLength(2)
    expect(creates[0]!.sessionId).not.toEqual(creates[1]!.sessionId)
    expect(resumes).toHaveLength(0)
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

  it('/agent can recover from an invalid configured default preset', async () => {
    const { mockCtx, creates } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
      botId: 'b', botSecret: 's', defaultPreset: 'missing',
    })
    const switched = await bridge.enqueue(msg('u1', '/agent minimal'))
    expect(switched.ok).toBe(true)
    await bridge.enqueue(msg('u1', 'hello'))
    expect((creates[0]!.meta as { agentPreset: string }).agentPreset).toBe('minimal')
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

  it('uses agentPresets.defaultId consistently when defaultPreset is omitted', async () => {
    const { mockCtx, creates } = baseContext({ withPresets: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const list = await bridge.enqueue(msg('u1', '/agent'))
    expect(list.text).toContain('当前')
    await bridge.enqueue(msg('u1', 'hello'))
    expect((creates[0]!.meta as { agentPreset: string }).agentPreset).toBe('standard')
    const status = await bridge.enqueue(msg('u1', '/status'))
    expect(status.text).toContain('standard')
  })

  it('rejects a broken preset', async () => {
    const brokenPresets = {
      defaultId: 'broken',
      list: async () => [{ id: 'broken', name: 'Broken', broken: 'missing tool' }],
      resolve: async () => ({ id: 'broken' }),
      mount: async () => {},
    }
    const { mockCtx } = baseContext()
    const ctx = { ...mockCtx, get: (name: string) => name === 'agentPresets' ? brokenPresets : mockCtx.get(name) }
    const bridge = new WecomAgentBridge(ctx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const result = await bridge.enqueue(msg('u1', '/agent Broken'))
    expect(result.ok).toBe(false)
  })

  it('prefers an exact preset id even when display names are ambiguous', async () => {
    const rows = [
      { id: 'standard', name: 'Shared' },
      { id: 'other', name: 'standard' },
      { id: 'third', name: 'standard' },
      { id: 'fourth', name: 'Shared' },
    ]
    const exactPresets = {
      defaultId: 'standard',
      list: async () => rows,
      resolve: async (id?: string) => rows.find(row => row.id === id)!,
      mount: async () => {},
    }
    const { mockCtx, creates } = baseContext()
    const ctx = { ...mockCtx, get: (name: string) => name === 'agentPresets' ? exactPresets : mockCtx.get(name) }
    const bridge = new WecomAgentBridge(ctx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    expect((await bridge.enqueue(msg('u1', '/agent Shared'))).ok).toBe(false)
    await bridge.enqueue(msg('u1', 'hello'))
    expect((creates[0]!.meta as { agentPreset: string }).agentPreset).toBe('standard')
  })

  it('reports the model captured by the live agent, not a later global selection', async () => {
    const { mockCtx, selection } = baseContext({ withPresets: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('u1', 'create agent'))
    selection.model = 'later-model'
    const result = await bridge.enqueue(msg('u1', '/status'))
    expect(result.text).toContain('p/m')
    expect(result.text).not.toContain('later-model')
  })

  it('settles queues and evicts excess idle chats', async () => {
    const { mockCtx } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
      botId: 'b', botSecret: 's', maxLiveChats: 1, idleChatMs: 0,
    })
    await bridge.enqueue(msg('u1', 'one'))
    await bridge.enqueue(msg('u2', 'two'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(bridge.resourceSnapshot().queues).toBe(0)
    expect(bridge.resourceSnapshot().states).toBeLessThanOrEqual(1)
  })

  it('does not let one failed idle disposal abort another chat', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let failFirst = true
    const { mockCtx } = baseContext({
      dispose: async (index) => { if (index === 0 && failFirst) throw new Error('dispose failed') },
    })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
      botId: 'b', botSecret: 's', maxLiveChats: 1, idleChatMs: 0,
    })
    try {
      await bridge.enqueue(msg('u1', 'one'))
      await expect(bridge.enqueue(msg('u2', 'two'))).resolves.toMatchObject({ ok: true })
    } finally {
      failFirst = false
      await bridge.dispose()
      error.mockRestore()
    }
  })

  it('waits for same-chat eviction before creating a replacement agent', async () => {
    let releaseDispose!: () => void
    const disposing = new Promise<void>((resolve) => { releaseDispose = resolve })
    const dispose = vi.fn(async (index: number) => {
      if (index === 0) await disposing
    })
    const { mockCtx, agents } = baseContext({ dispose })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
      botId: 'b', botSecret: 's', maxLiveChats: 1, idleChatMs: 0,
    })
    await bridge.enqueue(msg('u1', 'first'))
    const otherChat = bridge.enqueue(msg('u2', 'second'))
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith(0))
    const replacement = bridge.enqueue(msg('u1', 'again'))
    expect(agents).toHaveLength(1)
    releaseDispose()
    await otherChat
    const result = await replacement
    expect(result.text).not.toContain('agent1:again')
    expect(agents).toHaveLength(3)
    await bridge.dispose()
  })

  it('drains active chat queues before disposing agents and rejects new ingress', async () => {
    let releaseIdle!: () => void
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve })
    const dispose = vi.fn(async () => {})
    const whenIdle = vi.fn(async () => idle)
    const { mockCtx } = baseContext({ dispose, whenIdle })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const turn = bridge.enqueue(msg('u1', 'slow turn'))
    await vi.waitFor(() => expect(whenIdle).toHaveBeenCalled())
    const shutdown = bridge.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(dispose).not.toHaveBeenCalled()
    await expect(bridge.enqueue(msg('u2', 'late turn'))).rejects.toThrow('shutting down')
    releaseIdle()
    await turn
    await shutdown
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(bridge.resourceSnapshot()).toEqual({ states: 0, queues: 0, liveAgents: 0 })
  })

  it('keeps cwd and preset state unchanged when the old agent fails to dispose', async () => {
    const { mockCtx } = baseContext({ dispose: async () => { throw new Error('dispose failed') } })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
      botId: 'b', botSecret: 's', defaultCwd: process.cwd(), defaultPreset: 'standard',
    })
    await bridge.enqueue(msg('u1', 'create live agent'))
    await expect(bridge.enqueue(msg('u1', '/cd src'))).rejects.toThrow('dispose failed')
    expect((await bridge.enqueue(msg('u1', '/pwd'))).text).toContain(process.cwd())
    await expect(bridge.enqueue(msg('u1', '/agent minimal'))).rejects.toThrow('dispose failed')
    const list = await bridge.enqueue(msg('u1', '/agent'))
    expect(list.text).toContain('【当前】 标准模式 (`standard`)')
  })

  it('refuses to create an uncomposed agent when the preset service is absent', async () => {
    const { mockCtx } = baseContext({ withPresets: false })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', 'hello'))
    // the turn fails on the stream (thinking finalized with an error), not a reject
    expect(res.ok).toBe(false)
    expect(res.text).toBe('')
  })
})

describe('authorization and cwd containment', () => {
  it('denies by default, requires group senders, and permits explicit direct users', () => {
    expect(isInboundAuthorized(msg('u1', 'hello'), { botId: 'b', botSecret: 's' })).toBe(false)
    expect(isInboundAuthorized(msg('u1', 'hello'), { botId: 'b', botSecret: 's', allowChats: ['u1'] })).toBe(true)
    const group = { ...msg('g1', 'hello'), chatType: 'group', senderId: 'u1' }
    expect(isInboundAuthorized(group, { botId: 'b', botSecret: 's', allowChats: ['*'] })).toBe(false)
    expect(isInboundAuthorized(group, { botId: 'b', botSecret: 's', allowChats: ['g1'], allowGroupSenders: ['u1'] })).toBe(true)
  })

  it('/cd permits descendants and rejects absolute, parent, and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wecom-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-wecom-outside-'))
    try {
      await mkdir(join(root, 'inside'))
      await symlink(outside, join(root, 'escape'))
      const { mockCtx } = baseContext()
      const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
        botId: 'b', botSecret: 's', defaultCwd: root, allowedCwdRoots: [root],
      })
      expect((await bridge.enqueue(msg('u1', '/cd inside'))).ok).toBe(true)
      expect((await bridge.enqueue(msg('u1', `/cd ${outside}`))).ok).toBe(false)
      expect((await bridge.enqueue(msg('u1', '/cd ../../'))).ok).toBe(false)
      expect((await bridge.enqueue(msg('u1', '/cd escape'))).ok).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('resumeSessions', () => {
  it('resumes the latest persisted generation for the chat when enabled', async () => {
    const persistedIds = [
      'wecom:bot-a:single:u1:2',
      'wecom:bot-a:single:u1:0',
      'wecom:bot-a:single:other:1',
    ]
    const { mockCtx, creates, resumes } = baseContext({ persisted: persistedIds, resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', resumeSessions: true })
    await bridge.enqueue(msg('u1', '继续'))
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!.resumeSessionId).toBe('wecom:bot-a:single:u1:2')
    expect(creates).toHaveLength(0)
  })

  it('creates a fresh session when nothing is persisted', async () => {
    const { mockCtx, creates, resumes } = baseContext({ resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', resumeSessions: true })
    await bridge.enqueue(msg('u1', '第一句'))
    expect(resumes).toHaveLength(0)
    expect(creates).toHaveLength(1)
    expect(creates[0]!.sessionId).toBe('wecom:bot-a:single:u1:0')
  })

  it('is disabled by default (never resumes, keeps epoch in id)', async () => {
    const { mockCtx, creates, resumes } = baseContext({ persisted: ['wecom:bot-a:single:u1:5'], resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('u1', '第一句'))
    expect(resumes).toHaveLength(0)
    expect(creates).toHaveLength(1)
    expect(String(creates[0]!.sessionId)).toMatch(/^wecom:bot-a:single:u1:[0-9a-f-]+:0$/)
  })

  it('falls back to create when persistence does not list a matching session', async () => {
    const { mockCtx, creates, resumes } = baseContext({ persisted: ['wecom:bot-a:single:other:3'], resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', resumeSessions: true })
    await bridge.enqueue(msg('u1', '第一句'))
    expect(resumes).toHaveLength(0)
    expect(creates).toHaveLength(1)
  })

  it('/new mints a fresh browser-visible session and creates it on next turn', async () => {
    const { mockCtx, creates, resumes } = baseContext({ resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', resumeSessions: true })
    await bridge.enqueue(msg('u1', '第一句'))
    expect(creates).toHaveLength(1)
    const res = await bridge.enqueue(msg('u1', '/new'))
    expect(res.ok).toBe(true)
    expect(res.text).toMatch(/session-[0-9a-f-]+/)
    // no wecom generation created by /new
    expect(creates).toHaveLength(1)
    await bridge.enqueue(msg('u1', '新会话第一句'))
    // fresh bound session is created (not resumed), not a wecom generation
    expect(resumes).toHaveLength(0)
    expect(creates).toHaveLength(2)
    expect(String(creates[1]!.sessionId)).toMatch(/^session-[0-9a-f-]+$/)
  })
})

describe('shared web session binding (option A)', () => {
  it('config bindSession: resumes the bound web session on first turn', async () => {
    const { mockCtx, creates, resumes } = baseContext({ resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
      botId: 'b', botSecret: 's', bindSession: { 'single:u1': 'web-ses-123' },
    })
    await bridge.enqueue(msg('u1', '写入共享会话'))
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!.resumeSessionId).toBe('web-ses-123')
    expect(creates).toHaveLength(0)
  })

  it('refuses to attach when the target session is already live (browser active)', async () => {
    const { mockCtx, creates, resumes } = baseContext({ resumeHandler: true, liveIds: ['web-ses-live'] })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
      botId: 'b', botSecret: 's', bindSession: { 'single:u1': 'web-ses-live' },
    })
    const res = await bridge.enqueue(msg('u1', '尝试写入'))
    // the refusal surfaces on the finalized thinking stream, not a rejection
    expect(res.ok).toBe(false)
    expect(res.text).toBe('')
    expect(resumes).toHaveLength(0)
    expect(creates).toHaveLength(0)
  })

  it('/attach binds a chat to a web session and resumes it', async () => {
    const { mockCtx, resumes } = baseContext({ resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', '/attach web-ses-456'))
    expect(res.ok).toBe(true)
    expect(res.text).toContain('web-ses-456')
    await bridge.enqueue(msg('u1', '写入共享会话'))
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!.resumeSessionId).toBe('web-ses-456')
  })

  it('/attach with no argument reports the current binding', async () => {
    const { mockCtx } = baseContext({ resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', bindSession: { 'single:u1': 'web-ses-789' } })
    const res = await bridge.enqueue(msg('u1', '/attach'))
    expect(res.ok).toBe(true)
    expect(res.text).toContain('web-ses-789')
  })

  it('/detach returns to an independent chat session', async () => {
    const { mockCtx, creates, resumes } = baseContext({ resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', bindSession: { 'single:u1': 'web-ses-789' } })
    await bridge.enqueue(msg('u1', '共享写入'))
    expect(resumes).toHaveLength(1)
    const res = await bridge.enqueue(msg('u1', '/detach'))
    expect(res.ok).toBe(true)
    await bridge.enqueue(msg('u1', '独立会话第一句'))
    expect(resumes).toHaveLength(1)
    expect(creates).toHaveLength(1)
  })

  it('/sessions lists persisted sessions in the current directory', async () => {
    const persisted = [
      'web-ses-in-cwd', 'web-ses-sibling', 'web-ses-other-dir', 'web-ses-bindme',
    ]
    const headers = [
      { header: { id: 'web-ses-in-cwd', cwd: '/ws', createdAt: 2000, agentPreset: 'standard' } },
      { header: { id: 'web-ses-bindme', cwd: '/ws', createdAt: 1000 } },
      { header: { id: 'web-ses-sibling', cwd: '/ws/sub', createdAt: 3000 } },
      { header: { id: 'web-ses-other-dir', cwd: '/elsewhere', createdAt: 4000 } },
    ]
    const mockCtx = {
      get(name: string): unknown {
        if (name === 'sessionPersistence') return { listSnapshots: async () => headers }
        return undefined
      },
    }
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, {
      botId: 'b', botSecret: 's', defaultWorkspace: '/ws',
    })
    const res = await bridge.enqueue(msg('u1', '/sessions'))
    expect(res.ok).toBe(true)
    expect(res.text).toContain('web-ses-in-cwd')
    expect(res.text).toContain('web-ses-bindme')
    // sibling (subdir) is under /ws so included; other-dir is not
    expect(res.text).toContain('web-ses-sibling')
    expect(res.text).not.toContain('web-ses-other-dir')
  })

  it('/sessions <id> binds to a persisted session and resumes it', async () => {
    const { mockCtx, resumes } = baseContext({ resumeHandler: true, persisted: ['web-ses-bindme'] })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', '/sessions web-ses-bindme'))
    expect(res.ok).toBe(true)
    expect(res.text).toContain('web-ses-bindme')
    await bridge.enqueue(msg('u1', '写入'))
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!.resumeSessionId).toBe('web-ses-bindme')
  })

  it('/sessions <id> rejects an unknown session id', async () => {
    const { mockCtx, resumes } = baseContext({ resumeHandler: true, persisted: ['web-ses-known'] })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's' })
    const res = await bridge.enqueue(msg('u1', '/sessions nope-zzz'))
    expect(res.ok).toBe(false)
    expect(res.text).toContain('未找到')
    expect(resumes).toHaveLength(0)
  })

  it('/new with defaultWorkspace mints a new browser session in the workspace', async () => {
    const { mockCtx, creates } = baseContext()
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultWorkspace: process.cwd(), persistBindings: false })
    await bridge.enqueue(msg('u1', '第一句'))
    expect(creates).toHaveLength(1)
    const res = await bridge.enqueue(msg('u1', '/new'))
    expect(res.ok).toBe(true)
    expect(res.text).toMatch(/session-[0-9a-f-]+/)
    await bridge.enqueue(msg('u1', '新会话第一句'))
    // second create is a fresh browser session (session-<uuid>), not resume
    expect(creates).toHaveLength(2)
    expect(String(creates[1]!.sessionId)).toMatch(/^session-[0-9a-f-]+$/)
  })

  it('attaches a bound browser session to its cwd workspace for the web UI', async () => {
    const { mockCtx, creates, attaches } = baseContext({ withRegistry: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultWorkspace: process.cwd(), persistBindings: false })
    await bridge.enqueue(msg('u1', '/new'))
    await bridge.enqueue(msg('u1', '新会话第一句'))
    expect(creates).toHaveLength(1)
    const createdId = String(creates[0]!.sessionId)
    expect(createdId).toMatch(/^session-[0-9a-f-]+$/)
    // workspace create was called, and attachSession received the created session id
    const attached = attaches.filter((a) => a.session !== 'RESOLVE')
    expect(attached).toHaveLength(1)
    expect(attached[0]!.session).toBe(createdId)
    expect(attached[0]!.path).toBe(process.cwd())
  })

  it('does not attach wecom: private sessions to a workspace', async () => {
    const { mockCtx, attaches } = baseContext({ withRegistry: true, resumeHandler: true })
    const bridge = new WecomAgentBridge(mockCtx as never, fakeBot() as never, { botId: 'b', botSecret: 's', resumeSessions: true })
    await bridge.enqueue(msg('u1', '普通对话'))
    expect(attaches.filter((a) => a.session !== 'RESOLVE')).toHaveLength(0)
  })
})

describe('web -> wecom mirror', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  const webUserEvent = (sessionId: string, id: string, text: string) => ({
    type: 'user/message', seq: 10, time: 1,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  const assistantEvent = (sessionId: string, text: string) => ({
    type: 'assistant/message', seq: 11, time: 2,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
  })
  const turnEndEvent = (sessionId: string) => ({
    type: 'turn/end', seq: 12, time: 3, data: { turn: 1, reason: { kind: 'completed' } },
  })

  it('mirrors a browser user message and the assistant reply to the bound WeCom chat', async () => {
    const { mockCtx, emit } = baseContext({ resumeHandler: true })
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('u1', '/attach web-ses-1'))
    expect(bot.sendText).not.toHaveBeenCalled()

    emit('session/event', { id: 'web-ses-1' }, webUserEvent('web-ses-1', 'w-1', '你好，web'))
    await flush()
    expect(bot.sendText).toHaveBeenCalledTimes(1)
    expect(bot.sendText.mock.calls[0]![0]).toBe('u1')
    expect(bot.sendText.mock.calls[0]![1]).toContain('你好，web')

    emit('session/event', { id: 'web-ses-1' }, assistantEvent('web-ses-1', '这是 web 上的回复'))
    emit('session/event', { id: 'web-ses-1' }, turnEndEvent('web-ses-1'))
    await flush()
    expect(bot.sendText).toHaveBeenCalledTimes(2)
    expect(bot.sendText.mock.calls[1]![0]).toBe('u1')
    expect(bot.sendText.mock.calls[1]![1]).toContain('这是 web 上的回复')
  })

  it('does not mirror a web message on a session that is not bound to this chat', async () => {
    const { mockCtx, emit } = baseContext({ resumeHandler: true })
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's' })
    // u1 chats normally (unbound) — its wecom: session must not be mirrored
    await bridge.enqueue(msg('u1', '普通对话'))
    emit('session/event', { id: 'wecom:bot-a:single:u1' }, webUserEvent('wecom:bot-a:single:u1', 'w-x', 'browser text'))
    await flush()
    expect(bot.sendText).not.toHaveBeenCalled()
  })

  it('never mirrors a plugin-forwarded wecom->web turn back into WeCom', async () => {
    const { mockCtx, emit } = baseContext({ resumeHandler: true })
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('u1', '/attach web-ses-2'))
    // A wecom message drives the bound session in-process; the plugin replies
    // normally and must NOT additionally mirror it (no echo loop).
    await bridge.enqueue(msg('u1', '来自 wecom 的消息'))
    await flush()
    expect(bot.sendText).not.toHaveBeenCalled()
    // /attach is a command (replyText); the wecom turn opens+finalizes thinking
    expect(bot.replyText).toHaveBeenCalledTimes(1)
    expect(bot.finishReply).toHaveBeenCalledTimes(1)
  })

  it('mirrorWebToWecom:false disables the mirror entirely', async () => {
    const { mockCtx, emit } = baseContext({ resumeHandler: true })
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's', mirrorWebToWecom: false })
    await bridge.enqueue(msg('u1', '/attach web-ses-3'))
    emit('session/event', { id: 'web-ses-3' }, webUserEvent('web-ses-3', 'w-3', '浏览器消息'))
    emit('session/event', { id: 'web-ses-3' }, assistantEvent('web-ses-3', '回复'))
    emit('session/event', { id: 'web-ses-3' }, turnEndEvent('web-ses-3'))
    await flush()
    expect(bot.sendText).not.toHaveBeenCalled()
  })
})

describe('thinking indicator', () => {
  it('opens a thinking stream and finalizes it with the agent reply', async () => {
    const { mockCtx } = baseContext()
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's' })
    await bridge.enqueue(msg('u1', '你好'))
    // placeholder opened first, then the same-stream final reply
    expect(bot.openThinking).toHaveBeenCalledTimes(1)
    expect(String(bot.openThinking.mock.calls[0]![0] !== undefined)).toBe('true')
    expect(bot.finishReply).toHaveBeenCalledTimes(1)
    expect(bot.finishReply.mock.calls[0]![1]).toBe('stream-1') // same stream id as opened
    expect(bot.finishReply.mock.calls[0]![2]).toContain('你好')
    expect(bot.replyText).not.toHaveBeenCalled()
  })

  it('uses custom thinkingText when configured', async () => {
    const { mockCtx } = baseContext()
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's', thinkingText: '✨ 加载中…' })
    await bridge.enqueue(msg('u1', '你好'))
    expect(bot.openThinking).toHaveBeenCalledTimes(1)
    expect(bot.openThinking.mock.calls[0]![1]).toBe('✨ 加载中…')
  })

  it('showThinking:false replies directly without a thinking stream', async () => {
    const { mockCtx } = baseContext()
    const bot = fakeBot()
    const bridge = new WecomAgentBridge(mockCtx as never, bot as never, { botId: 'b', botSecret: 's', showThinking: false })
    await bridge.enqueue(msg('u1', '你好'))
    expect(bot.openThinking).toHaveBeenCalledTimes(0)
    expect(bot.replyText).toHaveBeenCalledTimes(1)
    expect(bot.replyText.mock.calls[0]![1]).toContain('你好')
  })
})

describe('binding persistence across restarts', () => {
  it('restores a runtime binding after a restart (second bridge resumes the same session)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wecom-bind-'))
    try {
      const { mockCtx: c1 } = baseContext()
      const bridge1 = new WecomAgentBridge(c1 as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultWorkspace: dir })
      await bridge1.enqueue(msg('u1', '/attach web-ses-persist'))
      await new Promise((resolve) => setTimeout(resolve, 30)) // flush persist write

      // Simulate a process restart: a brand new bridge over the same workspace.
      const { mockCtx: c2, resumes, creates } = baseContext({ resumeHandler: true })
      const bridge2 = new WecomAgentBridge(c2 as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultWorkspace: dir })
      await bridge2.enqueue(msg('u1', '继续'))
      expect(resumes).toHaveLength(1)
      expect(String(resumes[0]!.resumeSessionId)).toBe('web-ses-persist')
      expect(creates).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('/detach removes the persisted binding so a restart does not resurrect it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wecom-bind-'))
    try {
      const { mockCtx: c1 } = baseContext()
      const bridge1 = new WecomAgentBridge(c1 as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultWorkspace: dir })
      await bridge1.enqueue(msg('u1', '/attach web-ses-x'))
      await bridge1.enqueue(msg('u1', '/detach'))
      await new Promise((resolve) => setTimeout(resolve, 30))

      const { mockCtx: c2, resumes, creates } = baseContext({ resumeHandler: true })
      const bridge2 = new WecomAgentBridge(c2 as never, fakeBot() as never, { botId: 'b', botSecret: 's', defaultWorkspace: dir, resumeSessions: true })
      await bridge2.enqueue(msg('u1', '继续'))
      // no binding restored → a fresh wecom: session is created (nothing resumed)
      expect(resumes).toHaveLength(0)
      expect(creates).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
