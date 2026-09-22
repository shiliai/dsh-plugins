/**
 * The model-facing `team_delegate` tool: leader hands a self-contained task to
 * the team router; jev judges complexity and executor; simple tasks run on a
 * cheap worker subagent, everything else fails open back to the leader.
 * @module @dsh-plugins/dsh-agent-team/tool
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig, Worker } from './config.ts'
import { judge as judgeTask, type JevVerdict } from './jev-client.ts'
import { decide } from './router.ts'
import { appendStats } from './stats.ts'

/** Structural subset of ctx.subagents the tool needs — injectable for tests. */
export interface SubagentGateway {
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}

export interface TeamDelegateDeps {
  config: ResolvedConfig
  subagents: SubagentGateway
  /** Injectable judge (tests); defaults to the real jev HTTP client. */
  judge?: (options: { task: string; workers: Worker[]; signal?: AbortSignal }) => Promise<JevVerdict>
  /** Injectable clock (tests). */
  now?: () => number
  /** Stats warning sink (tests). */
  warn?: (message: string) => void
}

export type TeamDelegateResult =
  | { decision: 'leader'; reason: string; jev: { complexity: number; confidence: number } }
  | { decision: 'worker'; worker: string; reason: string; jev: { complexity: number; confidence: number }; result: string }
  | { decision: 'fallback-leader'; reason: string; error: string; jev: { complexity: number; confidence: number } }
  | { decision: 'leader'; reason: string; error: string }

const JSON_OUTPUT = { type: 'json' } as const

const WORKER_PROMPT_PREFIX = [
  '你是团队路由分配来的 worker 模型。你只执行下面这一个自包含任务:',
  '- 不要委派、不要再调用任何团队/子代理工具;',
  '- 不要假设任何对话上下文,任务描述里没给的信息就按合理默认处理并在结果里说明;',
  '- 完成后只输出任务结果本身。',
  '',
  '任务:',
].join('\n')

/** Render text blocks from a canonical JSON block array without trusting arbitrary values. */
function outputText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

