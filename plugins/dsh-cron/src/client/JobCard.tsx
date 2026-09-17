/**
 * One job row: status dot, identity chips, schedule line (next-fire countdown
 * or live elapsed), hover actions, ⋯ menu (run/stop/pause/edit/delete with a
 * two-click confirm), and the expandable run history. Clicking an agent run
 * jumps to the native session replay; clicking a command run opens the
 * run-detail view.
 * @module @dsh-plugins/dsh-cron/client/JobCard
 */

import { Play, Square } from 'lucide-react'
import css from './styles.module.css?dsh-inline'
import { fmtCountdown, fmtDateTime, fmtDuration, KIND_LABEL, scheduleText, STATUS_LABEL, statusDotClass } from './format.ts'
import type { ClientJobView, ClientRun, RunStatus } from './types.ts'

export interface JobCardProps {
  view: ClientJobView
  nowMs: number
  expanded: boolean
  pendingDelete: boolean
  menuOpen: boolean
  onToggleExpand(): void
  onToggleMenu(): void
  onCloseMenu(): void
  onRunNow(): void
  onStop(): void
  onToggleEnabled(): void
  onEdit(): void
  onDelete(): void
  onOpenRun(run: ClientRun): void
  onNeedConfirmDelete(): void
}

const RUN_ST_CLASS: Record<RunStatus, string> = {
  ok: 'stOk',
  failed: 'stFailed',
  running: 'stRunning',
  killed: 'stKilled',
  aborted: 'stAborted',
  timeout: 'stTimeout',
  skipped: 'stSkipped',
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function dotClass(name: string): string {
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1)
  return (css as Record<string, string>)[`dot${capitalized}`] ?? ''
}

export function JobCard(props: JobCardProps): JSX.Element {
  const { view, nowMs, expanded } = props
  const job = view.job
  const orphan = job.source === 'plugin' && job.archivedAt !== undefined
  const archived = job.archivedAt !== undefined
  const readonly = job.source !== 'manual'
  const runCount = view.runs.length + (view.running !== null ? 1 : 0)

  let subtitle: JSX.Element
  if (view.running !== null) {
    subtitle = (
      <>
        <span className={css.elapsed}>▶ 运行中 {fmtDuration(nowMs - view.running.startedAt)}</span>
        <span>· target {fmtDateTime(view.running.targetMs)}</span>
      </>
    )
  } else if (archived) {
    subtitle = <span>已归档 · <span className={css.mono}>{scheduleText(job)}</span></span>
  } else if (!job.enabled) {
    subtitle = <span>已暂停 · <span className={css.mono}>{scheduleText(job)}</span></span>
  } else {
    subtitle = (
      <>
        <span className={css.next}>下次 {view.nextFireMs === null ? '—(窗口已过期)' : fmtCountdown(view.nextFireMs, nowMs)}</span>
        <span>· <span className={css.mono}>{scheduleText(job)}</span></span>
      </>
    )
  }

  return (
    <div className={cx(css.job, orphan && css.jobOrphan, archived && css.jobArchived)}>
      <div className={css.jobHead} onClick={props.onToggleExpand} role="button" tabIndex={0}
        onKeyDown={event => { if (event.key === 'Enter') props.onToggleExpand() }}>
        <span className={cx(css.dot, dotClass(statusDotClass(view)))} aria-hidden />
        <div className={css.jobMain}>
          <div className={css.jobName}>
            {job.name}
            {orphan
              ? <span className={cx(css.chip, css.chipOrphan)}>plugin gone</span>
              : <span className={cx(css.chip, (css as Record<string, string>)[`chip${job.source.charAt(0).toUpperCase()}${job.source.slice(1)}`])}>{job.source}</span>}
            <span className={cx(css.chip, css.chipKind)}>{KIND_LABEL[job.task.kind] ?? job.task.kind}</span>
            {job.agentPreset !== undefined && <span className={cx(css.chip, css.chipKind)}>🤖 {job.agentPreset}</span>}
            {job.model !== undefined && <span className={cx(css.chip, css.chipKind)}>{job.model.model}{job.model.reasoningEffort !== undefined ? `·${job.model.reasoningEffort}` : ''}</span>}
            {archived && <span className={cx(css.chip, css.chipKind)}>已归档</span>}
          </div>
          <div className={css.jobSub}>{subtitle}</div>
        </div>
        <div className={css.jobActions} onClick={event => event.stopPropagation()}>
          {view.running === null && !orphan && !archived && (
            <button className={css.iconBtn} type="button" title="立即运行" onClick={props.onRunNow}><Play size={13} /></button>
          )}
          {view.running !== null && (
            <button className={css.iconBtn} type="button" title="停止本次运行" onClick={props.onStop}><Square size={12} /></button>
          )}
          <span className={css.menuAnchor}>
            <button className={css.iconBtn} type="button" title="更多" onClick={props.onToggleMenu}>⋯</button>
            {props.menuOpen && (
              <div className={css.menu} onClick={props.onCloseMenu}>
                {view.running === null && !archived && <button type="button" onClick={props.onRunNow}>▶ 立即运行</button>}
                {view.running !== null && <button type="button" onClick={props.onStop}>⏹ 停止本次运行</button>}
                {!archived && <button type="button" onClick={props.onToggleEnabled}>{job.enabled ? '⏸ 暂停调度' : '▶ 恢复调度'}</button>}
                {!readonly && <button type="button" onClick={props.onEdit}>✏️ 编辑任务</button>}
                {(!readonly || orphan) && (
                  <button
                    type="button"
                    className={props.pendingDelete ? cx(css.menuDanger, css.menuDangerConfirm) : css.menuDanger}
                    onClick={props.pendingDelete ? props.onDelete : props.onNeedConfirmDelete}
                  >
                    🗑 {props.pendingDelete ? '确认删除(含历史)' : '删除任务'}
                  </button>
                )}
                {readonly && !orphan && <button type="button" disabled>🔒 只读({job.source})</button>}
              </div>
            )}
          </span>
        </div>
      </div>

      {expanded && (
        <div className={css.history}>
          <div className={css.historyTitle}>运行历史 · {runCount}</div>
          {view.running !== null && (
            <button type="button" className={css.runRow} onClick={() => props.onOpenRun({
              jobId: job.id,
              seq: view.running!.seq,
              targetMs: view.running!.targetMs,
              startedAt: view.running!.startedAt,
              status: 'running',
              summary: '执行中…',
            })}>
              <span className={cx(css.runSt, css.stRunning)}>running</span>
              <span className={css.runTime}>{fmtDateTime(view.running.targetMs)}</span>
              <span className={css.runTime}>{fmtDuration(nowMs - view.running.startedAt)}</span>
              <span className={css.runSum}>执行中…(点击查看详情)</span>
            </button>
          )}
          {view.runs.map(run => (
            <button type="button" key={run.seq} className={css.runRow} onClick={() => props.onOpenRun(run)}>
              <span className={cx(css.runSt, (css as Record<string, string>)[RUN_ST_CLASS[run.status]])}>{STATUS_LABEL[run.status]}</span>
              <span className={css.runTime}>{fmtDateTime(run.targetMs)}</span>
              {run.finishedAt !== undefined && <span className={css.runTime}>{fmtDuration(run.finishedAt - run.startedAt)}</span>}
              <span className={css.runSum}>{run.summary ?? run.error ?? ''}</span>
              {run.sessionId !== undefined && <span className={css.runJump}>↗ 会话</span>}
            </button>
          ))}
          {runCount === 0 && <div className={css.emptyNote}>暂无历史</div>}
        </div>
      )}
    </div>
  )
}
