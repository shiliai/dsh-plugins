/**
 * Job spec validation shared by the HTTP API and the cron_* tools. Fails loud
 * with a field-naming message so a bad spec never reaches the scheduler.
 * @module @dsh-plugins/dsh-cron/validate
 */

import { nextCronFire, validateTimeZone } from './cron.ts'
import type { CronJob, Delivery, JobWindow, OverlapPolicy, MisfirePolicy, Task, Trigger } from './types.ts'

export const NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u
export const MIN_INTERVAL_SECONDS = 60
export const MAX_WINDOW_SECONDS = 365 * 24 * 60 * 60
export const DEFAULT_TIMEOUT_SECONDS = 600
export const MIN_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/

export class ValidationError extends Error {
  constructor(message: string, readonly field: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

function fail(field: string, message: string): never {
  throw new ValidationError(message, field)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export interface RawJobSpec {
  name?: unknown
  trigger?: unknown
  task?: unknown
  agentPreset?: unknown
  model?: unknown
  permissionPreset?: unknown
  cwd?: unknown
  timeoutSeconds?: unknown
  overlap?: unknown
  misfire?: unknown
  delivery?: unknown
  window?: unknown
}

/** Validate and normalize a create/update payload into the persisted shape. */
export function normalizeJobSpec(raw: RawJobSpec, nowMs: number): Omit<CronJob, 'id' | 'source' | 'createdAt' | 'updatedAt' | 'seq' | 'lastFiredMs' | 'enabled'> {
  const name = str(raw.name)
  if (!name) fail('name', '任务名称不能为空')
  if (name.length > 64) fail('name', '任务名称过长(最多 64 字符)')
  if (!NAME_PATTERN.test(name)) fail('name', '名称仅限字母(任意文字)、数字、- 和 _,无空格')

  const trigger = normalizeTrigger(raw.trigger, nowMs)
  const task = normalizeTask(raw.task)
  const overlap = normalizeEnum<OverlapPolicy>(raw.overlap, ['skip', 'queue', 'replace'], 'overlap', 'skip')
  const misfire = normalizeEnum<MisfirePolicy>(raw.misfire, ['skip', 'runOnce'], 'misfire', 'skip')
  const delivery = normalizeDelivery(raw.delivery)
  const window = normalizeWindow(raw.window, trigger)
  const timeoutSeconds = normalizeTimeout(raw.timeoutSeconds)

  const agentPreset = str(raw.agentPreset)
  const permissionPreset = str(raw.permissionPreset)
  const cwd = str(raw.cwd)

  let model: { provider: string; model: string; reasoningEffort?: string } | undefined
  if (raw.model !== undefined && raw.model !== null && typeof raw.model === 'object') {
    const rawModel = raw.model as Record<string, unknown>
    const provider = str(rawModel.provider)
    const modelId = str(rawModel.model)
    if (!provider || !modelId) fail('model', '钉死模型需要 provider 与 model')
    const reasoningEffort = str(rawModel.reasoningEffort)
    model = reasoningEffort ? { provider, model: modelId, reasoningEffort } : { provider, model: modelId }
  } else if (typeof raw.model === 'string' && str(raw.model)) {
    fail('model', '模型需为 { provider, model, reasoningEffort? } 对象')
  }

  if (task.kind !== 'agent' && agentPreset) fail('agentPreset', '仅 agent 任务可设置 Agent 预设')
  if (task.kind !== 'agent' && model) fail('model', '仅 agent 任务可设置模型')

  return {
    name,
    trigger,
    task,
    ...(agentPreset ? { agentPreset } : {}),
    ...(model ? { model } : {}),
    ...(permissionPreset ? { permissionPreset } : {}),
    ...(cwd ? { cwd } : {}),
    timeoutSeconds,
    overlap,
    misfire,
    ...(delivery ? { delivery } : {}),
    ...(window ? { window } : {}),
  }
}

function normalizeTrigger(raw: unknown, nowMs: number): Trigger {
  if (raw === undefined || raw === null || typeof raw !== 'object') fail('trigger', '缺少触发配置')
  const record = raw as Record<string, unknown>
  const kind = str(record.kind)
  if (kind === 'cron') {
    const expr = str(record.expr)
    if (!expr) fail('trigger', 'cron 触发需要表达式')
    const timeZone = str(record.timeZone)
    if (!timeZone) fail('trigger', 'cron 触发必须携带显式 IANA timeZone(禁止依赖进程时区)')
    validateTimeZone(timeZone)
    try {
      nextCronFire(expr, nowMs, timeZone)
    } catch (error) {
      fail('trigger', error instanceof Error ? error.message : String(error))
    }
    return { kind: 'cron', expr, timeZone }
  }
  if (kind === 'interval') {
    const everySeconds = typeof record.everySeconds === 'number' ? record.everySeconds : Number.NaN
    if (!Number.isFinite(everySeconds) || everySeconds < MIN_INTERVAL_SECONDS) {
      fail('trigger', `固定间隔最小 ${MIN_INTERVAL_SECONDS} 秒`)
    }
    if (!Number.isInteger(everySeconds)) fail('trigger', '间隔需为整数秒')
    return { kind: 'interval', everySeconds }
  }
  if (kind === 'oneshot') {
    const at = str(record.at)
    if (!at || !RFC3339_PATTERN.test(at) || Number.isNaN(Date.parse(at))) {
      fail('trigger', '一次性时刻必须为 RFC 3339 且带 Z 或数字偏移,如 2026-09-20T08:00:00+08:00')
    }
    return { kind: 'oneshot', at }
  }
  fail('trigger', '触发方式必须是 cron / interval / oneshot 之一')
}

function normalizeTask(raw: unknown): Task {
  if (raw === undefined || raw === null || typeof raw !== 'object') fail('task', '缺少任务定义')
  const record = raw as Record<string, unknown>
  const kind = str(record.kind)
  if (kind === 'agent') {
    const prompt = str(record.prompt)
    if (!prompt) fail('task', 'agent 任务需要 prompt')
    if (prompt.length > 32_000) fail('task', 'prompt 过长(上限 32000 字符)')
    return { kind: 'agent', prompt }
  }
  if (kind === 'command') {
    const argv = record.argv
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(item => typeof item === 'string' && item.length > 0)) {
      fail('task', 'command 任务需要非空 argv 字符串数组')
    }
    if (argv.length > 64) fail('task', 'argv 过长(上限 64 段)')
    return { kind: 'command', argv: argv as string[] }
  }
  fail('task', '任务类型必须是 agent 或 command')
}

function normalizeEnum<T extends string>(raw: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = str(raw)
  if (!(allowed as readonly string[]).includes(value)) fail(field, `${field} 必须是 ${allowed.join(' / ')} 之一`)
  return value as T
}

function normalizeTimeout(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TIMEOUT_SECONDS
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  if (!Number.isFinite(value) || value < MIN_TIMEOUT_SECONDS || value > MAX_TIMEOUT_SECONDS) {
    fail('timeoutSeconds', `超时需在 ${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS} 秒之间`)
  }
  return Math.floor(value)
}

function normalizeDelivery(raw: unknown): Delivery | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'object') fail('delivery', 'delivery 需为对象')
  const record = raw as Record<string, unknown>
  const kind = str(record.kind)
  if (kind !== 'command') fail('delivery', 'v1.0 仅支持 command delivery')
  const argv = record.argv
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(item => typeof item === 'string' && item.length > 0)) {
    fail('delivery', 'delivery argv 需为非空字符串数组')
  }
  const timeoutSeconds = record.timeoutSeconds === undefined ? 60 : Number(record.timeoutSeconds)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 600) fail('delivery', 'delivery 超时需在 5-600 秒')
  return {
    kind: 'command',
    argv: argv as string[],
    onFailureOnly: record.onFailureOnly === undefined ? true : record.onFailureOnly === true,
    timeoutSeconds: Math.floor(timeoutSeconds),
  }
}

