/**
 * Core data model of dsh-cron. A job is trigger + task + policy + optional
 * delivery; every fire produces one durable run record keyed `<jobId>#<seq>`.
 *
 * Persisted records are plain JSON (storage-domain tables validate them with
 * zod at the durable boundary); client views add derived fields.
 * @module @dsh-plugins/dsh-cron/types
 */

export type TriggerKind = 'cron' | 'interval' | 'oneshot'

export type Trigger =
  | { kind: 'cron'; expr: string; timeZone: string }
  | { kind: 'interval'; everySeconds: number }
  | { kind: 'oneshot'; at: string }

export type TaskKind = 'agent' | 'command'

export interface AgentTask {
  kind: 'agent'
  prompt: string
}

export interface CommandTask {
  kind: 'command'
  argv: string[]
}

export type Task = AgentTask | CommandTask

export type OverlapPolicy = 'skip' | 'queue' | 'replace'
export type MisfirePolicy = 'skip' | 'runOnce'

/** v1.0 command delivery: the run record is piped to the delivery argv's stdin. */
export interface CommandDelivery {
  kind: 'command'
  argv: string[]
  /** Trigger only when the run failed (default true). */
  onFailureOnly?: boolean
  /** Delivery subprocess timeout in seconds (default 60). */
  timeoutSeconds?: number
}

export type Delivery = CommandDelivery

/** Where a job definition comes from; drives what the UI and tools may do. */
export type JobSource = 'manual' | 'config' | 'plugin'

/**
 * Looping jobs must carry an explicit validity window (`endAt` or
 * `maxDurationSeconds`, capped at one year); one-shot jobs archive themselves
 * after firing, so `window` stays optional for them.
 */
export interface JobWindow {
  endAt?: string
  maxDurationSeconds?: number
}

/** Persisted job definition. */
export interface CronJob {
  id: string
  name: string
  source: JobSource
  /** Plugin-provided jobs carry their provider id; orphaned once it unloads. */
  owner?: string
  trigger: Trigger
  task: Task
  /** Agent preset id for agent tasks; empty inherits the host default. */
  agentPreset?: string
  /** Pinned model; empty inherits the chat model selector. */
  model?: { provider: string; model: string; reasoningEffort?: string }
  /** Permission preset applied to the run session; empty inherits the host default. */
  permissionPreset?: string
  cwd?: string
  /** Task timeout in seconds (default 600). */
  timeoutSeconds?: number
  overlap: OverlapPolicy
  misfire: MisfirePolicy
  delivery?: Delivery
  /** Interval trigger anchor (ms epoch); fixed at creation so beats stay aligned. */
  anchorMs?: number
  window?: JobWindow
  enabled: boolean
  /** Set when the window expired or a one-shot fired; archived jobs stop scheduling. */
  archivedAt?: number
  createdAt: number
  updatedAt: number
  /** Sequence number of the last consumed beat; advanced before execution (at-most-once). */
  lastFiredMs?: number
  /** Monotonic per-job run counter. */
  seq: number
}

export type RunStatus =
  | 'ok'
  | 'failed'
  | 'running'
  | 'killed'
  | 'aborted'
  | 'timeout'
  | 'skipped'

/** Persisted run record. */
export interface CronRun {
  jobId: string
  seq: number
  /** The beat this run belongs to (ms epoch); equals the trigger time. */
  targetMs: number
  startedAt: number
  finishedAt?: number
  status: RunStatus
  /** Human-readable outcome: assistant summary, exit reason, or skip reason. */
  summary?: string
  error?: string
  /** Agent runs only: session id for native replay. */
  sessionId?: string
  /** Command runs only. */
  exitCode?: number
  outputTail?: string
  argv?: string[]
  /** Delivery outcome when a delivery channel ran. */
  delivery?: { exitCode: number; outputTail?: string }
  /** Manual stop / replace bookkeeping. */
  stoppedBy?: 'user' | 'replace'
}

/** Live execution state exposed by the scheduler. */
export interface RunningRun {
  jobId: string
  seq: number
  targetMs: number
  startedAt: number
}

/** Job projection served to the Web UI and tools. */
export interface JobView {
  job: CronJob
  nextFireMs: number | null
  running: RunningRun | null
  queuedBeatMs: number | null
  runs: CronRun[]
}

export interface CronStateView {
  serverTimeMs: number
  tickIntervalMs: number
  jobs: JobView[]
}

export interface ModelEffortInfo {
  id: string
  name: string
  description?: string
}

export interface CatalogModel {
  provider: string
  model: string
  label: string
  reasoning?: {
    efforts: ModelEffortInfo[]
    defaultEffort?: string
  }
}

export interface CatalogPreset {
  id: string
  name?: string
  description?: string
}

export interface CatalogOption {
  value: string
  name: string
  description?: string
}

export interface CatalogView {
  models: CatalogModel[]
  agentPresets: CatalogPreset[]
  permissionPresets: CatalogOption[]
  defaultModel?: { provider: string; model: string }
}

/** Plugin configuration (cordis patch `config:` block). */
export interface CronConfig {
  /** Run records kept per job (default 50). */
  historyLimit?: number
  /** Scheduler tick period in ms (default 15000). */
  tickIntervalMs?: number
  /** Global concurrent-run cap; 0 means unlimited (default). */
  maxConcurrentRuns?: number
  /**
   * Cron agent session GC. Deliberately OFF in v1.0: automatic deletion of
   * persisted session journals is destructive and the v1.2 panel owns it.
   */
  sessionGc?: { enabled?: boolean; graceMinutes?: number }
}
