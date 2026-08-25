import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
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
  /**
   * The workspace directory where `/new` starts a fresh session and where chat
   * sessions are organized by directory. Defaults to `~/project/wecom-workspace`.
   * `~` is expanded against the home directory.
   */
  defaultWorkspace?: string
  defaultPreset?: string
  maxLiveChats?: number
  idleChatMs?: number
  /** Diagnostic verbosity: error | warn | info (default) | debug. */
  logLevel?: LogLevel
  /** Trusted DSH browser origin for plugin restart requests. Defaults to local DSH. */
  managementOrigin?: string
  /**
   * Opt into resuming this plugin's own persisted `wecom:` sessions across
   * process restarts and generations. When enabled, the process-local epoch is
   * dropped from the session id (making it stable and reproducible) and
   * `ensureAgent` resumes the latest persisted generation for the chat instead
   * of always creating a fresh session. Requires the `sessionPersistence`
   * service to be present in the host (the web profile ships
   * `dsh-session-persistence-jsonl`). Falls back to a fresh session when
   * persistence or a matching session is unavailable. Defaults to false.
   */
  resumeSessions?: boolean
  /**
   * Bind specific chats (chat key `"type:chatId"`, e.g. `single:userid-a` or
   * `group:group-chat-id`) to an existing persisted web session id. When bound,
   * the chat's turns resume that session instead of a `wecom:` session, so the
   * DSH browser and the WeCom bot share one conversation log. The target must be
   * persisted (flushed in the browser) and idle; a session currently live in the
   * browser is refused until it settles. `/attach` and `/detach` override or
   * clear a per-chat binding at runtime.
   */
  bindSession?: Record<string, string>
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

