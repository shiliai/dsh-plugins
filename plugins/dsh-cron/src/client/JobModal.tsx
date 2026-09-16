/**
 * Create/edit modal (prototype's single-screen modal): trigger presets +
 * custom layer (cron / interval / one-shot), task kind, agent preset / model
 * / permission (empty inherits the host default), reasoning effort linked to
 * the chosen model's provider catalog (empty = provider default; disabled
 * when the model has none), timeout, cwd, overlap/misfire, validity window.
 * @module @dsh-plugins/dsh-cron/client/JobModal
 */

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cronApi, CronApiError } from './api.ts'
import { detectPreset, oneYearOutRfc3339, presetExpr } from './format.ts'
import css from './styles.module.css?dsh-inline'
import type { ClientCatalog, ClientJobView, JobSpecPayload } from './types.ts'

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export interface JobModalProps {
  editing: ClientJobView | null
  catalog: ClientCatalog | null
  onClose(): void
  onSaved(view: ClientJobView | null, created: boolean): void
  pushToast(message: string, kind?: 'ok' | 'err'): void
}

interface FormState {
  name: string
  preset: 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
  hour: string
  minute: string
  customKind: 'cron' | 'interval' | 'oneshot'
  cronExpr: string
  everySeconds: string
  at: string
  taskKind: 'agent' | 'command'
  prompt: string
  argvJson: string
  agentPreset: string
  modelIdx: string
  effort: string
  permission: string
  timeout: string
  cwd: string
  overlap: 'skip' | 'queue' | 'replace'
  misfire: 'skip' | 'runOnce'
  endAt: string
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function modelIndexOf(catalog: ClientCatalog | null, provider: string | undefined, model: string | undefined): string {
  if (provider === undefined || model === undefined || catalog === null) return ''
  const index = catalog.models.findIndex(entry => entry.provider === provider && entry.model === model)
  return index >= 0 ? String(index) : ''
}

function initialForm(editing: ClientJobView | null, catalog: ClientCatalog | null): FormState {
  if (editing !== null) {
    const job = editing.job
    const trigger = job.trigger
    const preset = trigger.kind === 'cron' && trigger.expr !== undefined ? detectPreset(trigger.expr) : null
    const dailyHour = trigger.kind === 'cron' && trigger.expr !== undefined ? Number.parseInt(trigger.expr.trim().split(/\s+/)[1] ?? '8', 10) : 8
    const dailyMinute = trigger.kind === 'cron' && trigger.expr !== undefined ? Number.parseInt(trigger.expr.trim().split(/\s+/)[0] ?? '0', 10) : 0
    return {
      name: job.name,
      preset: preset ?? 'custom',
      hour: Number.isNaN(dailyHour) ? '8' : String(dailyHour),
      minute: Number.isNaN(dailyMinute) ? '0' : String(dailyMinute),
      customKind: trigger.kind,
      cronExpr: trigger.kind === 'cron' ? trigger.expr ?? '' : '',
      everySeconds: trigger.kind === 'interval' ? String(trigger.everySeconds ?? 3600) : '3600',
      at: trigger.kind === 'oneshot' ? trigger.at ?? '' : '',
      taskKind: job.task.kind,
      prompt: job.task.kind === 'agent' ? job.task.prompt ?? '' : '',
      argvJson: job.task.kind === 'command' ? JSON.stringify(job.task.argv ?? []) : '',
      agentPreset: job.agentPreset ?? '',
      modelIdx: modelIndexOf(catalog, job.model?.provider, job.model?.model),
      effort: job.model?.reasoningEffort ?? '',
      permission: job.permissionPreset ?? '',
      timeout: String(job.timeoutSeconds ?? 600),
      cwd: job.cwd ?? '',
      overlap: job.overlap,
      misfire: job.misfire,
      endAt: job.window?.endAt ?? '',
    }
  }
  return {
    name: '',
    preset: 'daily',
    hour: '8',
    minute: '0',
    customKind: 'cron',
    cronExpr: '',
    everySeconds: '3600',
    at: '',
    taskKind: 'agent',
    prompt: '',
    argvJson: '',
    agentPreset: '',
    modelIdx: '',
    effort: '',
    permission: '',
    timeout: '600',
    cwd: '',
    overlap: 'skip',
    misfire: 'skip',
    endAt: oneYearOutRfc3339(Date.now()),
  }
}

export function JobModal(props: JobModalProps): JSX.Element {
  const { editing, catalog } = props
  const [form, setForm] = useState<FormState>(() => initialForm(editing, catalog))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setForm(initialForm(editing, catalog))
    setErrors({})
  }, [editing, catalog])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => setForm(prev => ({ ...prev, [key]: value }))

  const selectedModel = useMemo(() => {
    if (catalog === null || form.modelIdx === '') return null
    return catalog.models[Number.parseInt(form.modelIdx, 10)] ?? null
  }, [catalog, form.modelIdx])

  const effortDisabled = form.modelIdx === '' || selectedModel === null || (selectedModel.reasoning?.efforts.length ?? 0) === 0
  const effortHint = form.modelIdx === ''
    ? '模型继承默认时,推理等级随之继承。'
    : selectedModel === null || (selectedModel.reasoning?.efforts.length ?? 0) === 0
      ? '该模型不提供推理等级(This model provides no reasoning effort levels.)'
      : '空值 = 跟随 provider 默认;取值来自该模型 catalog 的 reasoning.efforts,与 DSH 模型选择器一致。'
  const tzValue = editing !== null && editing.job.trigger.kind === 'cron' && editing.job.trigger.timeZone !== undefined
    ? editing.job.trigger.timeZone
    : BROWSER_TZ
  const isLoop = form.preset !== 'custom' || form.customKind === 'cron' || form.customKind === 'interval'

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setErrors({})
    try {
      const trigger: JobSpecPayload['trigger'] = form.preset !== 'custom'
        ? { kind: 'cron', expr: presetExpr(form.preset, Number(form.hour), Number(form.minute)), timeZone: tzValue }
        : form.customKind === 'cron'
          ? { kind: 'cron', expr: form.cronExpr.trim(), timeZone: tzValue }
          : form.customKind === 'interval'
            ? { kind: 'interval', everySeconds: Number(form.everySeconds) }
            : { kind: 'oneshot', at: form.at.trim() }
      const task: JobSpecPayload['task'] = form.taskKind === 'agent'
        ? { kind: 'agent', prompt: form.prompt.trim() }
        : { kind: 'command', argv: JSON.parse(form.argvJson.trim() || '[]') as string[] }
      const model = selectedModel === null
        ? undefined
        : {
            provider: selectedModel.provider,
            model: selectedModel.model,
            ...(effortDisabled || form.effort === '' ? {} : { reasoningEffort: form.effort }),
          }
      const spec: JobSpecPayload = {
        name: form.name.trim(),
        trigger,
        task,
        ...(form.agentPreset !== '' ? { agentPreset: form.agentPreset } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(form.permission !== '' ? { permissionPreset: form.permission } : {}),
        ...(form.cwd.trim() !== '' ? { cwd: form.cwd.trim() } : {}),
        timeoutSeconds: Number(form.timeout) || 600,
        overlap: form.overlap,
        misfire: form.misfire,
        ...(isLoop
          ? { window: { endAt: form.endAt.trim() } }
          : form.endAt.trim() !== '' ? { window: { endAt: form.endAt.trim() } } : {}),
      }
      if (editing !== null) await cronApi.updateJob(editing.job.id, spec)
      else await cronApi.createJob(spec)
      props.onSaved(editing, editing === null)
    } catch (error) {
      if (error instanceof CronApiError) {
        const field = error.field ?? 'trigger'
        setErrors({ [field]: error.message })
      } else {
        setErrors({ trigger: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={css.mask} onClick={event => { if (event.target === event.currentTarget) props.onClose() }}>
      <div className={css.modal} role="dialog" aria-modal="true">
        <div className={css.modalHead}>
          <h3>{editing !== null ? '编辑任务' : '新建任务'}</h3>
          <button className={css.iconBtn} type="button" onClick={props.onClose}><X size={15} /></button>
        </div>
        <div className={css.modalBody}>
          <div className={css.row}>
            <label>名称</label>
            <input className={css.input} type="text" value={form.name} disabled={editing !== null}
              placeholder="wecom-mail-digest(字母/数字/-/_,无空格)"
              onChange={event => set('name', event.target.value)} />
            {errors.name !== undefined && <div className={css.fieldError}>{errors.name}</div>}
          </div>

          <div className={css.row}>
            <label>触发方式</label>
            <div className={css.seg}>
              {(['hourly', 'daily', 'weekdays', 'weekly', 'custom'] as const).map(preset => (
                <button key={preset} type="button" className={form.preset === preset ? css.on : undefined}
                  onClick={() => set('preset', preset)}>
                  {{ hourly: '每小时', daily: '每天', weekdays: '工作日', weekly: '每周', custom: '自定义' }[preset]}
                </button>
              ))}
            </div>
            {form.preset !== 'custom' && (
              <div className={css.cols2} style={{ marginTop: 10 }}>
                <input className={css.input} type="number" min={0} max={23} value={form.hour} onChange={event => set('hour', event.target.value)} placeholder="时" aria-label="小时" />
                <input className={css.input} type="number" min={0} max={59} value={form.minute} onChange={event => set('minute', event.target.value)} placeholder="分" aria-label="分钟" />
              </div>
            )}
            {form.preset === 'custom' && (
              <div style={{ marginTop: 10 }}>
                <div className={css.seg} style={{ marginBottom: 10 }}>
                  {(['cron', 'interval', 'oneshot'] as const).map(kind => (
                    <button key={kind} type="button" className={form.customKind === kind ? css.on : undefined}
                      onClick={() => set('customKind', kind)}>
                      {{ cron: 'cron 表达式', interval: '固定间隔', oneshot: '一次性' }[kind]}
                    </button>
                  ))}
                </div>
                {form.customKind === 'cron' && <input className={cx(css.input, css.mono)} type="text" value={form.cronExpr} placeholder="0 8 * * 1-5" onChange={event => set('cronExpr', event.target.value)} />}
                {form.customKind === 'interval' && (
                  <input className={css.input} type="number" min={60} value={form.everySeconds} placeholder="间隔秒数 ≥60" onChange={event => set('everySeconds', event.target.value)} />
                )}
                {form.customKind === 'oneshot' && (
                  <input className={cx(css.input, css.mono)} type="text" value={form.at} placeholder="2026-09-20T08:00:00+08:00" onChange={event => set('at', event.target.value)} />
                )}
              </div>
            )}
            <span className={css.tzNote}>🌐 时区{editing !== null && editing.job.trigger.kind === 'cron' ? '沿用任务原值' : '静默取自浏览器'}:<b className={css.mono} style={{ marginLeft: 4 }}>{tzValue}</b></span>
            {errors.trigger !== undefined && <div className={css.fieldError}>{errors.trigger}</div>}
            {errors.window !== undefined && <div className={css.fieldError}>{errors.window}</div>}
          </div>

          <div className={css.row}>
            <label>任务类型</label>
            <div className={css.seg}>
              {(['agent', 'command'] as const).map(kind => (
                <button key={kind} type="button" className={form.taskKind === kind ? css.on : undefined}
                  onClick={() => set('taskKind', kind)}>
                  {{ agent: '🤖 agent(提示词走完整工具链)', command: '⌨️ command(子进程)' }[kind]}
                </button>
              ))}
            </div>
            {form.taskKind === 'agent' && (
              <textarea className={cx(css.input, css.textarea)} style={{ marginTop: 10 }} value={form.prompt}
                placeholder="例:查看我的企微未读邮件,总结后调用 wecom_send_message 推送给我"
                onChange={event => set('prompt', event.target.value)} />
            )}
            {form.taskKind === 'command' && (
              <input className={cx(css.input, css.mono)} style={{ marginTop: 10 }} type="text" value={form.argvJson}
                placeholder='["./scripts/heartbeat.sh", "--verbose"](JSON 数组)'
                onChange={event => set('argvJson', event.target.value)} />
            )}
            {errors.task !== undefined && <div className={css.fieldError}>{errors.task}</div>}
          </div>

          <div className={css.cols2}>
            <div className={css.row}>
              <label>Agent 预设(运行身份)</label>
              <select className={css.input} value={form.agentPreset} onChange={event => set('agentPreset', event.target.value)}>
                <option value="">继承默认 agent</option>
                {(catalog?.agentPresets ?? []).map(preset => (
                  <option key={preset.id} value={preset.id}>{preset.id}{preset.name !== undefined && preset.name !== preset.id ? ` · ${preset.name}` : ''}</option>
                ))}
              </select>
              <div className={css.hint}>对应 ctx.agents.create 的 preset;决定该次运行的系统人格、默认工具集与权限基线。</div>
            </div>
            <div className={css.row}>
              <label>模型</label>
              <select className={css.input} value={form.modelIdx} onChange={event => { set('modelIdx', event.target.value); set('effort', '') }}>
                <option value="">继承默认</option>
                {(catalog?.models ?? []).map((model, index) => (
                  <option key={`${model.provider}/${model.model}`} value={String(index)}>{model.label || model.model}({model.provider})</option>
                ))}
              </select>
              <div className={css.hint}>钉死后不跟随聊天模型变化,额度可预期。</div>
            </div>
            <div className={css.row}>
              <label>推理等级</label>
              <select className={css.input} value={effortDisabled ? '' : form.effort} disabled={effortDisabled} onChange={event => set('effort', event.target.value)}>
                {form.modelIdx === '' && <option value="">继承默认(随聊天选择器)</option>}
                {form.modelIdx !== '' && effortDisabled && <option value="">该模型不提供推理等级</option>}
                {form.modelIdx !== '' && !effortDisabled && (
                  <>
                    <option value="">跟随 provider 默认({selectedModel?.reasoning?.efforts.find(effort => effort.id === selectedModel?.reasoning?.defaultEffort)?.name ?? '默认'})</option>
                    {(selectedModel?.reasoning?.efforts ?? []).map(effort => (
                      <option key={effort.id} value={effort.id}>{effort.name}({effort.id})</option>
                    ))}
                  </>
                )}
              </select>
              <div className={css.hint}>{effortHint}</div>
            </div>
          </div>
          <div className={css.cols2}>
            <div className={css.row}>
              <label>权限预设</label>
              <select className={css.input} value={form.permission} onChange={event => set('permission', event.target.value)}>
                <option value="">继承默认</option>
                {(catalog?.permissionPresets ?? []).map(option => (
                  <option key={option.value} value={option.value}>{option.name}</option>
                ))}
              </select>
            </div>
            <div className={css.row}>
              <label>超时(秒)</label>
              <input className={css.input} type="number" min={30} value={form.timeout} onChange={event => set('timeout', event.target.value)} />
            </div>
          </div>

          <div className={css.row}>
            <label>工作目录</label>
            <input className={cx(css.input, css.mono)} type="text" value={form.cwd} placeholder="留空 = 宿主默认;或输入路径" onChange={event => set('cwd', event.target.value)} />
          </div>

          <div className={css.cols3}>
            <div className={css.row}>
              <label>重叠策略</label>
              <select className={css.input} value={form.overlap} onChange={event => set('overlap', event.target.value as FormState['overlap'])}>
                <option value="skip">skip(跳过)</option>
                <option value="queue">queue(排队 1 次)</option>
                <option value="replace">replace(杀掉重跑)</option>
              </select>
            </div>
            <div className={css.row}>
              <label>漏跑策略</label>
              <select className={css.input} value={form.misfire} onChange={event => set('misfire', event.target.value as FormState['misfire'])}>
                <option value="skip">skip(不补跑)</option>
                <option value="runOnce">runOnce(补最近一次)</option>
              </select>
            </div>
            <div className={css.row}>
              <label>有效期至{isLoop ? '' : '(可选)'}</label>
              <input className={cx(css.input, css.mono)} type="text" value={form.endAt} placeholder="2027-12-31T23:59:59+08:00" onChange={event => set('endAt', event.target.value)} />
            </div>
          </div>
          <div className={css.hint}>循环任务必须设置有效期窗口(endAt 或 maxDurationSeconds,上限一年)——禁止无限 cron。新建时已预填一年后过期,可修改。</div>
        </div>
        <div className={css.modalFoot}>
          <button className={css.btn} type="button" onClick={props.onClose}>取消</button>
          <button className={cx(css.btn, css.btnPrimary, submitting && css.btnDisabled)} type="button" disabled={submitting} onClick={() => { void submit() }}>
            {submitting ? '保存中…' : editing !== null ? '保存' : '创建并启用'}
          </button>
        </div>
      </div>
    </div>
  )
}
