import type { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle as DshAgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WsFrame } from '@wecom/aibot-node-sdk'
import { WecomBot, type InboundMessage } from './bot.ts'
import { parseCommand, renderHelp, resolveWorkingDir } from './commands.ts'
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
  /** Default working directory for new conversations (defaults to process.cwd()). */
  defaultCwd?: string
  /** Agent preset id mounted on new conversations (defaults to the roster default). */
  defaultPreset?: string
}

interface LiveHandle {
  agent: Agent
  dispose: () => Promise<void>
}

/** Minimal structural contract of the optional `agentPresets` service. */
interface PresetsLike {
  defaultId: string
  resolve(id?: string): Promise<{ id: string; name?: string; description?: string }>
  list(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
  composedPreset(agentCtx: unknown): string | undefined
}

/** Per-chat bookkeeping: one live conversation ("generation") at a time. */
interface ChatState {
  chatId: string
  /** Bumped on /new, /cd, /agent to mint a fresh session id. */
  generation: number
  /** Working directory this conversation's agent runs in. */
  cwd: string
  /** Explicitly chosen agent preset id; undefined = use the default. */
  presetId: string | undefined
  /** The live agent for the current generation (lazily created). */
  handle: LiveHandle | undefined
  /** Per-chat rolling transcript so the LLM always sees prior turns explicitly. */
  transcript: string[]
}

/**
 * Keeps one persistent agent per WeCom chat. Each chat gets its own session id
 * (`wecom-<chatId>-<generation>`) so conversations are isolated and carry their
 * own memory. A single serial queue protects each agent (an agent runs one turn
 * at a time). Slash commands (`/new`, `/cd`, `/agent`, …) are handled locally
 * and never passed to the LLM.
 */
export class WecomAgentBridge {
  bridgeId = ''
  private readonly states = new Map<string, ChatState>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly config: Config
  /** Max prior turns/clips injected into each message. */
  private readonly maxContextTurns = 12

  constructor(private ctx: Context, private bot: WecomBot, config: Config) {
    this.config = config
  }

  // ---- per-chat state -------------------------------------------------------

  private chatState(chatId: string): ChatState {
    let st = this.states.get(chatId)
    if (!st) {
      st = {
        chatId,
        generation: 0,
        cwd: this.config.defaultCwd ?? process.cwd(),
        presetId: undefined,
        handle: undefined,
        transcript: [],
      }
      this.states.set(chatId, st)
    }
    return st
  }

  private sessionIdOf(st: ChatState) {
    return SessionId(`wecom-${st.chatId}-${st.generation}`)
  }

  /** The preset this chat should run on: explicit choice, else the default. */
  private chosenPreset(st: ChatState): string | undefined {
    return st.presetId ?? this.config.defaultPreset
  }

  /** Tear down the current generation and prepare a fresh one. */
  private async resetContext(st: ChatState): Promise<void> {
    if (st.handle) {
      // eslint-disable-next-line no-console
      console.log(`[dsh-wecom] resetContext chatId=${JSON.stringify(st.chatId)} disposing gen=${st.generation}`)
      await st.handle.dispose()
    }
    st.handle = undefined
    st.transcript = []
    st.generation += 1
  }

  // ---- agent lifecycle ------------------------------------------------------