/** Structural subset of the `sessionPersistence` service used for resume/binding. */
interface SessionPersistenceLike {
  listSnapshots?(signal?: AbortSignal): Promise<Array<{ header: { id: string; cwd?: string; createdAt?: number; agentPreset?: string } }>>
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
  /** True once generation has been aligned to persistence (or confirmed absent) this state. */
  aligned: boolean
  /** Web session id this chat is bound to (resumed instead of a `wecom:` session). */
  boundSessionId: string | undefined
  /** True when boundSessionId is a freshly minted session (create on first use, not resume). */
  boundFresh: boolean
  /** Resolved action-workspace directory (`/new` starts a fresh session here). */
  workspace: string
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
 * plus an in-process epoch. By default we never resume persisted sessions: the
 * documented memory contract is process-local and `/new` must never revive gen 0.
 * When `config.resumeSessions` is enabled, the epoch is dropped so ids are stable
 * across restarts, and the latest persisted generation is resumed instead of a
 * fresh session (see {@link ensureAgent}). `/new`/`/cd`/`/agent` still bump the
 * generation so a reset never revives an older generation. A chat may also be
 * bound to an existing web session via `bindSession` or `/attach` to share one
 * conversation log with the DSH browser.
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
        cwd: this.config.defaultWorkspace ? this.workspaceDir() : (this.config.defaultCwd ?? process.cwd()),
        presetId: undefined,
        handle: undefined,
        modelSelection: undefined,
        lastActiveAt: Date.now(),
        aligned: false,
        boundSessionId: this.config.bindSession?.[chatKey(type, message.chatId)] ?? undefined,
        boundFresh: false,
        workspace: this.workspaceDir(),
      }
      this.states.set(key, state)
    }
    state.lastActiveAt = Date.now()
    return state
  }

  private sessionIdOf(st: ChatState) {
    const base = `wecom:${encodeURIComponent(this.bot.identity)}:${encodeURIComponent(st.chatType)}:${encodeURIComponent(st.chatId)}`
    return SessionId(this.config.resumeSessions ? `${base}:${st.generation}` : `${base}:${this.epoch}:${st.generation}`)
  }

  private sessionIdPrefix(st: ChatState): string {
    return `wecom:${encodeURIComponent(this.bot.identity)}:${encodeURIComponent(st.chatType)}:${encodeURIComponent(st.chatId)}`
  }

  /**
   * Find the highest persisted generation for this chat when resumeSessions is
   * enabled. Only sessions materialized by this plugin (the `wecom:` namespace)
   * are considered, so unrelated persisted sessions are never touched. Returns
   * `undefined` when persistence is unavailable or no matching session exists.
   */
  private async latestPersistedGeneration(st: ChatState): Promise<number | undefined> {
    if (!this.config.resumeSessions) return undefined
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (!persistence?.listSnapshots) return undefined
    const prefix = this.sessionIdPrefix(st)
    let latest: number | undefined
    try {
      const snapshots = await persistence.listSnapshots()
      for (const snap of snapshots) {
        const id = String(snap.header.id)
        if (!id.startsWith(prefix + ':')) continue
        const generation = Number(id.slice(prefix.length + 1))
        if (Number.isInteger(generation) && generation >= 0 && (latest === undefined || generation > latest)) {
          latest = generation
        }
      }
    } catch (error) {
      this.log.warn('resume: sessionPersistence.listSnapshots failed', { chatId: st.chatId, chatType: st.chatType, error: safeErrorKind(error) })
      return undefined
    }
    return latest
  }

  private cwdRoots(): string[] {
    const roots = this.config.allowedCwdRoots ?? [this.config.defaultCwd ?? process.cwd()]
    const workspace = this.config.defaultWorkspace ? this.workspaceDir() : undefined
    return workspace && !roots.includes(workspace) ? [...roots, workspace] : roots
  }

  /** Resolve the action workspace directory, expanding `~`; defaults to `~/project/wecom-workspace` when configured. */
  private workspaceDir(): string {
    const raw = this.config.defaultWorkspace ?? '~/project/wecom-workspace'
    return raw.startsWith('~/')
      ? `${homedir()}${raw.slice(1)}`
      : raw === '~' ? homedir() : raw
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
    // /new detaches any web-session binding so the fresh conversation is the
    // chat's own wecom session, never a re-attach to the previous web session.
    if (st.boundSessionId) {
      this.log.info('new generation: detached bound session', { chatId: st.chatId, chatType: st.chatType, boundSession: st.boundSessionId })
      st.boundSessionId = undefined
      st.aligned = false
    }
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
    const agentOptions = { provider: selection.provider, model: selection.model }

    // Option A: a chat bound to a web session drives that shared conversation.
    // The one-live-agent-per-session constraint means a target that is live in
    // the browser is refused. A freshly minted bound session (from /new) is
    // created on first use; a bound existing session is resumed.
    if (st.boundSessionId) {
      const targetId = SessionId(st.boundSessionId)
      if (agents.get?.(targetId)) {
        throw new Error('dsh-wecom: bound session is currently live in the browser; settle it before attaching this chat')
      }
      let created: DshAgentHandle
      if (st.boundFresh) {
        this.log.info('agent create (fresh bound session)', {
          chatId: st.chatId,
          chatType: st.chatType,
          boundSession: st.boundSessionId,
          cwd: st.cwd,
          preset: resolvedPreset.id,
          model: `${selection.provider}/${selection.model}`,
        })
        created = await agents.create({
          sessionId: targetId,
          meta,
          agentOptions,
          setup,
        })
        st.boundFresh = false
      } else {
        this.log.info('agent resume', {
          chatId: st.chatId,
          chatType: st.chatType,
          boundSession: st.boundSessionId,
          cwd: st.cwd,
          preset: resolvedPreset.id,
          model: `${selection.provider}/${selection.model}`,
        })
        created = await agents.resume({
          resumeSessionId: targetId,
          agentOptions,
          setup,
        })
      }
      st.modelSelection = { ...selection }
      st.handle = { agent: created.agent, dispose: () => created.dispose() }
      return st.handle
    }

    let created: DshAgentHandle
    // On the first acquisition of a live handle for this state, align generation
    // to the latest persisted `wecom:` session (if any) and resume it. This lets
    // conversations survive process restarts. Alignment happens exactly once per
    // state: /new, /cd, and /agent bump generation after this, so a reset never
    // revives an older persisted generation.
    if (this.config.resumeSessions && !st.aligned) {
      st.aligned = true
      const latest = await this.latestPersistedGeneration(st)
      if (latest !== undefined) {
        if (latest !== st.generation) {
          this.log.info('resume: align generation', { chatId: st.chatId, chatType: st.chatType, from: st.generation, to: latest })
          st.generation = latest
        }
        this.log.info('agent resume', {
          chatId: st.chatId,
          chatType: st.chatType,
          generation: st.generation,
          cwd: st.cwd,
          preset: resolvedPreset.id,
          model: `${selection.provider}/${selection.model}`,
        })
        created = await agents.resume({
          resumeSessionId: this.sessionIdOf(st),
          agentOptions,
          setup,
        })
      } else {
        this.log.info('agent create', {
          chatId: st.chatId,
          chatType: st.chatType,
          generation: st.generation,
          cwd: st.cwd,
          preset: resolvedPreset.id,
          model: `${selection.provider}/${selection.model}`,
        })
        created = await agents.create({
          sessionId: this.sessionIdOf(st),
          meta,
          agentOptions,
          setup,
        })
      }
    } else {
      this.log.info('agent create', {
        chatId: st.chatId,
        chatType: st.chatType,
        generation: st.generation,
        cwd: st.cwd,
        preset: resolvedPreset.id,
        model: `${selection.provider}/${selection.model}`,
      })
      created = await agents.create({
        sessionId: this.sessionIdOf(st),
        meta,
        agentOptions,
        setup,
      })
    }
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
        return this.cmdNew(st)
      case 'cd': return this.cmdCd(st, parsed.arg)
      case 'pwd': return { text: `当前工作目录：\`${st.cwd}\``, ok: true }
      case 'agent': return this.cmdAgent(st, parsed.arg)
      case 'status': return this.cmdStatus(st)
      case 'sessions': return this.cmdSessions(st, parsed.arg)
      case 'attach': return this.cmdAttach(st, parsed.arg)
      case 'detach': return this.cmdDetach(st)
      default: return { text: `未知命令 /${parsed.name}。可用命令见 /help。`, ok: true }
    }
  }

  /** `/new` — start a fresh conversation rooted at the action workspace when configured. */
  private async cmdNew(st: ChatState): Promise<TurnResult> {
    const workspace = this.config.defaultWorkspace ? st.workspace : undefined
    const resolved = workspace ? await resolveAllowedDirectory(workspace, this.cwdRoots()) : undefined
    const target = resolved ?? st.cwd
    // Dispose any held agent and reset state, then bind a freshly minted
    // browser-visible session id (session-<uuid>) so the next message creates a
    // new session the DSH web app lists and the browser can see.
    await this.resetContext(st)
    if (target !== st.cwd) st.cwd = target
    const freshId = `session-${randomUUID()}`
    st.boundSessionId = freshId
    st.boundFresh = true
    st.aligned = true
    this.log.info('new', { chatId: st.chatId, chatType: st.chatType, cwd: target, workspace: workspace, freshSession: freshId })
    const note = workspace && workspace !== target ? `工作区 \`${workspace}\` 不可用，已回退到 \`${target}\`。` : ''
    return { text: `${note}已开启新会话 \`${freshId}\`，下一条消息将在此目录创建（DSH web 中将显示）。`, ok: true }
  }

  /** `/sessions [session-id]` — list persisted sessions in the current directory, or bind to one. */
  private async cmdSessions(st: ChatState, arg: string): Promise<TurnResult> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (!persistence?.listSnapshots) {
      return { text: '当前环境未启用会话持久化，无法列出/绑定会话。', ok: false }
    }
    let snapshots: Array<{ header: { id: string; cwd?: string; createdAt?: number; agentPreset?: string } }>
    try {
      snapshots = await persistence.listSnapshots()
    } catch (error) {
      this.log.warn('sessions: list failed', { chatId: st.chatId, error: safeErrorKind(error) })
      return { text: '无法读取会话列表。', ok: false }
    }
    // Bind form: /sessions <id>
    if (arg) {
      const target = arg.trim()
      const matches = snapshots.filter((s) => String(s.header.id) === target)
      if (matches.length === 0) {
        return { text: `未找到持久化会话 \`${target}\`（可先无参运行 /sessions 查看当前目录下的会话）。`, ok: false }
      }
      if (st.handle) {
        await st.handle.dispose()
        st.handle = undefined
        st.modelSelection = undefined
      }
      st.boundSessionId = target
      st.boundFresh = false
      this.log.info('sessions bind', { chatId: st.chatId, chatType: st.chatType, to: target })
      return { text: `已绑定会话 \`${target}\`。下一条消息将写入该会话（与 DSH web 共享）。`, ok: true }
    }
    // List form: show sessions whose persisted cwd is under the current directory.
    const current = st.cwd.replace(/\/+$/, '')
    const rows = snapshots
      .filter((s) => {
        const cwd = s.header.cwd?.replace(/\/+$/, '')
        return cwd !== undefined && (cwd === current || cwd.startsWith(current + '/'))
      })
      .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
    if (rows.length === 0) {
      return { text: `当前目录 \`${st.cwd}\` 下没有发现持久化会话。\n提示：机器人会话默认独立；绑定请先 /attach <id> 或 /sessions <id>。`, ok: true }
    }
    const shown = rows.slice(0, 50).map((s) => {
      const id = String(s.header.id)
      const preset = s.header.agentPreset ? ` [${s.header.agentPreset}]` : ''
      const mark = st.boundSessionId === id ? ' 【当前绑定】' : ''
      const when = s.header.createdAt ? new Date(s.header.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : ''
      return `- \`${id}\`${preset}${mark} ${when}`
    })
    const more = rows.length > 50 ? `\n…共 ${rows.length} 条，仅显示前 50 条。` : ''
    return { text: [`当前目录 \`${st.cwd}\` 下的会话（${rows.length}）：`, ...shown, more, '', '绑定：/sessions <会话ID>'].join('\n'), ok: true }
  }

  private async cmdAttach(st: ChatState, arg: string): Promise<TurnResult> {    if (!arg) {
      return {
        text: st.boundSessionId
          ? `当前绑定会话：\`${st.boundSessionId}\`\n使用 /detach 解除绑定。`
          : '当前未绑定。使用 `/attach <会话ID>` 绑定到某个既有的 DSH web 会话，以共享同一段对话。',
        ok: true,
      }
    }
    const target = arg.trim()
    const previous = st.boundSessionId
    if (st.handle) {
      await st.handle.dispose()
      st.handle = undefined
      st.modelSelection = undefined
    }
    st.boundSessionId = target
    st.boundFresh = false
    this.log.info('attach', { chatId: st.chatId, chatType: st.chatType, from: previous, to: target })
    return { text: `已绑定会话 \`${target}\`。下一条消息将写入该会话（与 DSH web 共享）。`, ok: true }
  }

  private async cmdDetach(st: ChatState): Promise<TurnResult> {
    if (!st.boundSessionId) return { text: '当前未绑定任何 web 会话。', ok: true }
    const detached = st.boundSessionId
    await this.resetContext(st)
    this.log.info('detach', { chatId: st.chatId, chatType: st.chatType, session: detached })
    return { text: `已解除绑定 \`${detached}\`（已开启本聊天的独立新会话）。`, ok: true }
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
        `会话：\`${st.handle ? String(st.handle.agent.session.id) : st.boundSessionId ? String(st.boundSessionId) : String(this.sessionIdOf(st))}\``,
        `绑定：${st.boundSessionId ? `\`${st.boundSessionId}\`（与 DSH web 共享）` : '无'}`,
        `工作目录：\`${st.cwd}\``,
        `工作区：\`${st.workspace}\``,
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
    resumeSessions: normalized.resumeSessions === true,
    bindSession: normalized.bindSession ?? {},
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
