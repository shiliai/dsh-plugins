import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle as DshAgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WecomBot, type InboundMessage } from './bot.ts'
import { parseCommand, renderHelp, resolveWorkingDir } from './commands.ts'
import { summarizeTurn, type TurnResult } from './frame.ts'
import { makeLogger, isLogLevel, type Logger, type LogLevel } from './log.ts'
import { isAllowed, resolveAllowedDirectory, safeErrorKind, truncateUtf8 } from './safety.ts'
import { registerWecomTools } from './tools.ts'
import { registerWecomApi } from './http-api.ts'
import { WecomLifecycleController } from './lifecycle.ts'
import { PLUGIN_VERSION } from './version.ts'

export const name = 'dsh-wecom'
export const inject = ['tools', 'agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'webServer']

export interface Config {
  botId: string
  botSecret: string
  /** Allowed direct chat ids/userids. Empty means deny. `*` explicitly allows all direct chats. */
  allowChats?: string[]
  /** Allowed group senders. Groups still require a sender allowlist even when allowChats contains `*`. */
  allowGroupSenders?: string[]
  /** Allowed destination chats for `wecom_send_message`. Empty means deny. */
  outboundAllowChats?: string[]
  /** Root directories that `/cd` may enter; defaults to defaultCwd/process.cwd(). */
  allowedCwdRoots?: string[]
  defaultCwd?: string
  defaultPreset?: string
  maxLiveChats?: number
  idleChatMs?: number
  /** Diagnostic verbosity: error | warn | info (default) | debug. */
  logLevel?: LogLevel
  /** Trusted DSH browser origin for plugin restart requests. Defaults to local DSH. */
  managementOrigin?: string
}

/** Keep runtime-loaded configuration compatible with the former apply() default. */
export function normalizeConfig(config: Config): Config {
  return {
    ...config,
    logLevel: isLogLevel(config.logLevel) ? config.logLevel : 'info',
    managementOrigin: normalizeManagementOrigin(config.managementOrigin),
  }
}

export function normalizeManagementOrigin(value: string | undefined): string {
  const candidate = value ?? 'http://127.0.0.1:3180'
  let url: URL
  try { url = new URL(candidate) } catch { throw new Error('dsh-wecom: managementOrigin must be an HTTP(S) origin without a path.') }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('dsh-wecom: managementOrigin must be an HTTP(S) origin without a path.')
  }
  return url.origin
}

interface LiveHandle {
  agent: Agent
  dispose: () => Promise<void>
}

interface ModelSelection {
  provider: string
  model: string
}

interface PresetRow {
  id: string
  name?: string
  description?: string
  broken?: string
}

interface PresetsLike {
  defaultId: string
  resolve(id?: string): Promise<{ id: string; name?: string; description?: string }>
  list(): Promise<PresetRow[]>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

interface ChatState {
  chatId: string
  chatType: string
  generation: number
  cwd: string
  presetId: string | undefined
  handle: LiveHandle | undefined
  modelSelection: ModelSelection | undefined
  lastActiveAt: number
}

function chatKey(chatType: string, chatId: string): string {
  return `${chatType}:${chatId}`
}

/** Public for narrow authorization tests and host integrations. */
export function isInboundAuthorized(message: InboundMessage, config: Config): boolean {
  if (message.chatType === 'group') {
    return isAllowed(message.chatId, config.allowChats) && isAllowed(message.senderId, config.allowGroupSenders)
  }
  return isAllowed(message.chatId, config.allowChats) || isAllowed(message.senderId, config.allowChats)
}

/**
 * In-process bridge. Session ids contain a stable bot namespace and chat identity,
 * plus an in-process epoch. We intentionally never resume persisted sessions: the
 * documented memory contract is process-local and `/new` must never revive gen 0.
 */
export class WecomAgentBridge {
  private readonly states = new Map<string, ChatState>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly evictions = new Map<string, Promise<void>>()
  private readonly config: Config
  private readonly epoch = randomUUID()
  private readonly idleSweep: ReturnType<typeof setInterval>
  private readonly log: Logger
  private accepting = true

  constructor(private ctx: Context, private bot: WecomBot, config: Config) {
    this.config = config
    this.log = makeLogger(config.logLevel ?? 'info')
    const interval = Math.max(1_000, Math.min(config.idleChatMs ?? 30 * 60_000, 60_000))
    this.idleSweep = setInterval(() => {
      void this.evictIdle()
    }, interval)
    this.idleSweep.unref?.()
  }

