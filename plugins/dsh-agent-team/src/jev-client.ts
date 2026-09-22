/**
 * Bare-fetch TypeSafe (jev) System One client. One POST carries both the
 * complexity score question and the executor choice question so jev judges
 * them in parallel and mutually blind. 429/529 retry once after 500ms; every
 * other failure throws and the caller fails open to the leader.
 * @module @dsh-plugins/dsh-agent-team/jev-client
 *
 * API reference: https://docs.typesafe.ai/api.md
 */

import type { Worker } from './config.ts'

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const RETRY_DELAY_MS = 500
const RETRYABLE_STATUSES = new Set([429, 529])

/** Normalized verdict the router decides on. */
export interface JevVerdict {
  /** Probability-weighted complexity score, 0-4 (can land between levels). */
  complexity: number
  /** Winning executor option key: a worker name or 'leader'. */
  executor: string
  /** Confidence of the executor choice, 0-1. */
  confidence: number
  usage: { input_tokens: number; output_tokens: number }
  /** Raw answers map, kept for stats and debugging. */
  raw: unknown
}

export interface JudgeOptions {
  apiKey: string
  model: string
  timeoutMs: number
  task: string
  workers: Worker[]
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Caller cancellation (the tool's exec.signal). */
  signal?: AbortSignal | undefined
}

const COMPLEXITY_CRITERIA = [
  '纯读取/原样改写/格式化,无需判断',
  '简单摘要或单文件小改',
  '需要理解上下文的中等任务',
  '多文件/多步骤推理',
  '架构决策/高风险操作',
]

const LEADER_DESCRIPTION = '当前会话的主力模型,能力最强但成本高;需要对话上下文、架构判断或高风险操作的任务必须留给它'

interface ScoreAnswer {
  score?: unknown
  confidence?: unknown
}

interface ChoiceAnswer {
  choice?: unknown
  confidence?: unknown
}

function buildQuestions(workers: Worker[]): Record<string, unknown> {
  const executorCriteria: Record<string, string> = { leader: LEADER_DESCRIPTION }
  for (const worker of workers) executorCriteria[worker.name] = worker.description
  return {
    complexity: {
      type: 'score',
      instructions: '评估 `state.task` 完成所需的判断深度,按 criteria 的 0-4 级打分',
      criteria: COMPLEXITY_CRITERIA,
    },
    executor: {
      type: 'choice',
      instructions: ' `state.task` 这个自包含任务应该交给哪个执行者完成?只考虑 state.workers 与 leader',
      criteria: executorCriteria,
    },
  }
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`dsh-agent-team: jev response ${what} is missing or not a number`)
  }
  return value
}

function parseVerdict(body: unknown): JevVerdict {
  if (typeof body !== 'object' || body === null) {
    throw new Error('dsh-agent-team: jev response body is not an object')
  }
  const answers = (body as { answers?: unknown }).answers
  if (typeof answers !== 'object' || answers === null) {
    throw new Error('dsh-agent-team: jev response is missing answers')
  }
  const complexityAnswer = (answers as Record<string, unknown>).complexity as ScoreAnswer | undefined
  const executorAnswer = (answers as Record<string, unknown>).executor as ChoiceAnswer | undefined
  if (typeof complexityAnswer !== 'object' || complexityAnswer === null ||
      typeof executorAnswer !== 'object' || executorAnswer === null) {
    throw new Error('dsh-agent-team: jev response answers must include complexity and executor')
  }
  const usage = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage
  return {
    complexity: asNumber(complexityAnswer.score, 'complexity.score'),
    executor: typeof executorAnswer.choice === 'string' && executorAnswer.choice !== ''
      ? executorAnswer.choice
      : (() => { throw new Error('dsh-agent-team: jev response executor.choice is missing or not a string') })(),
    confidence: asNumber(executorAnswer.confidence, 'executor.confidence'),
    usage: {
      input_tokens: asNumber(usage?.input_tokens, 'usage.input_tokens'),
      output_tokens: asNumber(usage?.output_tokens, 'usage.output_tokens'),
    },
    raw: answers,
  }
}

async function postOnce(options: JudgeOptions, fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('dsh-agent-team: jev request timed out')), options.timeoutMs)
  const onCallerAbort = (): void => controller.abort(options.signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  try {
    return await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: {
          task: options.task,
          workers: options.workers.map(worker => ({ name: worker.name, description: worker.description })),
          leader: '当前会话模型(强但贵)',
        },
        model: options.model,
        questions: buildQuestions(options.workers),
      }),
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * Ask jev to judge one task: complexity score + executor choice in a single
 * request. Throws on any transport, status, timeout, or shape failure — the
 * tool's caller maps that to a fail-open leader decision.
 */
export async function judge(options: JudgeOptions): Promise<JevVerdict> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const signal = options.signal
  for (let attempt = 0; ; attempt += 1) {
    const response = await postOnce(options, fetchImpl, signal)
    if (RETRYABLE_STATUSES.has(response.status) && attempt === 0) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      continue
    }
    if (!response.ok) {
      throw new Error(`dsh-agent-team: jev request failed with status ${response.status}`)
    }
    return parseVerdict(await response.json())
  }
}
