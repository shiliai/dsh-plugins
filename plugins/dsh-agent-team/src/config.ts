/**
 * dsh-agent-team configuration: raw cordis config surface plus normalization
 * with defaults and fail-loud validation of thresholds and worker entries.
 * @module @dsh-plugins/dsh-agent-team/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** One cheap worker model jev may route simple tasks to. */
export interface Worker {
  /** jev choice option key, e.g. 'local-deepseek'. Must be unique across workers. */
  name: string
  /** DSH settings provider id, e.g. 'ds-haitian'. */
  provider: string
  /** Model id interpreted by the provider, e.g. 'deepseek-v4-flash'. */
  model: string
  /** Capability description shown to jev (Chinese or English). */
  description: string
  /** Optional adapter-owned reasoning effort for the worker route. */
  reasoningEffort?: string
}

/** Raw cordis config: every field optional. */
export interface Config {
  /** TypeSafe API key. Defaults to process.env.JEV_API_KEY; null disables jev (fail-open). */
  apiKey?: string | null
  /** jev model id. Defaults to 'jev-latest'. */
  jevModel?: string
  /** Candidate workers. Defaults to one local DeepSeek flash worker. */
  workers?: Worker[]
  /** Minimum executor confidence to accept a worker route. Defaults to 0.6. */
  minConfidence?: number
  /** complexity score at or above which the task stays with the leader. Defaults to 2. */
  complexityThreshold?: number
  /** Subagent provider name. Defaults to 'spawn'. */
  subagentProvider?: string
  /** Delegation depth cap passed to subagents.start. Defaults to 0. */
  maxDepth?: number
  /** jev HTTP timeout in milliseconds. Defaults to 10000. */
  jevTimeoutMs?: number
  /** Whole-tool cooperative timeout budget in milliseconds. Defaults to 10 minutes. */
  timeoutMs?: number
  /** Routing stats JSONL path ('~' expanded). Defaults to ~/.dsh/agent-team/routing-stats.jsonl; null disables. */
  statsFile?: string | null
}

/** Fully-resolved config the tool executes against. */
export interface ResolvedConfig {
  apiKey: string | null
  jevModel: string
  workers: Worker[]
  minConfidence: number
  complexityThreshold: number
  subagentProvider: string
  maxDepth: number
  jevTimeoutMs: number
  timeoutMs: number
  statsFile: string | null
}

export const DEFAULT_WORKER: Worker = {
  name: 'local-deepseek',
  provider: 'ds-haitian',
  // 0731 变体在 settings 里声明了 reasoningEfforts(off/high/max);不带声明的
  // deepseek-v4-flash 会被 pi-ai 以 UNSUPPORTED_REASONING_EFFORT 拒绝(子代理会
  // 继承 leader 的 effort)。显式固定 high,使 worker 路由与 leader 的 effort 解耦。
  model: 'deepseek-v4-flash-0731',
  reasoningEffort: 'high',
  description: '私有化部署的 DeepSeek,免费;适合读/写/整理文档、摘要、格式化、批量机械修改等自包含简单任务',
}

export const DEFAULT_STATS_FILE = join('~', '.dsh', 'agent-team', 'routing-stats.jsonl')

/** Expand a leading '~' (or '~user' spelled as '~') against the home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function assertWorker(worker: Worker, index: number): void {
  const where = `workers[${index}]`
  for (const field of ['name', 'provider', 'model', 'description'] as const) {
    const value = worker[field]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`dsh-agent-team: ${where}.${field} must be a non-empty string`)
    }
  }
  if (worker.reasoningEffort !== undefined && (typeof worker.reasoningEffort !== 'string' || worker.reasoningEffort.trim() === '')) {
    throw new Error(`dsh-agent-team: ${where}.reasoningEffort must be a non-empty string when set`)
  }
}

/**
 * Resolve defaults and reject malformed values at the config boundary so a bad
 * edit fails the mount instead of silently mis-routing every delegation.
 */
export function normalizeConfig(raw: Config = {}): ResolvedConfig {
  const workers = raw.workers ?? [DEFAULT_WORKER]
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new Error('dsh-agent-team: workers must be a non-empty array')
  }
  const seen = new Set<string>()
  workers.forEach((worker, index) => {
    assertWorker(worker, index)
    if (seen.has(worker.name)) {
      throw new Error(`dsh-agent-team: duplicate worker name "${worker.name}"`)
    }
    seen.add(worker.name)
  })

  const minConfidence = raw.minConfidence ?? 0.6
  if (typeof minConfidence !== 'number' || Number.isNaN(minConfidence) || minConfidence <= 0 || minConfidence > 1) {
    throw new Error('dsh-agent-team: minConfidence must be a number in (0, 1]')
  }

  const complexityThreshold = raw.complexityThreshold ?? 2
  if (typeof complexityThreshold !== 'number' || Number.isNaN(complexityThreshold) || complexityThreshold < 0 || complexityThreshold > 4) {
    throw new Error('dsh-agent-team: complexityThreshold must be a number in [0, 4]')
  }

  const jevTimeoutMs = raw.jevTimeoutMs ?? 10000
  if (typeof jevTimeoutMs !== 'number' || !Number.isInteger(jevTimeoutMs) || jevTimeoutMs <= 0) {
    throw new Error('dsh-agent-team: jevTimeoutMs must be a positive integer')
  }

  const timeoutMs = raw.timeoutMs ?? 10 * 60 * 1000
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('dsh-agent-team: timeoutMs must be a positive integer')
  }

  const maxDepth = raw.maxDepth ?? 0
  if (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error('dsh-agent-team: maxDepth must be a non-negative integer')
  }

  const apiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim() !== '' ? raw.apiKey : (process.env.JEV_API_KEY ?? null)

  const statsFile = raw.statsFile === undefined ? expandHome(DEFAULT_STATS_FILE) : (raw.statsFile === null ? null : expandHome(raw.statsFile))

  return {
    apiKey,
    jevModel: raw.jevModel ?? 'jev-latest',
    workers: workers.map(worker => ({ ...worker })),
    minConfidence,
    complexityThreshold,
    subagentProvider: raw.subagentProvider ?? 'spawn',
    maxDepth,
    jevTimeoutMs,
    timeoutMs,
    statsFile,
  }
}
