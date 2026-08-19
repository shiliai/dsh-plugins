import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle as DshAgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WsFrame } from '@wecom/aibot-node-sdk'
import { WecomBot, type InboundMessage } from './bot.ts'
import { summarizeTurn, type TurnResult } from './frame.ts'
import { registerWecomTools } from './tools.ts'

export const name = 'dsh-wecom'
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'tools']

export interface Config {
  botId: string
  botSecret: string
  /** Only allow these chat ids (empty = allow all). */
  allowChats?: string[]
  /** Max chars of an agent reply sent back to WeCom. */
  maxReplyChars?: number
}

interface LiveHandle {
  agent: Agent
  dispose: () => Promise<void>
}

/**
 * Keeps one persistent agent per WeCom chat. Each chat gets its own session id
 * (`wecom-<chatId>`) so conversations are isolated and carry their own memory.
 * A single serial queue protects each agent (an agent runs one turn at a time).
 */
export class WecomAgentBridge {
  bridgeId = ''
  private readonly handles = new Map<string, LiveHandle>()
  private readonly queues = new Map<string, Promise<void>>()
  /** Per-chat rolling transcript so the LLM always sees prior turns explicitly. */
  private readonly transcripts = new Map<string, string[]>()
  private readonly config: Config
  /** Max prior turns/clips injected into each message. */
  private readonly maxContextTurns = 12

  constructor(private ctx: Context, private bot: WecomBot, config: Config) {
    this.config = config
  }

  /** Build an explicit, self-contained prompt: prior transcript + new message. */
  private buildPrompt(chatId: string, message: string): string {
    const hist = this.transcripts.get(chatId) ?? []
    if (hist.length === 0) return message
    // Clip to recent turns to avoid unbounded growth.
    const recent = hist.slice(-this.maxContextTurns * 2)
    const transcriptText = recent.map((t) => `- ${t}`).join('\n')
    return [
      '以下是同一次对话的历史记录（较早的在前）：',
      transcriptText,
      '',
      '请基于以上历史回答用户的最新消息（不要复述历史，直接回应最新问题）。',
      `当前用户消息：${message}`,
    ].join('\n')
  }

