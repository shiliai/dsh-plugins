/**
 * Right-column run detail (prototype's run-detail page): stat cards (status,
 * trigger, model, times, tokens), argv, summary, output tail, delivery
 * outcome, and the native-replay jump for runs whose session is still listed.
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

function fmtNumber(value: number): string {
  return value.toLocaleString('en-US')
}

export interface RunDetailProps {
  view: ClientJobView
  run: ClientRun
  nowMs: number
  /** Present when the run has a session and the client runtime can open it. */
  onOpenSession?: (() => void) | undefined
}

export function RunDetail(props: RunDetailProps): JSX.Element {
  const { run } = props
  const running = run.status === 'running'
  const usage = run.usage
  const usageTotal = usage === undefined
    ? undefined
    : (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
  return (
    <div className={css.detail}>
      <div className={css.detailGrid}>
        <div className={css.statCard}><div className={css.k}>状态</div><div className={cx(css.v, statusColor(run.status))}>{STATUS_LABEL[run.status]}</div></div>
        <div className={css.statCard}><div className={css.k}>触发</div><div className={css.v}>{run.trigger === undefined ? '—' : run.trigger === 'manual' ? '手动' : '计划'}</div></div>
        <div className={css.statCard}><div className={css.k}>模型</div><div className={cx(css.v, css.vMono)}>{run.model ?? '—'}</div></div>
        <div className={css.statCard}><div className={css.k}>计划时刻 target</div><div className={cx(css.v, css.vMono)}>{fmtDateTime(run.targetMs)}</div></div>
        <div className={css.statCard}><div className={css.k}>开始</div><div className={cx(css.v, css.vMono)}>{fmtDateTime(run.startedAt)}</div></div>
        <div className={css.statCard}><div className={css.k}>结束</div><div className={cx(css.v, css.vMono)}>{run.finishedAt === undefined ? '—' : fmtDateTime(run.finishedAt)}</div></div>
        <div className={css.statCard}><div className={css.k}>耗时</div><div className={css.v}>{running ? fmtDuration(props.nowMs - run.startedAt) : run.finishedAt === undefined ? '—' : fmtDuration(run.finishedAt - run.startedAt)}</div></div>
        {usage !== undefined && (
          <div className={css.statCard}>
            <div className={css.k}>tokens</div>
            <div className={cx(css.v, css.vMono)}>{fmtNumber(usageTotal ?? 0)}</div>
            <div className={css.k} style={{ marginTop: 2 }}>
              {([['输入', usage.inputTokens], ['输出', usage.outputTokens], ['缓存读', usage.cacheReadTokens], ['缓存写', usage.cacheWriteTokens], ['推理', usage.reasoningTokens]] as Array<[string, number | undefined]>)
                .filter((pair): pair is [string, number] => typeof pair[1] === 'number')
                .map(([label, value]) => `${label} ${fmtNumber(value)}`)
                .join(' · ')}
            </div>
          </div>
        )}
        {run.exitCode !== undefined && (
          <div className={css.statCard}><div className={css.k}>退出码</div><div className={cx(css.v, css.vMono, run.exitCode === 0 ? css.okText : css.badText)}>{run.exitCode}</div></div>
        )}
      </div>

      {run.sessionId !== undefined && (
        <div className={css.hint}>
          会话 <span className={css.mono}>{run.sessionId}</span>
          {props.onOpenSession !== undefined && (
            <>
              {' '}
              <button className={css.btn} type="button" onClick={props.onOpenSession}>↗ 打开会话回放</button>
            </>
          )}
        </div>
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
