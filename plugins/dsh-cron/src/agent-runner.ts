/**
 * One-shot agent task execution: create a disposable agent through
 * `ctx.agents.create`, submit the framed prompt, wait for silence, take the
 * last assistant message as the run summary, then dispose. The run session is
 * a real persisted DSH session (`session-<uuid>`), so the Web UI can open its
 * native replay later.
 * @module @dsh-plugins/dsh-cron/agent-runner
 */

import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CronJob } from './types.ts'

export interface AgentRunOutcome {
  ok: boolean
  summary: string
  sessionId: string
  error?: string
  /** 'timeout' when the deadline fired; the agent was cancelled. */
  timedOut?: boolean
  /** 'aborted' when the user stopped the run; the agent was cancelled. */
  aborted?: boolean
}

interface PresetsLike {
  defaultId: string
  resolve(id?: string): Promise<{ id: string; name?: string; broken?: string }>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

interface ModelSelectionLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

interface WorkspaceRegistryLike {
  resolveByPath?(path: string): Promise<{ attachSession(id: unknown): Promise<void> } | undefined>
  create?(path: string, title?: string): Promise<{ attachSession(id: unknown): Promise<void> }>
}

interface SessionEventLike {
  seq?: number
  type?: string
  data?: {
    message?: { content?: Array<{ type?: string; text?: string }> }
    reason?: { kind?: string }
  }
}

interface ScopedSystemPrompt {
  section(section: { name: string; order: number; text: string }): unknown
}

export function cronRunFraming(job: CronJob, targetMs: number): string {
  const targetIso = new Date(targetMs).toISOString()
  return [
    '[CRON RUN] 这是一次无人值守的 dsh-cron 定时任务运行。',
    `任务: ${job.name};计划触发时刻: ${targetIso}。`,
    '禁止向用户提问或等待确认;无法完成时直接说明原因并结束。',
    '完成后给出简短的结论摘要(发生了什么、关键数字、是否需要跟进)。',
    '时间相关判断一律以上下文中给出的绝对时间为准,不要自行推算当前时间。',
  ].join('\n')
}

function sessionEventsOf(agent: Agent): readonly SessionEventLike[] {
  const session = agent.session as unknown as {
    events?: unknown
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly unknown[] | undefined
    ownEvents?: () => readonly unknown[] | undefined
  }
  if (Array.isArray(session?.events)) return session.events as SessionEventLike[]
  if (typeof session?.snapshotEvents === 'function') {
    const snapshot = session.snapshotEvents()
    if (Array.isArray(snapshot)) return snapshot as SessionEventLike[]
  }
  if (typeof session?.ownEvents === 'function') {
    const own = session.ownEvents()
    if (Array.isArray(own)) return own as SessionEventLike[]
  }
  return []
}

/** Last assistant text after `firstSeq`, mirroring dsh-wecom's turn fold. */
export function lastAssistantText(events: readonly SessionEventLike[], firstSeq: number): { text: string; completed: boolean } {
  let started = false
  let text = ''
  let completed = false
  for (const event of events) {
    if (event.seq === undefined || event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = (event.data?.message?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') completed = (event.data?.reason?.kind ?? '') === 'completed'
  }
  return { text, completed }
}

export function summarizeAssistant(text: string): string {
  const compact = text.trim()
  return compact.length > 2000 ? `${compact.slice(0, 2000)}…` : compact
}

/**
 * Cwd for a run that doesn't pin one: the dedicated cron runs directory
 * (`configDefaultCwd`, else `<DSH_HOME>/cron-runs`). Never `process.cwd()` —
 * under launchd that is `/`, which used to drop every cron session into an
 * untitled `/` workspace no one could find. Created on demand so both the
 * session assembly and the workspace registry's realpath succeed.
 */
export async function resolveRunCwd(configDefaultCwd: string | undefined): Promise<string> {
  const cwd = configDefaultCwd && path.isAbsolute(configDefaultCwd)
    ? configDefaultCwd
    : path.join(process.env.DSH_HOME || process.cwd(), 'cron-runs')
  await mkdir(cwd, { recursive: true }).catch(() => undefined)
  return cwd
}

export async function runAgentTask(ctx: Context, job: CronJob, prompt: string, targetMs: number, timeoutMs: number, signal: AbortSignal, configDefaultCwd?: string): Promise<AgentRunOutcome> {
  const agents = ctx.agents
  const presets = ctx.get('agentPresets') as PresetsLike | undefined
  const defaultModel = ctx.get('agentDefaultModel') as ModelSelectionLike | undefined
  if (!presets) throw new Error('agentPresets 服务不可用,无法解析运行身份')

  const requestedPreset = job.agentPreset || presets.defaultId
  if (!requestedPreset) throw new Error('agentPresets 无 defaultId,且任务未指定 Agent 预设')
  const resolved = await presets.resolve(requestedPreset)
  if (resolved.broken) throw new Error(`Agent 预设 "${resolved.id}" 不可用: ${resolved.broken}`)

  const selection = job.model ?? defaultModel?.currentSelection()
  if (!selection) throw new Error('无法解析模型:任务未钉死模型且 agentDefaultModel 不可用')

  const sessionId = `session-${randomUUID()}`
  // The persona prompt references the {{cwd}} prompt variable; a session
  // without meta.cwd fails its first assembly, so always resolve one.
  const cwd = job.cwd ?? await resolveRunCwd(configDefaultCwd)
  const framing = cronRunFraming(job, targetMs)

  const setup = async (agentCtx: Context): Promise<void> => {
    installModelSelection(agentCtx, {
      current: {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort as ReasoningEffortId } : {}),
      },
      assembled: undefined,
    })
    await presets.mount(agentCtx, resolved.id)
    // Scoped [CRON RUN] framing; when the host lacks the system-prompt
    // service the framing degrades to a message prefix below.
    const systemPrompt = (agentCtx as unknown as { systemPrompt?: ScopedSystemPrompt }).systemPrompt
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      systemPrompt.section({ name: 'dsh-cron:run-framing', order: 120, text: framing })
    }
  }