  /** Build an explicit, self-contained prompt: prior transcript + new message. */
  private buildPrompt(st: ChatState, message: string): string {
    const hist = st.transcript
    if (hist.length === 0) return message
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

  private async ensureAgent(st: ChatState): Promise<LiveHandle> {
    if (st.handle) {
      // eslint-disable-next-line no-console
      console.log(`[dsh-wecom] ensureAgent REUSE_CACHED chatId=${JSON.stringify(st.chatId)} handleSession=${String(st.handle.agent.session.id)} gen=${st.generation}`)
      return st.handle
    }
    const agents = this.ctx.get('agents')
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (!agents || !defaultModel) throw new Error('dsh-wecom: agents/agentDefaultModel service unavailable')
    const selection = defaultModel.currentSelection()
    const presets = this.ctx.get('agentPresets') as PresetsLike | undefined
    const sessionId = this.sessionIdOf(st)

    // Resolve the desired preset BEFORE creation so it can stamp the session
    // header, then have setup() mount it (the one supported call site).
    const wantPreset = this.chosenPreset(st)
    let resolvedPreset: string | undefined
    if (presets && wantPreset) {
      try {
        resolvedPreset = (await presets.resolve(wantPreset)).id
      } catch (err) {
        throw new Error(
          `dsh-wecom: agent preset "${wantPreset}" unavailable (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }
    const makeSetup = () => async (agentCtx: Context) => {
      installModelSelection(agentCtx, { current: selection, assembled: void 0 })
      if (presets && resolvedPreset) await presets.mount(agentCtx, resolvedPreset)
    }

    // 1) Reuse a live agent already registered for this stable session id.
    const live = agents.get(sessionId)
    if (live) {
      // eslint-disable-next-line no-console
      console.log(`[dsh-wecom] ensureAgent REUSE_LIVE chatId=${JSON.stringify(st.chatId)} sessionId=${String(sessionId)}`)
      const handle: LiveHandle = { agent: live, dispose: async () => {} }
      st.handle = handle
      return handle
    }
    // 2) Resume a persisted session (loads history → conversation memory).
    //    Fall back to create only for a brand-new id so we never re-create an
    //    id that already has a persisted log (that caused a fatal "id
    //    collision" that crashed and reloaded the plugin, wiping memory).
    try {
      if (typeof agents.resume === 'function') {
        // eslint-disable-next-line no-console
        console.log(`[dsh-wecom] ensureAgent RESUME chatId=${JSON.stringify(st.chatId)} sessionId=${String(sessionId)}`)
        const resumed: DshAgentHandle = await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: makeSetup(),
        })
        st.handle = { agent: resumed.agent, dispose: () => resumed.dispose() }
        return st.handle
      }
      throw new Error('agents.resume unavailable')
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[dsh-wecom] ensureAgent CREATE_NEW (no persisted session) chatId=${JSON.stringify(st.chatId)} sessionId=${String(sessionId)} cwd=${JSON.stringify(st.cwd)} preset=${JSON.stringify(resolvedPreset)}`)
      const meta: { cwd: string; agentPreset?: string } = { cwd: st.cwd }
      if (resolvedPreset !== undefined) meta.agentPreset = resolvedPreset
      const created: DshAgentHandle = await agents.create({
        sessionId,
        meta,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: makeSetup(),
      })
      st.handle = { agent: created.agent, dispose: () => created.dispose() }
      return st.handle
    }
  }

  /** Run one WeCom message through this chat's agent and return its reply text. */
  private async runTurn(chatId: string, message: string): Promise<TurnResult> {
    const st = this.chatState(chatId)
    const { agent } = await this.ensureAgent(st)
    const sessions = this.ctx.get('sessions')
    const firstSeq = agent.session.seq
    const prompt = this.buildPrompt(st, message)
    let history = 0
    try { history = agent.session.deriveMessages().length } catch { /* ignore */ }
    // eslint-disable-next-line no-console
    console.log(`[dsh-wecom] runTurn chatId=${JSON.stringify(chatId)} sessionId=${String(agent.session.id)} seq=${firstSeq} deriveHistory=${history} transcriptLen=${st.transcript.length} msg=${JSON.stringify(message.slice(0, 80))}`)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    if (sessions) await sessions.flush(agent.session)
    const result = summarizeTurn(agent.session.events, firstSeq)
    st.transcript.push(`用户：${message}`)
    if (result.text) st.transcript.push(`助手：${result.text}`)
    return result
  }

  // ---- slash commands -------------------------------------------------------

  private async handleCommand(msg: InboundMessage): Promise<TurnResult | null> {
    const parsed = parseCommand(msg.text)
    if (!parsed) return null
    switch (parsed.name) {
      case 'help': return this.cmdHelp()
      case 'new': return this.cmdNew(msg.chatId)
      case 'cd': return this.cmdCd(msg.chatId, parsed.arg)
      case 'pwd': return this.cmdPwd(msg.chatId)
      case 'agent': return this.cmdAgent(msg.chatId, parsed.arg)
      case 'status': return this.cmdStatus(msg.chatId)
      default: {
        this.cmdUnknown(parsed.name)
        return { text: `未知命令 /${parsed.name}。可用命令见 /help。`, ok: true }
      }
    }
  }

  private cmdHelp(): TurnResult {
    return { text: renderHelp(), ok: true }
  }

  private cmdUnknown(name: string): void {
    // eslint-disable-next-line no-console
    console.log(`[dsh-wecom] unknown command /${name}`)
  }

  private async cmdNew(chatId: string): Promise<TurnResult> {
    const st = this.chatState(chatId)
    await this.resetContext(st)
    return { text: '🆕 已开启新的对话（记忆已清空，工作目录与 Agent 保持不变）。', ok: true }
  }

  private async cmdCd(chatId: string, arg: string): Promise<TurnResult> {
    const st = this.chatState(chatId)
    if (!arg) return this.cmdPwd(chatId)
    const target = resolveWorkingDir(arg, st.cwd)
    let isDir = false
    try { isDir = statSync(target).isDirectory() } catch { /* not a dir */ }
    if (!isDir) return { text: `❌ 目录不存在或不可访问：\`${target}\``, ok: false }
    if (target === st.cwd) return { text: `当前已在 \`${target}\``, ok: true }
    const old = st.cwd
    st.cwd = target
    await this.resetContext(st)
    return { text: `📂 工作目录已切换：\`${old}\` → \`${target}\`（已开启新会话）。`, ok: true }
  }

  private async cmdPwd(chatId: string): Promise<TurnResult> {
    const st = this.chatState(chatId)
    return { text: `当前工作目录：\`${st.cwd}\``, ok: true }
  }

  private async cmdAgent(chatId: string, arg: string): Promise<TurnResult> {
    const st = this.chatState(chatId)
    const presets = this.ctx.get('agentPresets') as PresetsLike | undefined
    if (!presets) {
      return { text: '⚠️ 当前环境未启用 agent presets，无法列出/切换 Agent。', ok: false }
    }
    if (!arg) {
      // list available presets + current
      let rows: Array<{ id: string; name?: string; description?: string; broken?: string }> = []
      try { rows = await presets.list() } catch (e) {
        return { text: `无法读取 Agent 列表: ${e instanceof Error ? e.message : String(e)}`, ok: false }
      }
      let current: string | undefined = st.presetId ?? this.config.defaultPreset
      if (current === undefined && st.handle) {
        try { current = presets.composedPreset(st.handle.agent.ctx) } catch { /* ignore */ }
      }
      if (rows.length === 0) return { text: '当前没有可用的 Agent preset。', ok: false }
      const lines = ['🤖 可用 Agent：', ...rows.map((r) => {
        const label = r.name ?? r.id
        const broken = r.broken ? '（❌ ' + r.broken + '）' : ''
        const mark = current === r.id ? '【当前】 ' : ''
        return `· ${mark}${label} (\`${r.id}\`)${broken}\n　${r.description ?? ''}`
      })]
      if (current === undefined) lines.push('（当前会话未绑定预设）')
      return { text: lines.join('\n'), ok: true }
    }
    // switch
    let resolved: { id: string; name?: string }
    try {
      resolved = await presets.resolve(arg)
    } catch (e) {
      return { text: `❌ 未找到 Agent：\`${arg}\`（${e instanceof Error ? e.message : String(e)}）`, ok: false }
    }
    if (st.presetId === resolved.id) {
      return { text: `当前已是 Agent「${resolved.name ?? resolved.id}」。`, ok: true }
    }
    st.presetId = resolved.id
    await this.resetContext(st)
    return { text: `🤖 已切换到 Agent「${resolved.name ?? resolved.id}」（已开启新会话）。`, ok: true }
  }

  private async cmdStatus(chatId: string): Promise<TurnResult> {
    const st = this.chatState(chatId)
    const defaultModel = this.ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } } | undefined
    const sel = defaultModel?.currentSelection?.()
    const presets = this.ctx.get('agentPresets') as PresetsLike | undefined
    const sessionId = st.handle ? String(st.handle.agent.session.id) : String(this.sessionIdOf(st))
    let preset: string | undefined = st.presetId ?? this.config.defaultPreset
    if (preset === undefined && st.handle && presets) {
      try { preset = presets.composedPreset(st.handle.agent.ctx) } catch { /* ignore */ }
    }
    const parts = [
      '📌 会话状态',
      `会话：\`${sessionId}\``,
      `工作目录：\`${st.cwd}\``,
      `Agent：${preset ? `\`${preset}\`` : '（默认/未绑定）'}`,
      `模型：${sel ? `${sel.provider}/${sel.model}` : '未知'}`,
    ]
    return { text: parts.join('\n'), ok: true }
  }

  // ---- inbound routing ------------------------------------------------------

  /** Serialize turns per chat so an agent never runs two turns concurrently. */
  enqueue(message: InboundMessage): Promise<TurnResult> {
    const prevQueue = this.queues.get(message.chatId) ?? Promise.resolve()
    const task = async () => {
      const cmd = await this.handleCommand(message)
      if (cmd) {
        if (cmd.text) await this.bot.replyText(message.frame, cmd.text.slice(0, this.config.maxReplyChars ?? 20000))
        return cmd
      }
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
    for (const st of this.states.values()) if (st.handle) await st.handle.dispose()
    this.states.clear()
    this.queues.clear()
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
export { parseCommand, resolveWorkingDir, renderHelp, COMMANDS } from './commands.ts'