  private chatState(message: Pick<InboundMessage, 'chatId' | 'chatType'>): ChatState {
    const type = message.chatType || 'unknown'
    const key = chatKey(type, message.chatId)
    let state = this.states.get(key)
    if (!state) {
      state = {
        chatId: message.chatId,
        chatType: type,
        generation: 0,
        cwd: this.config.defaultCwd ?? process.cwd(),
        presetId: undefined,
        handle: undefined,
        modelSelection: undefined,
        lastActiveAt: Date.now(),
      }
      this.states.set(key, state)
    }
    state.lastActiveAt = Date.now()
    return state
  }

  private sessionIdOf(st: ChatState) {
    return SessionId(`wecom:${encodeURIComponent(this.bot.identity)}:${encodeURIComponent(st.chatType)}:${encodeURIComponent(st.chatId)}:${this.epoch}:${st.generation}`)
  }

  private cwdRoots(): string[] {
    return this.config.allowedCwdRoots ?? [this.config.defaultCwd ?? process.cwd()]
  }

  private async resolvePreset(presets: PresetsLike | undefined, requested: string | undefined): Promise<{ id: string; name?: string }> {
    if (!presets) throw new Error('dsh-wecom: agentPresets service unavailable')
    const candidate = requested ?? presets.defaultId
    if (!candidate) throw new Error('dsh-wecom: agentPresets has no defaultId')
    const rows = await presets.list()
    const exactId = rows.find((row) => row.id === candidate)
    const names = rows.filter((row) => row.name === candidate)
    if (!exactId && names.length > 1) throw new Error(`dsh-wecom: preset display name "${candidate}" is ambiguous; use its id`)
    const selected = exactId ?? names[0]
    if (!selected) throw new Error(`dsh-wecom: agent preset "${candidate}" is unavailable`)
    if (selected.broken) throw new Error(`dsh-wecom: agent preset "${selected.id}" is broken: ${selected.broken}`)
    const resolved = await presets.resolve(selected.id)
    const name = resolved.name ?? selected.name
    return name === undefined ? { id: resolved.id } : { id: resolved.id, name }
  }

  private async resetContext(st: ChatState): Promise<void> {
    if (st.handle) {
      this.log.debug('reset: dispose generation', { chatId: st.chatId, chatType: st.chatType, generation: st.generation })
      await st.handle.dispose()
    }
    st.handle = undefined
    st.modelSelection = undefined
    st.generation += 1
    st.lastActiveAt = Date.now()
    this.log.info('new generation', { chatId: st.chatId, chatType: st.chatType, generation: st.generation })
  }

  private async ensureAgent(st: ChatState): Promise<LiveHandle> {
    if (st.handle) return st.handle
    const cwd = await resolveAllowedDirectory(st.cwd, this.cwdRoots())
    if (!cwd) throw new Error('dsh-wecom: configured working directory is unavailable or outside allowedCwdRoots')
    st.cwd = cwd
    const agents = this.ctx.get('agents')
    const defaultModel = this.ctx.get('agentDefaultModel') as { currentSelection(): ModelSelection } | undefined
    if (!agents || !defaultModel) throw new Error('dsh-wecom: agents/agentDefaultModel service unavailable')
    const selection = defaultModel.currentSelection()
    const presets = this.ctx.get('agentPresets') as PresetsLike | undefined
    if (!presets) throw new Error('dsh-wecom: agentPresets service unavailable')
    const resolvedPreset = await this.resolvePreset(presets, st.presetId ?? this.config.defaultPreset)
    const setup = async (agentCtx: Context) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await presets.mount(agentCtx, resolvedPreset.id)
    }
    const meta = { cwd: st.cwd, agentPreset: resolvedPreset.id }
    this.log.info('agent create', {
      chatId: st.chatId,
      chatType: st.chatType,
      generation: st.generation,
      cwd: st.cwd,
      preset: resolvedPreset.id,
      model: `${selection.provider}/${selection.model}`,
    })
    const created: DshAgentHandle = await agents.create({
      sessionId: this.sessionIdOf(st),
      meta,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
    st.modelSelection = { ...selection }
    st.handle = { agent: created.agent, dispose: () => created.dispose() }
    return st.handle
  }

  private async runTurn(message: InboundMessage): Promise<TurnResult> {
    const st = this.chatState(message)
    const { agent } = await this.ensureAgent(st)
    const sessions = this.ctx.get('sessions')
    const firstSeq = agent.session.seq
    this.log.debug('run turn', {
      chatId: st.chatId,
      chatType: st.chatType,
      generation: st.generation,
      cwd: st.cwd,
      seq: firstSeq,
      bytes: Buffer.byteLength(message.text, 'utf8'),
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } }))
    await agent.whenIdle()
    if (sessions) await sessions.flush(agent.session)
    return summarizeTurn(agent.session.events, firstSeq)
  }

