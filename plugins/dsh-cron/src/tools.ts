/**
 * cron_* model tools, registered for every runtime agent. Manual jobs are the
 * only creatable/deletable kind; config/plugin jobs are listable, runnable,
 * pausable, and viewable. Results always echo absolute ISO times so the model
 * never does time math (fan56 lesson).
 * @module @dsh-plugins/dsh-cron/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CronController } from './controller.ts'
import { scheduleText } from './schedule.ts'
import type { CronJob } from './types.ts'
import { ValidationError } from './validate.ts'

const JSON_OUTPUT = { type: 'json' } as const

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function jobSummaryLine(job: CronJob, nextFireMs: number | null): Record<string, string | number | boolean | null> {
  return {
    id: job.id,
    name: job.name,
    source: job.source,
    taskKind: job.task.kind,
    enabled: job.enabled,
    archived: job.archivedAt !== undefined,
    schedule: scheduleText(job),
    nextFire: nextFireMs === null ? null : new Date(nextFireMs).toISOString(),
  }
}

export function registerCronTools(ctx: Context, controller: CronController): Array<() => void> {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_create',
    description: [
      '创建一个 dsh-cron 定时任务(无人值守,宿主侧调度,与任何会话无关)。',
      '三种触发:cron 表达式(必须提供 IANA timeZone,如 Asia/Shanghai)、everySeconds 固定间隔(最小 60 秒)、at 一次性 RFC 3339 时刻。',
      '两种任务:agent(prompt 走完整 DSH 工具链)或 command(argv JSON 数组字符串,如 "[\\"/bin/echo\\",\\"hi\\"]")。',
      '强制规则:循环任务(cron/interval)必须提供 endAt 或 maxDurationSeconds 有效期窗口(上限一年),禁止无限循环。',
      '创建前先向用户确认关键参数;创建后返回值里带绝对时间 now/nextFire。',
    ].join('\n'),
    parameters: {
      name: { type: 'string', required: true, description: '任务名:字母/数字/-/_,无空格,如 wecom-mail-digest' },
      triggerKind: { type: 'string', required: true, description: 'cron | interval | oneshot' },
      cronExpr: { type: 'string', description: 'triggerKind=cron 时必填:5 字段 cron 表达式(分 时 日 月 周)' },
      timeZone: { type: 'string', description: 'triggerKind=cron 时必填:IANA 时区,如 Asia/Shanghai' },
      everySeconds: { type: 'integer', description: 'triggerKind=interval 时必填:间隔秒数,最小 60' },
      at: { type: 'string', description: 'triggerKind=oneshot 时必填:RFC 3339 时刻,必须带 Z 或数字偏移' },
      taskKind: { type: 'string', required: true, description: 'agent | command' },
      prompt: { type: 'string', description: 'taskKind=agent 时必填:无人值守执行的任务提示词' },
      argvJson: { type: 'string', description: 'taskKind=command 时必填:argv 的 JSON 数组字符串' },
      agentPreset: { type: 'string', description: 'Agent 预设 id;留空继承宿主默认' },
      modelProvider: { type: 'string', description: '钉死模型的 provider;与 modelName 成对' },
      modelName: { type: 'string', description: '钉死模型的 model id;与 modelProvider 成对' },
      reasoningEffort: { type: 'string', description: '推理等级 id;留空跟随 provider 默认' },
      permissionPreset: { type: 'string', description: '权限预设名;留空继承宿主默认' },
      cwd: { type: 'string', description: '工作目录;留空继承宿主默认' },
      timeoutSeconds: { type: 'integer', description: '任务超时秒数,默认 600' },
      overlap: { type: 'string', description: '重叠策略:skip | queue | replace,默认 skip' },
      misfire: { type: 'string', description: '漏跑策略:skip | runOnce,默认 skip' },
      endAt: { type: 'string', description: '循环任务必填其一:RFC 3339 有效期终点' },
      maxDurationSeconds: { type: 'integer', description: '循环任务必填其一:自创建起的有效秒数,上限一年' },
    },
    output: { schema: JSON_OUTPUT, render: renderJson },
    presentCall: () => ({ card: 'generic', title: 'Create cron job', kind: 'other' }),
    async execute(args) {
      let argv: unknown
      if (args.argvJson !== undefined) {
        try {
          argv = JSON.parse(args.argvJson)
        } catch {
          return { ok: false, error: 'argvJson 不是合法 JSON', now: new Date().toISOString() }
        }
      }
      const result = await controller.createManualJob({
        name: args.name,
        trigger: {
          kind: args.triggerKind,
          ...(args.cronExpr !== undefined ? { expr: args.cronExpr } : {}),
          ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
          ...(args.everySeconds !== undefined ? { everySeconds: args.everySeconds } : {}),
          ...(args.at !== undefined ? { at: args.at } : {}),
        },
        task: {
          kind: args.taskKind,
          ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
          ...(argv !== undefined ? { argv: argv as string[] } : {}),
        },
        ...(args.agentPreset !== undefined ? { agentPreset: args.agentPreset } : {}),
        ...(args.modelName !== undefined || args.modelProvider !== undefined
          ? {
              model: {
                provider: args.modelProvider ?? '',
                model: args.modelName ?? '',
                ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
              },
            }
          : {}),
        ...(args.permissionPreset !== undefined ? { permissionPreset: args.permissionPreset } : {}),
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
        ...(args.overlap !== undefined ? { overlap: args.overlap } : {}),
        ...(args.misfire !== undefined ? { misfire: args.misfire } : {}),
        ...(args.endAt !== undefined || args.maxDurationSeconds !== undefined
          ? {
              window: {
                ...(args.endAt !== undefined ? { endAt: args.endAt } : {}),
                ...(args.maxDurationSeconds !== undefined ? { maxDurationSeconds: args.maxDurationSeconds } : {}),
              },
            }
          : {}),
      })
      if (!result.ok) return { ok: false, error: result.error ?? 'create failed', now: new Date().toISOString() }
      return {
        ok: true,
        ...(result.job !== undefined ? { job: jobSummaryLine(result.job.job, result.job.nextFireMs) } : {}),
        now: new Date().toISOString(),
        nextFire: result.job !== undefined && result.job.nextFireMs !== null ? new Date(result.job.nextFireMs).toISOString() : null,
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_list',
    description: '列出全部 dsh-cron 定时任务(id、名称、来源、触发、启用状态、下次触发的绝对时间)。',
    parameters: {},
    output: { schema: JSON_OUTPUT, render: renderJson },
    presentCall: () => ({ card: 'generic', title: 'List cron jobs', kind: 'read' }),
    async execute() {
      const state = controller.state()
      return {
        now: new Date(state.serverTimeMs).toISOString(),
        jobs: state.jobs.map(view => jobSummaryLine(view.job, view.nextFireMs)),
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_runs',
    description: '查看某个 dsh-cron 任务的运行历史(状态、计划时刻、耗时、摘要;agent 运行含会话 id)。',
    parameters: {
      jobId: { type: 'string', required: true, description: '任务 id(来自 cron_list)' },
      limit: { type: 'integer', description: '最多返回条数,默认 10' },
    },
    output: { schema: JSON_OUTPUT, render: renderJson },
    presentCall: () => ({ card: 'generic', title: 'List cron runs', kind: 'read' }),
    async execute(args) {
      const history = controller.runHistory(args.jobId)
      if (!history.ok) return { ok: false, error: history.error ?? 'history unavailable', now: new Date().toISOString() }
      const runs = (history.runs ?? []).slice(0, args.limit ?? 10).map(run => ({
        seq: run.seq,
        status: run.status,
        target: new Date(run.targetMs).toISOString(),
        startedAt: new Date(run.startedAt).toISOString(),
        finishedAt: run.finishedAt === undefined ? null : new Date(run.finishedAt).toISOString(),
        summary: run.summary ?? '',
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      }))
      return { ok: true, now: new Date().toISOString(), runs }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_run_now',
    description: '立即触发一次 dsh-cron 任务(不影响其正常调度节奏;返回绝对时间)。',
    parameters: { jobId: { type: 'string', required: true, description: '任务 id(来自 cron_list)' } },
    output: { schema: JSON_OUTPUT, render: renderJson },
    presentCall: () => ({ card: 'generic', title: 'Run cron job now', kind: 'other' }),
    async execute(args) {
      const result = await controller.runNow(args.jobId)
      return { ok: result.ok, ...(result.error !== undefined ? { error: result.error } : {}), startedAt: new Date().toISOString() }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_enable',
    description: '恢复一个 dsh-cron 任务的调度。',
    parameters: { jobId: { type: 'string', required: true, description: '任务 id(来自 cron_list)' } },
    output: { schema: JSON_OUTPUT, render: renderJson },
    presentCall: () => ({ card: 'generic', title: 'Enable cron job', kind: 'other' }),
    async execute(args) {
      const result = await controller.setEnabled(args.jobId, true)
      return { ok: result.ok, ...(result.error !== undefined ? { error: result.error } : {}), changedAt: new Date().toISOString() }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_disable',
    description: '暂停一个 dsh-cron 任务的调度(不删除任务与历史)。',
    parameters: { jobId: { type: 'string', required: true, description: '任务 id(来自 cron_list)' } },
    output: { schema: JSON_OUTPUT, render: renderJson },
    presentCall: () => ({ card: 'generic', title: 'Disable cron job', kind: 'other' }),
    async execute(args) {
      const result = await controller.setEnabled(args.jobId, false)
      return { ok: result.ok, ...(result.error !== undefined ? { error: result.error } : {}), changedAt: new Date().toISOString() }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_delete',
    description: '删除一个 manual 来源的 dsh-cron 任务及其全部运行历史(config/plugin 来源不可删)。',
    parameters: { jobId: { type: 'string', required: true, description: '任务 id(来自 cron_list)' } },
    output: { schema: JSON_OUTPUT, render: renderJson },
    presentCall: () => ({ card: 'generic', title: 'Delete cron job', kind: 'other' }),
    async execute(args) {
      const result = await controller.removeJob(args.jobId)
      return { ok: result.ok, ...(result.error !== undefined ? { error: result.error } : {}), deletedAt: new Date().toISOString() }
    },
  })))

  return disposers
}

export { ValidationError }
