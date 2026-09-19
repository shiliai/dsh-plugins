/**
 * Client-safe view types (wire shapes of /dsh-cron/api). No node imports so
 * the browser bundle stays clean.
 * @module @dsh-plugins/dsh-cron/client/types
 */

export type TriggerKind = 'cron' | 'interval' | 'oneshot'
export type TaskKind = 'agent' | 'command'
export type JobSource = 'manual' | 'config' | 'plugin'
export type RunStatus = 'ok' | 'failed' | 'running' | 'killed' | 'aborted' | 'timeout' | 'skipped'

export interface ClientTrigger {
  kind: TriggerKind
  expr?: string
  timeZone?: string
  everySeconds?: number
  at?: string
}

export interface ClientTask {
  kind: TaskKind
  prompt?: string
  argv?: string[]
}

export interface ClientJob {
  id: string
  name: string
  source: JobSource
  owner?: string
  trigger: ClientTrigger
  task: ClientTask
  agentPreset?: string
  model?: { provider: string; model: string; reasoningEffort?: string }
  permissionPreset?: string
  cwd?: string
  timeoutSeconds?: number
  overlap: 'skip' | 'queue' | 'replace'
  misfire: 'skip' | 'runOnce'
  window?: { endAt?: string; maxDurationSeconds?: number }
  enabled: boolean
  archivedAt?: number
  createdAt: number
  updatedAt: number
}

export interface ClientRun {
  jobId: string
  seq: number
  targetMs: number
  startedAt: number
  finishedAt?: number
  status: RunStatus
  summary?: string
  error?: string
  sessionId?: string
  trigger?: 'manual' | 'scheduled'
  model?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  exitCode?: number
  outputTail?: string
  argv?: string[]
  delivery?: { exitCode: number; outputTail?: string }
  stoppedBy?: 'user' | 'replace'
}

export interface ClientJobView {
  job: ClientJob
  nextFireMs: number | null
  running: { jobId: string; seq: number; targetMs: number; startedAt: number } | null
  queuedBeatMs: number | null
  runs: ClientRun[]
}

export interface ClientState {
  serverTimeMs: number
  tickIntervalMs: number
  jobs: ClientJobView[]
}

export interface ClientEffort {
  id: string
  name: string
  description?: string
}

export interface ClientCatalog {
  models: Array<{
    provider: string
    model: string
    label: string
    reasoning?: { efforts: ClientEffort[]; defaultEffort?: string }
  }>
  agentPresets: Array<{ id: string; name?: string; description?: string }>
  permissionPresets: Array<{ value: string; name: string; description?: string }>
  defaultModel?: { provider: string; model: string }
}

/** Payload of POST /jobs and PUT /jobs/:id. */
export interface JobSpecPayload {
  name: string
  trigger: ClientTrigger
  task: ClientTask
  agentPreset?: string
  model?: { provider: string; model: string; reasoningEffort?: string }
  permissionPreset?: string
  cwd?: string
  timeoutSeconds?: number
  overlap: 'skip' | 'queue' | 'replace'
  misfire: 'skip' | 'runOnce'
  delivery?: { kind: 'command'; argv: string[]; onFailureOnly?: boolean }
  window?: { endAt?: string; maxDurationSeconds?: number }
}
