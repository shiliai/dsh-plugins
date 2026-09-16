/**
 * Right-column run detail (prototype's run-detail page): stat cards, argv,
 * summary, output tail, delivery outcome. Agent runs whose session still
 * exists jump straight to native replay instead; this view covers command
 * runs and any run without a live session.
 * @module @dsh-plugins/dsh-cron/client/RunDetail
 */

import css from './styles.module.css?dsh-inline'
import { fmtDateTime, fmtDuration, STATUS_LABEL } from './format.ts'
import type { ClientJobView, ClientRun } from './types.ts'

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function statusColor(status: string): string | undefined {
  if (status === 'ok') return css.okText
  if (status === 'failed') return css.badText
  if (status === 'killed' || status === 'aborted' || status === 'timeout') return css.warnText
  return undefined
}

export function RunDetail(props: { view: ClientJobView; run: ClientRun; nowMs: number }): JSX.Element {
  const { run, view } = props
  const job = view.job
  const running = run.status === 'running'
  return (
    <div className={css.detail}>
      <div className={css.detailGrid}>
        <div className={css.statCard}><div className={css.k}>状态</div><div className={cx(css.v, statusColor(run.status))}>{STATUS_LABEL[run.status]}</div></div>
        <div className={css.statCard}><div className={css.k}>计划时刻 target</div><div className={cx(css.v, css.vMono)}>{fmtDateTime(run.targetMs)}</div></div>
        <div className={css.statCard}><div className={css.k}>开始</div><div className={cx(css.v, css.vMono)}>{fmtDateTime(run.startedAt)}</div></div>
        <div className={css.statCard}><div className={css.k}>结束</div><div className={cx(css.v, css.vMono)}>{run.finishedAt === undefined ? '—' : fmtDateTime(run.finishedAt)}</div></div>
        <div className={css.statCard}><div className={css.k}>耗时</div><div className={css.v}>{running ? fmtDuration(props.nowMs - run.startedAt) : run.finishedAt === undefined ? '—' : fmtDuration(run.finishedAt - run.startedAt)}</div></div>
        {run.exitCode !== undefined && (
          <div className={css.statCard}><div className={css.k}>退出码</div><div className={cx(css.v, css.vMono, run.exitCode === 0 ? css.okText : css.badText)}>{run.exitCode}</div></div>
        )}
      </div>

      {run.sessionId !== undefined && (
        <div className={css.hint}>会话 <span className={css.mono}>{run.sessionId}</span>{job.task.kind === 'agent' ? '(在左侧历史点击 ↗ 可打开原生会话回放)' : ''}</div>
      )}
      {run.argv !== undefined && run.argv.length > 0 && (
        <>
          <div className={css.sectionLabel}>argv</div>
          <div className={cx(css.outputTail, css.mono)}>$ {run.argv.join(' ')}</div>
        </>
      )}
      <div className={css.sectionLabel}>摘要</div>
      <div className={css.outputTail} style={{ maxHeight: 'none' }}>{run.summary ?? '—'}</div>
      {run.error !== undefined && (
        <>
          <div className={css.sectionLabel}>错误</div>
          <div className={cx(css.outputTail, css.badText)}>{run.error}</div>
        </>
      )}
      {run.outputTail !== undefined && (
        <>
          <div className={css.sectionLabel}>输出尾部(截断保存)</div>
          <div className={css.outputTail}>{run.outputTail}</div>
        </>
      )}
      {run.delivery !== undefined && (
        <>
          <div className={css.sectionLabel}>投递(delivery)</div>
          <div className={css.outputTail}>exit {run.delivery.exitCode}{run.delivery.outputTail !== undefined ? `\n${run.delivery.outputTail}` : ''}</div>
        </>
      )}
    </div>
  )
}