  private async handleCommand(message: InboundMessage): Promise<TurnResult | null> {
    const parsed = parseCommand(message.text)
    if (!parsed) return null
    const st = this.chatState(message)
    this.log.info('command', {
      chatId: st.chatId,
      chatType: st.chatType,
      command: parsed.name,
      argsBytes: Buffer.byteLength(parsed.arg, 'utf8'),
    })
    switch (parsed.name) {
      case 'help': return { text: renderHelp(), ok: true }
      case 'new':
        await this.resetContext(st)
        return { text: '已开启新的对话（进程内记忆已清空，工作目录与 Agent 保持不变）。', ok: true }
      case 'cd': return this.cmdCd(st, parsed.arg)
      case 'pwd': return { text: `当前工作目录：\`${st.cwd}\``, ok: true }
      case 'agent': return this.cmdAgent(st, parsed.arg)
      case 'status': return this.cmdStatus(st)
      default: return { text: `未知命令 /${parsed.name}。可用命令见 /help。`, ok: true }
    }
  }

  private async cmdCd(st: ChatState, arg: string): Promise<TurnResult> {
    if (!arg) return { text: `当前工作目录：\`${st.cwd}\``, ok: true }
    const target = resolveWorkingDir(arg, st.cwd)
    const cwd = await resolveAllowedDirectory(target, this.cwdRoots())
    if (!cwd) return { text: '目录不存在、不可访问，或不在允许的工作目录范围内。', ok: false }
    if (cwd === st.cwd) return { text: `当前已在 \`${cwd}\``, ok: true }
    const old = st.cwd
    await this.resetContext(st)
    st.cwd = cwd
    this.log.info('cd', { chatId: st.chatId, from: old, to: cwd })
    return { text: `工作目录已切换：\`${old}\` -> \`${cwd}\`（已开启新会话）。`, ok: true }
  }

  private async cmdAgent(st: ChatState, arg: string): Promise<TurnResult> {
    const presets = this.ctx.get('agentPresets') as PresetsLike | undefined
    if (!presets) return { text: '当前环境未启用 agent presets。', ok: false }
    if (!arg) {
      let rows: PresetRow[]
      try { rows = await presets.list() } catch { return { text: '无法读取 Agent 列表。', ok: false } }
      let current: string | undefined
      try { current = (await this.resolvePreset(presets, st.presetId ?? this.config.defaultPreset)).id } catch { current = undefined }
      if (!rows.length) return { text: '当前没有可用的 Agent preset。', ok: false }
      return {
        text: ['可用 Agent：', ...rows.map((row) => `- ${current === row.id ? '【当前】 ' : ''}${row.name ?? row.id} (\`${row.id}\`)${row.broken ? ` [不可用: ${row.broken}]` : ''}`)].join('\n'),
        ok: true,
      }
    }
    let resolved: { id: string; name?: string }
    try { resolved = await this.resolvePreset(presets, arg) } catch { return { text: `未找到或不可用的 Agent：\`${arg}\`。请使用 /agent 查看可用 ID。`, ok: false } }
    let current: { id: string; name?: string } | undefined
    try { current = await this.resolvePreset(presets, st.presetId ?? this.config.defaultPreset) } catch { current = undefined }
    if (current?.id === resolved.id) return { text: `当前已是 Agent「${resolved.name ?? resolved.id}」。`, ok: true }
    await this.resetContext(st)
    st.presetId = resolved.id
    this.log.info('agent switch', { chatId: st.chatId, preset: resolved.id })
    return { text: `已切换到 Agent「${resolved.name ?? resolved.id}」（已开启新会话）。`, ok: true }
  }