/**
 * Looping triggers (cron / interval) must carry an explicit validity window —
 * `endAt` or `maxDurationSeconds`, at most one year. One-shot jobs archive
 * after firing, so the window stays optional for them.
 */
function normalizeWindow(raw: unknown, trigger: Trigger): JobWindow | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (trigger.kind !== 'oneshot') {
      fail('window', '循环任务必须设置有效期窗口(endAt 或 maxDurationSeconds,上限一年)——禁止无限循环')
    }
    return undefined
  }
  if (typeof raw !== 'object') fail('window', 'window 需为 { endAt? } 或 { maxDurationSeconds? }')
  const record = raw as Record<string, unknown>
  const window: JobWindow = {}
  if (record.endAt !== undefined && record.endAt !== null && str(String(record.endAt))) {
    const endAt = str(String(record.endAt))
    if (!RFC3339_PATTERN.test(endAt) || Number.isNaN(Date.parse(endAt))) {
      fail('window', 'endAt 必须为 RFC 3339 且带 Z 或数字偏移')
    }
    window.endAt = endAt
  }
  if (record.maxDurationSeconds !== undefined && record.maxDurationSeconds !== null) {
    const seconds = Number(record.maxDurationSeconds)
    if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_WINDOW_SECONDS) {
      fail('window', `maxDurationSeconds 需在 ${MIN_INTERVAL_SECONDS}-${MAX_WINDOW_SECONDS} 秒(一年)`)
    }
    window.maxDurationSeconds = Math.floor(seconds)
  }
  if (window.endAt === undefined && window.maxDurationSeconds === undefined) {
    fail('window', 'window 缺少 endAt 或 maxDurationSeconds')
  }
  return window
}