/** A non-'completed' stop reason means the child did not finish cleanly. */
function stopReasonError(stopReason: string): string | undefined {
  switch (stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${stopReason})`
  }
}

function withDiagnosticAndPartialText(error: string, result: { diagnostic?: string; output: ContentBlock[] }): string {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = outputText(result.output)
  return `${error}${diagnostic}${text === '' ? '' : `\nPartial output before the run ended:\n${text}`}`
}

/**
 * Whether a start() rejection is the provider depthLimit capability check
 * (which runs before any child exists, so retrying without maxDepth is safe).
 */
function isDepthCapabilityError(error: unknown): boolean {
  return error instanceof Error && /capab|depth/i.test(error.message)
}

function jevSummary(verdict: JevVerdict): { complexity: number; confidence: number } {
  return { complexity: verdict.complexity, confidence: verdict.confidence }
}

function renderText(_args: unknown, value: unknown): ContentBlock[] {
  const result = value as TeamDelegateResult
  let line: string
  switch (result.decision) {
    case 'worker':
      line = `路由结果:任务已由 worker "${result.worker}" 完成,原因:${result.reason}`
      break
    case 'fallback-leader':
      line = `路由结果:worker 执行失败,由你(leader)直接完成该任务,原因:${result.reason};错误:${result.error}`
      break
    default:
      line = `路由结果:由你(leader)直接完成该任务,原因:${result.reason}`
      break
  }
  return [{ type: 'text', text: `${line}\n\n${JSON.stringify(value, null, 2)}` }]
}

export function createTeamDelegateTool(deps: TeamDelegateDeps): ToolDefinition {
  const { config } = deps
  const judge = deps.judge ?? ((options: { task: string; workers: Worker[]; signal?: AbortSignal }) => {
    if (config.apiKey === null) {
      return Promise.reject(new Error('dsh-agent-team: JEV_API_KEY is not set and no apiKey config was provided'))
    }
    return judgeTask({
      apiKey: config.apiKey,
      model: config.jevModel,
      timeoutMs: config.jevTimeoutMs,
      task: options.task,
      workers: options.workers,
      signal: options.signal,
    })
  })
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? console.warn

  return defineTool({
    name: 'team_delegate',
    description: [
      '把一个自包含任务交给团队路由器。路由器用 jev 判断任务复杂度:简单任务派给便宜的 worker 模型执行并返回结果;复杂或不确定的任务返回 `leader` 决策,此时你必须自己完成。',
      '适合:读/写/整理文档、摘要、翻译、格式化、批量机械修改。',
      '不适合:需要本对话上下文的任务、架构决策、高风险操作。',
      'Delegate a self-contained task to the team router. jev judges complexity: simple tasks run on a cheap worker model; complex or uncertain tasks return a `leader` decision and you must do them yourself.',
    ].join('\n'),
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: '自包含的任务描述。子代理看不到本对话,必须包含完成任务所需的全部上下文(文件路径、要求、输出格式)。A self-contained task description with all context the worker needs (file paths, requirements, output format).',
      },
      label: {
        type: 'string',
        description: '子代理显示名(可选)。Optional display label for the subagent.',
      },
    },
    output: { schema: JSON_OUTPUT, render: renderText },
    timeoutMs: config.timeoutMs,
    presentCall: (args) => ({
      card: 'generic',
      title: 'Delegate to team router',
      kind: 'other',
      input: typeof (args as { task?: unknown }).task === 'string' ? (args as { task: string }).task.slice(0, 120) : undefined,
    }),
    async execute(args, exec): Promise<TeamDelegateResult> {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('team_delegate requires a calling agent (exec.agent was undefined)')
      }
      const startedAt = now()
      const task = args.task
      const record = async (extra: Record<string, unknown>): Promise<void> => {
        await appendStats(config.statsFile, {
          ts: new Date().toISOString(),
          task: task.slice(0, 200),
          decision: 'decision' in extra ? extra.decision as 'leader' | 'worker' | 'fallback-leader' : 'leader',
          durationMs: now() - startedAt,
          ...extra,
        }, warn)
      }

      // ① jev judges; any failure fails open to the leader.
      let verdict: JevVerdict
      const jevStartedAt = now()
      try {
        verdict = await judge({ task, workers: config.workers, signal: exec.signal })
      } catch (error) {
        await record({ decision: 'leader', jevDurationMs: now() - jevStartedAt, error: String(error) })
        return { decision: 'leader', reason: 'jev 调用失败,fail-open', error: String(error) }
      }
      const jevDurationMs = now() - jevStartedAt

      // ② Pure router decision.
      const decision = decide(verdict, config.workers, {
        minConfidence: config.minConfidence,
        complexityThreshold: config.complexityThreshold,
      })
      if (decision.route === 'leader') {
        await record({ decision: 'leader', jevDurationMs, verdict: { complexity: verdict.complexity, executor: verdict.executor, confidence: verdict.confidence } })
        return { decision: 'leader', reason: decision.reason, jev: jevSummary(verdict) }
      }

      // ③ Route to the worker through a one-shot subagent; any failure falls back.
      const worker = decision.worker
      // reasoningEffort exists on the 0.1.2 runtime this plugin targets but not
      // in the rc.6 type generation the workspace installs; cast keeps the
      // option forwarding intact on newer hosts without breaking typecheck.
      const agentOptions = {
        provider: worker.provider,
        model: worker.model,
        ...(worker.reasoningEffort === undefined ? {} : { reasoningEffort: worker.reasoningEffort }),
      } as AgentOptions
      const request: SubagentStartRequest = {
        label: args.label ?? worker.name,
        prompt: [{ type: 'text', text: `${WORKER_PROMPT_PREFIX}${task}` }],
        parent,
        signal: exec.signal,
        agentOptions,
        maxDepth: config.maxDepth,
      }
      let run: SubagentRun
      try {
        exec.signal.throwIfAborted()
        run = await deps.subagents.start(config.subagentProvider, request)
      } catch (error) {
        if (isDepthCapabilityError(error) && request.maxDepth !== undefined) {
          // spawn without depthLimit capability: retry once without maxDepth
          // (the capability check runs before any child exists).
          const { maxDepth: _omitted, ...withoutDepth } = request
          try {
            run = await deps.subagents.start(config.subagentProvider, withoutDepth)
          } catch (retryError) {
            await record({ decision: 'fallback-leader', worker: worker.name, jevDurationMs, verdict: { complexity: verdict.complexity, executor: verdict.executor, confidence: verdict.confidence }, error: String(retryError) })
            return { decision: 'fallback-leader', reason: decision.reason, error: String(retryError), jev: jevSummary(verdict) }
          }
        } else {
          await record({ decision: 'fallback-leader', worker: worker.name, jevDurationMs, verdict: { complexity: verdict.complexity, executor: verdict.executor, confidence: verdict.confidence }, error: String(error) })
          return { decision: 'fallback-leader', reason: decision.reason, error: String(error), jev: jevSummary(verdict) }
        }
      }

      const [settled] = await Promise.allSettled([run.result.then((result) => {
        const error = stopReasonError(result.stopReason)
        if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result))
        return outputText(result.output)
      })])
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
      if (settled.status === 'rejected') {
        const error = disposal.status === 'rejected'
          ? `${String(settled.reason)}; dispose failed: ${String(disposal.reason)}`
          : String(settled.reason)
        await record({ decision: 'fallback-leader', worker: worker.name, jevDurationMs, verdict: { complexity: verdict.complexity, executor: verdict.executor, confidence: verdict.confidence }, error })
        return { decision: 'fallback-leader', reason: decision.reason, error, jev: jevSummary(verdict) }
      }
      if (disposal.status === 'rejected') {
        await record({ decision: 'fallback-leader', worker: worker.name, jevDurationMs, verdict: { complexity: verdict.complexity, executor: verdict.executor, confidence: verdict.confidence }, error: String(disposal.reason) })
        return { decision: 'fallback-leader', reason: decision.reason, error: String(disposal.reason), jev: jevSummary(verdict) }
      }
      await record({ decision: 'worker', worker: worker.name, jevDurationMs, verdict: { complexity: verdict.complexity, executor: verdict.executor, confidence: verdict.confidence } })
      return { decision: 'worker', worker: worker.name, reason: decision.reason, jev: jevSummary(verdict), result: settled.value }
    },
  })
}