  private async ensureAgent(chatId: string): Promise<LiveHandle> {
    const existing = this.handles.get(chatId)
    if (existing) {
      // eslint-disable-next-line no-console
      console.log(`[dsh-wecom] ensureAgent REUSE_CACHED chatId=${JSON.stringify(chatId)} handleSession=${String(existing.agent.session.id)} handles.size=${this.handles.size}`)
      return existing
    }
    const agents = this.ctx.get('agents')
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (!agents || !defaultModel) throw new Error('dsh-wecom: agents/agentDefaultModel service unavailable')
    const selection = defaultModel.currentSelection()
    const sessionId = SessionId(`wecom-${chatId}`)
    // 1) Reuse a live agent already registered for this stable session id.
    const live = agents.get(sessionId)
    if (live) {
      // eslint-disable-next-line no-console
      console.log(`[dsh-wecom] ensureAgent REUSE_LIVE chatId=${JSON.stringify(chatId)} sessionId=${String(sessionId)}`)
      const handle: LiveHandle = { agent: live, dispose: async () => {} }
      this.handles.set(chatId, handle)
      return handle
    }
    // 2) Resume a persisted session (loads history → conversation memory).
    //    Fall back to create only for a brand-new id so we never re-create an
    //    id that already has a persisted log (that caused a fatal "id
    //    collision" that crashed and reloaded the plugin, wiping memory).
    let handle: LiveHandle
    try {
      if (typeof agents.resume === 'function') {
        // eslint-disable-next-line no-console
        console.log(`[dsh-wecom] ensureAgent RESUME chatId=${JSON.stringify(chatId)} sessionId=${String(sessionId)}`)
        const resumed: DshAgentHandle = await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 })
          },
        })
        handle = { agent: resumed.agent, dispose: () => resumed.dispose() }
      } else {
        throw new Error('agents.resume unavailable')
      }
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[dsh-wecom] ensureAgent CREATE_NEW (no persisted session) chatId=${JSON.stringify(chatId)} sessionId=${String(sessionId)}`)
      const created: DshAgentHandle = await agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 })
        },
      })
      handle = { agent: created.agent, dispose: () => created.dispose() }
    }
    this.handles.set(chatId, handle)
    return handle
  }

  /** Run one WeCom message through this chat's agent and return its reply text. */
  private async runTurn(chatId: string, message: string): Promise<TurnResult> {
    const { agent } = await this.ensureAgent(chatId)
    const sessions = this.ctx.get('sessions')
    const firstSeq = agent.session.seq
    const prompt = this.buildPrompt(chatId, message)
    let history = 0
    try { history = agent.session.deriveMessages().length } catch { /* ignore */ }
    // eslint-disable-next-line no-console
    console.log(`[dsh-wecom] runTurn chatId=${JSON.stringify(chatId)} sessionId=${String(agent.session.id)} seq=${firstSeq} deriveHistory=${history} transcriptLen=${this.transcripts.get(chatId)?.length ?? 0} msg=${JSON.stringify(message.slice(0, 80))}`)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    if (sessions) await sessions.flush(agent.session)
    const result = summarizeTurn(agent.session.events, firstSeq)
    // Record this exchange into the rolling transcript.
    const tx = this.transcripts.get(chatId) ?? []
    tx.push(`用户：${message}`)
    if (result.text) tx.push(`助手：${result.text}`)
    this.transcripts.set(chatId, tx)
    return result
  }

  /** Serialize turns per chat so an agent never runs two turns concurrently. */
  enqueue(message: InboundMessage): Promise<TurnResult> {
    const prevQueue = this.queues.get(message.chatId) ?? Promise.resolve()
    const task = async () => {
      const result = await this.runTurn(message.chatId, message.text)
      if (result.text) {
        const max = this.config.maxReplyChars ?? 20000
        await this.bot.replyText(message.frame, result.text.slice(0, max))
      }
      return result
    }
    const next = prevQueue.then(task, task)
    this.queues.set(message.chatId, next.then(() => undefined, () => undefined))
    return next
  }

  /** Pre-create one agent so the first chat message has no cold start. */
  async start(): Promise<void> {
    // Lazy; nothing to eagerly warm.
  }

  async dispose(): Promise<void> {
    for (const h of this.handles.values()) await h.dispose()
    this.handles.clear()
    this.queues.clear()
    this.transcripts.clear()
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.botId || !config.botSecret) {
    // eslint-disable-next-line no-console
    console.warn('[dsh-wecom] missing botId/botSecret; plugin disabled')
    return
  }
  const bridgeId = `bridge-${Math.random().toString(36).slice(2, 8)}`
  // eslint-disable-next-line no-console
  console.log(`[dsh-wecom] apply() CALLED bridgeId=${bridgeId} at ${new Date().toISOString()}`)
  const bot = new WecomBot({ botId: config.botId, botSecret: config.botSecret })
  const bridge = new WecomAgentBridge(ctx, bot, config)
  bridge.bridgeId = bridgeId

  registerWecomTools(ctx, bot)

  await bot.start(async (msg) => {
    const allow = config.allowChats ?? []
    if (allow.length > 0 && !allow.includes(msg.chatId)) return
    // eslint-disable-next-line no-console
    console.log(`[dsh-wecom] onMessage bridgeId=${bridge.bridgeId} chatId=${JSON.stringify(msg.chatId)}`)
    await bridge.enqueue(msg)
  })

  await bridge.start()

  ctx.effect(() => {
    return () => {
      // eslint-disable-next-line no-console
      console.log(`[dsh-wecom] effect-dispose bridgeId=${bridgeId}`)
      bot.disconnect()
      void bridge.dispose()
    }
  }, 'dsh-wecom.dispose')
}

export { WecomBot } from './bot.ts'
export type { InboundMessage } from './bot.ts'