  const handle = await agents.create({
    sessionId: SessionId(sessionId),
    meta: { cwd, agentPreset: resolved.id },
    agentOptions: {
      ...(selection.provider ? { provider: selection.provider } : {}),
      ...(selection.model ? { model: selection.model } : {}),
    },
    setup,
  })

  try {
    if (job.permissionPreset) {
      const permissions = ctx.get('permissionPresets') as { set(session: unknown, name: string): void } | undefined
      if (permissions) permissions.set(handle.agent.session, job.permissionPreset)
    }
    void attachToWorkspace(ctx, sessionId, cwd)
    if (signal.aborted) throw new Error('运行已被停止')

    const scoped = ((handle.agent.ctx as unknown as { systemPrompt?: ScopedSystemPrompt }).systemPrompt) !== undefined
    const messageText = scoped ? prompt : `${framing}\n\n---\n\n${prompt}`

    const firstSeq = handle.agent.session.seq
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: messageText }], source: { kind: 'user' } }))

    const outcome = await new Promise<'idle' | 'timeout' | 'aborted'>((resolveWait, rejectWait) => {
      const finish = (value: 'idle' | 'timeout' | 'aborted'): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolveWait(value)
      }
      const onAbort = (): void => finish('aborted')
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      timer.unref?.()
      signal.addEventListener('abort', onAbort, { once: true })
      handle.agent.whenIdle().then(() => finish('idle'), (error: unknown) => rejectWait(error instanceof Error ? error : new Error(String(error))))
    })

    if (outcome === 'timeout' || outcome === 'aborted') {
      try {
        handle.agent.cancel((outcome === 'timeout' ? 'cron 任务超时' : 'cron 运行被停止') as never)
      } catch {
        // Cancel is best-effort; disposal below owns teardown.
      }
    }
    const sessions = ctx.sessions
    if (sessions && typeof (sessions as { flush?: unknown }).flush === 'function') {
      await sessions.flush(handle.agent.session).catch(() => undefined)
    }
    const { text, completed } = lastAssistantText(sessionEventsOf(handle.agent), firstSeq)
    const summary = summarizeAssistant(text)

    if (outcome === 'timeout') {
      return { ok: false, summary, sessionId, error: `任务超时(${Math.round(timeoutMs / 1000)}s),已取消`, timedOut: true }
    }
    if (outcome === 'aborted') {
      return { ok: false, summary, sessionId, error: '运行被用户停止', aborted: true }
    }
    if (!completed) {
      return { ok: false, summary, sessionId, error: 'agent 回合未正常结束(turn/end != completed)' }
    }
    if (!summary) {
      return { ok: false, summary: '', sessionId, error: 'agent 未产出任何 assistant 文本' }
    }
    return { ok: true, summary, sessionId }
  } finally {
    await handle.dispose().catch(() => undefined)
  }
}

/** Surface the finished cron session in the web UI's workspace group (best effort). */
async function attachToWorkspace(ctx: Context, sessionId: string, cwd: string | undefined): Promise<void> {
  if (!/^session-[0-9a-f-]+$/i.test(sessionId)) return
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (!registry?.resolveByPath || !registry.create) return
  const target = cwd ?? process.cwd()
  try {
    let workspace = await registry.resolveByPath(target)
    if (!workspace) workspace = await registry.create(target)
    await workspace.attachSession(SessionId(sessionId))
  } catch {
    // Cosmetic only: the run stays openable through its stored session id.
  }
}