  private async cmdStatus(st: ChatState): Promise<TurnResult> {
    const presets = this.ctx.get('agentPresets') as PresetsLike | undefined
    let preset: string | undefined
    try { preset = (await this.resolvePreset(presets, st.presetId ?? this.config.defaultPreset)).id } catch { preset = undefined }
    const selection = st.modelSelection
    return {
      text: [
        '会话状态',
        `会话：\`${st.handle ? String(st.handle.agent.session.id) : String(this.sessionIdOf(st))}\``,
        `工作目录：\`${st.cwd}\``,
        `Agent：${preset ? `\`${preset}\`` : '未绑定'}`,
        `模型：${selection ? `${selection.provider}/${selection.model}` : '尚未创建 live agent'}`,
      ].join('\n'),
      ok: true,
    }
  }

  private async evictIdle(preserve?: string): Promise<void> {
    const now = Date.now()
    const idleMs = this.config.idleChatMs ?? 30 * 60_000
    const max = this.config.maxLiveChats ?? 100
    const candidates = [...this.states.entries()]
      .filter(([key, state]) => key !== preserve && !this.queues.has(key) && !this.evictions.has(key) && (now - state.lastActiveAt >= idleMs || this.states.size > max))
      .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt)
    for (const [key, state] of candidates) {
      if (this.states.size <= max && now - state.lastActiveAt < idleMs) break
      await this.evictState(key, state)
    }
  }

  private evictState(key: string, state: ChatState): Promise<void> {
    const active = this.evictions.get(key)
    if (active) return active
    const eviction = Promise.resolve().then(async () => {
      try {
        if (state.handle) await state.handle.dispose()
        if (this.states.get(key) === state) this.states.delete(key)
      } catch (error) {
        // Keep failed state attached so a later sweep or shutdown can retry it.
        // eslint-disable-next-line no-console
        console.error(`[dsh-wecom] chat eviction failed (${safeErrorKind(error)})`)
      }
    })
    this.evictions.set(key, eviction)
    void eviction.then(() => {
      if (this.evictions.get(key) === eviction) this.evictions.delete(key)
    })
    return eviction
  }

  enqueue(message: InboundMessage): Promise<TurnResult> {
    if (!this.accepting) return Promise.reject(new Error('dsh-wecom: bridge is shutting down'))
    const key = chatKey(message.chatType || 'unknown', message.chatId)
    const previous = this.queues.get(key) ?? this.evictions.get(key) ?? Promise.resolve()
    const task = async (): Promise<TurnResult> => {
      await this.evictIdle(key)
      const command = await this.handleCommand(message)
      const result = command ?? await this.runTurn(message)
      if (result.text) await this.bot.replyText(message.frame, truncateUtf8(result.text))
      return result
    }
    const next = previous.then(task, task)
    let settled: Promise<void>
    const cleanup = async () => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
      const state = this.states.get(key)
      if (state) state.lastActiveAt = Date.now()
      await this.evictIdle(key)
    }
    settled = next.then(cleanup, cleanup)
    this.queues.set(key, settled)
    return next
  }

  resourceSnapshot(): { states: number; queues: number; liveAgents: number } {
    return {
      states: this.states.size,
      queues: this.queues.size,
      liveAgents: [...this.states.values()].filter((state) => state.handle).length,
    }
  }

  async dispose(): Promise<void> {
    this.accepting = false
    clearInterval(this.idleSweep)
    await Promise.allSettled([...this.queues.values()])
    await Promise.allSettled([...this.evictions.values()])
    const failures: unknown[] = []
    await Promise.all([...this.states.entries()].map(async ([key, state]) => {
      try {
        await state.handle?.dispose()
        if (this.states.get(key) === state) this.states.delete(key)
      } catch (error) {
        failures.push(error)
      }
    }))
    this.queues.clear()
    this.evictions.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'dsh-wecom bridge disposal failed')
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const normalized = normalizeConfig(config)
  const log = makeLogger(normalized.logLevel ?? 'info')
  log.info('apply boot', {
    configured: Boolean(normalized.botId && normalized.botSecret),
    allowChats: normalized.allowChats ?? [],
    allowGroupSenders: normalized.allowGroupSenders ?? [],
    outboundAllowChats: normalized.outboundAllowChats ?? [],
    defaultCwd: normalized.defaultCwd ?? process.cwd(),
    defaultPreset: normalized.defaultPreset,
    allowedCwdRoots: normalized.allowedCwdRoots ?? [],
    logLevel: normalized.logLevel,
  })
  const controller = new WecomLifecycleController(ctx, normalized, PLUGIN_VERSION)
  ctx.effect(() => registerWecomApi(ctx.webServer, controller, normalized.managementOrigin!), 'dsh-wecom.status-api')
  registerWecomTools(ctx, controller, normalized.outboundAllowChats)
  const initial = await controller.start()
  if (initial.state === 'unconfigured') log.warn('missing bot credentials; status remains available in the plugin UI')
  ctx.effect(() => async () => {
    log.info('shutdown')
    await controller.dispose()
  }, 'dsh-wecom.dispose')
}

export { WecomBot } from './bot.ts'
export type { InboundMessage, WecomLifecycleEvent } from './bot.ts'
export { WecomLifecycleController } from './lifecycle.ts'
export type { WecomStatus, WecomConnectionState } from './lifecycle.ts'
export { parseCommand, resolveWorkingDir, renderHelp, COMMANDS } from './commands.ts'
export { truncateUtf8, WECOM_MAX_MESSAGE_BYTES } from './safety.ts'
