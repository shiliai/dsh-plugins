/**
 * The dsh-cron overlay panel (shell.overlay): left column with the job list
 * (search, live clock badge), right column with the welcome view or a run
 * detail, plus the create/edit modal and toasts. State polls /state every
 * 3 s; the wall clock re-renders every second for countdowns and elapsed
 * timers.
 * @module @dsh-plugins/dsh-cron/client/CronPanel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Plus, X } from 'lucide-react'
import { cronApi } from './api.ts'
import { JobCard } from './JobCard.tsx'
import { JobModal } from './JobModal.tsx'
import { RunDetail } from './RunDetail.tsx'
import { fmtClock, fmtDateTime, fmtDuration } from './format.ts'
import css from './styles.module.css?dsh-inline'
import { PLUGIN_VERSION } from '../version.ts'
import type { ClientCatalog, ClientJobView, ClientRun, ClientState } from './types.ts'

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export interface CronPanelProps {
  close(): void
  /** Client runtime session navigation (native replay). */
  openSession?(id: string): void
}

interface ToastItem {
  id: number
  message: string
  kind: '' | 'ok' | 'err'
}

export function CronPanel(props: CronPanelProps): JSX.Element {
  const [state, setState] = useState<ClientState | null>(null)
  const [catalog, setCatalog] = useState<ClientCatalog | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [menuJobId, setMenuJobId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [modalFor, setModalFor] = useState<'new' | ClientJobView | null>(null)
  const [detailRun, setDetailRun] = useState<{ jobId: string; seq: number } | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const toastSeq = useRef(0)

  const pushToast = useCallback((message: string, kind: '' | 'ok' | 'err' = '') => {
    const id = ++toastSeq.current
    setToasts(prev => [...prev, { id, message, kind }])
    window.setTimeout(() => setToasts(prev => prev.filter(toast => toast.id !== id)), 4200)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await cronApi.state()
      setState(next)
      setLoadError(null)
    } catch {
      setLoadError('定时任务服务不可用。')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const poll = window.setInterval(() => { void refresh() }, 3_000)
    const tick = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
    }
  }, [refresh])

  useEffect(() => {
    if (modalFor === null || catalog !== null) return
    void cronApi.catalog().then(loaded => setCatalog(loaded)).catch(() => setCatalog({ models: [], agentPresets: [], permissionPresets: [] }))
  }, [modalFor, catalog])

  // Close any open ⋯ menu on outside click.
  useEffect(() => {
    if (menuJobId === null) return
    const close = (): void => setMenuJobId(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuJobId])

  const act = useCallback(async (action: () => Promise<unknown>, success: string, failureKind: '' | 'err' = 'err') => {
    try {
      await action()
      await refresh()
      if (success) pushToast(success, 'ok')
      return true
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '操作失败', failureKind)
      return false
    }
  }, [pushToast, refresh])

  const viewFor = useCallback((jobId: string): ClientJobView | undefined => state?.jobs.find(view => view.job.id === jobId), [state])

  const detailView = useMemo(() => {
    if (detailRun === null || state === null) return null
    const view = state.jobs.find(candidate => candidate.job.id === detailRun.jobId)
    if (view === undefined) return null
    const run = view.runs.find(candidate => candidate.seq === detailRun.seq)
      ?? (view.running !== null && view.running.seq === detailRun.seq
        ? { jobId: view.job.id, seq: view.running.seq, targetMs: view.running.targetMs, startedAt: view.running.startedAt, status: 'running' as const, summary: '执行中…' }
        : undefined)
    return run === undefined ? null : { view, run }
  }, [detailRun, state])

  const openRun = useCallback((view: ClientJobView, run: ClientRun) => {
    if (view.job.task.kind === 'agent' && run.sessionId !== undefined && props.openSession !== undefined) {
      try {
        props.openSession(run.sessionId)
        pushToast(`已打开 ${view.job.name} #${run.seq} 的会话回放`, 'ok')
        props.close()
        return
      } catch {
        // Not in the client's session list (attach failed or list stale) —
        // fall through to the run detail instead of dying silently.
        pushToast('会话暂未出现在界面列表,已显示运行详情', 'err')
      }
    }
    setDetailRun({ jobId: view.job.id, seq: run.seq })
  }, [props, pushToast])

  const visibleJobs = useMemo(() => {
    const jobs = state?.jobs ?? []
    const query = search.trim().toLowerCase()
    const filtered = query === '' ? jobs : jobs.filter(view => view.job.name.toLowerCase().includes(query))
    // Archived/orphans sink to the bottom, mirroring the prototype.
    return [...filtered].sort((a, b) => weight(a) - weight(b))
  }, [state, search])

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <section className={css.panel} aria-label="定时任务 Cron Jobs">
      <aside className={css.sidebar}>
        <div className={css.sidebarTop}>
          <div className={css.panelTitle}>
            <span className={css.clockIco}><Clock size={15} strokeWidth={2.2} /></span>
            <h2>定时任务<small>Cron Jobs</small></h2>
            <button className={css.iconBtn} type="button" title="新建任务" onClick={() => setModalFor('new')}><Plus size={15} strokeWidth={2.4} /></button>
            <button className={css.iconBtn} type="button" title="关闭" onClick={props.close}><X size={15} /></button>
          </div>
        </div>
        <div className={css.search}>
          <input type="text" placeholder="搜索任务…" value={search} onChange={event => setSearch(event.target.value)} />
        </div>
        <div className={css.jobList}>
          {loadError !== null && <div className={css.emptyNote}>{loadError}</div>}
          {loadError === null && visibleJobs.length === 0 && <div className={css.emptyNote}>没有任务。点右上角 ＋ 创建。</div>}
          {visibleJobs.map(view => (
            <JobCard
              key={view.job.id}
              view={view}
              nowMs={nowMs}
              expanded={expandedIds.has(view.job.id)}
              pendingDelete={pendingDeleteId === view.job.id}
              menuOpen={menuJobId === view.job.id}
              onToggleExpand={() => toggleExpand(view.job.id)}
              onToggleMenu={() => setMenuJobId(current => current === view.job.id ? null : view.job.id)}
              onCloseMenu={() => setMenuJobId(null)}
              onRunNow={() => { void act(() => cronApi.runNow(view.job.id), `已手动触发 ${view.job.name}`); setExpandedIds(prev => new Set(prev).add(view.job.id)) }}
              onStop={() => { void act(() => cronApi.stop(view.job.id), '本次运行已停止,记录为 killed') }}
              onToggleEnabled={() => { void act(() => view.job.enabled ? cronApi.disable(view.job.id) : cronApi.enable(view.job.id), `${view.job.name}:${view.job.enabled ? '已暂停调度' : '已恢复调度'}`) }}
              onEdit={() => { setMenuJobId(null); setModalFor(view) }}
              onDelete={() => {
                if (pendingDeleteId !== view.job.id) {
                  setPendingDeleteId(view.job.id)
                  return
                }
                setPendingDeleteId(null)
                void act(async () => { await cronApi.remove(view.job.id); if (detailRun?.jobId === view.job.id) setDetailRun(null) }, `已删除 ${view.job.name}(含全部运行历史)`)
              }}
              onNeedConfirmDelete={() => { setPendingDeleteId(view.job.id); pushToast('再次点击菜单中的删除以确认(含全部运行历史)', 'err') }}
              onOpenRun={run => openRun(view, run)}
            />
          ))}
        </div>
        <div className={css.foot}>
          <button className={css.clockBadge} type="button" title={`调度 tick ${state?.tickIntervalMs ?? 15000}ms · 时钟纪律:每次唤醒重读墙钟`} onClick={() => pushToast(`调度器运行中 · tick ${state?.tickIntervalMs ?? 15000}ms · 服务器时间 ${state === null ? '—' : fmtDateTime(state.serverTimeMs)}`, 'ok')}>
            <Clock size={13} strokeWidth={2.2} />
            <span>{fmtClock(nowMs)}</span>
            <span className={css.tz}>{BROWSER_TZ}</span>
          </button>
          <span className={css.footHint}>dsh-cron v{PLUGIN_VERSION}</span>
        </div>
      </aside>

      <main className={css.center}>
        <div className={css.centerHead}>
          <h1>{detailView !== null ? `${detailView.view.job.name} · 运行 #${detailView.run.seq}` : 'dsh-cron · 宿主侧定时任务调度器'}</h1>
          <span className={css.sub}>{detailView !== null ? `${detailView.view.job.task.kind} 任务运行详情` : '无人值守 · 与会话无关 · 点任务行展开运行历史'}</span>
        </div>
        <div className={css.centerBody}>
          {detailView === null ? (
            <div className={css.welcome}>
              <h2>⏱ dsh-cron</h2>
              <p>宿主侧无人值守定时任务:进程存活期间按计划自动触发。任务与任何交互会话无关,每次运行产出一条可追溯的运行记录。</p>
              <div className={css.hintGrid}>
                <div className={css.hintCard}><b>＋ 新建任务</b>触发预设(每小时/每天/工作日/每周)+ 自定义层(cron / 间隔 / 一次性),时区静默取浏览器;循环任务必须设置有效期窗口。</div>
                <div className={css.hintCard}><b>行内 ⋯ 菜单</b>立即运行 / 停止 / 暂停恢复 / 编辑 / 删除(manual 两次点击确认)。非 manual 来源只读。</div>
                <div className={css.hintCard}><b>点击 agent 运行记录</b>打开该次运行的原生会话回放(含 [CRON RUN] framing)。</div>
                <div className={css.hintCard}><b>点击 command 运行记录</b>打开运行详情:状态 / 时长 / 退出码 / argv / 输出尾。</div>
                <div className={css.hintCard}><b>可靠性语义</b>at-most-once、overlap skip/queue/replace、misfire skip/runOnce、崩溃后 running 记录修复为 aborted。</div>
                <div className={css.hintCard}><b>会话内工具</b>对任意 agent 说「创建一个定时任务…」即可走 cron_create / cron-create 技能流程。</div>
              </div>
              {state !== null && state.jobs.length > 0 && (
                <p style={{ marginTop: 14 }}>最近活动:{latestLine(state, nowMs)}</p>
              )}
            </div>
          ) : (
            <RunDetail
              view={detailView.view}
              run={detailView.run}
              nowMs={nowMs}
              onOpenSession={detailView.run.sessionId !== undefined && props.openSession !== undefined
                ? () => openRun(detailView.view, detailView.run)
                : undefined}
            />
          )}
        </div>
      </main>

      {modalFor !== null && (
        <JobModal
          editing={modalFor === 'new' ? null : modalFor}
          catalog={catalog}
          onClose={() => setModalFor(null)}
          onSaved={(_view, created) => {
            setModalFor(null)
            void refresh()
            pushToast(created ? '任务已创建并启用' : '任务已保存', 'ok')
          }}
          pushToast={pushToast}
        />
      )}

      <div className={css.toasts}>
        {toasts.map(toast => (
          <div key={toast.id} className={[css.toast, toast.kind === 'ok' ? css.toastOk : '', toast.kind === 'err' ? css.toastErr : ''].filter(Boolean).join(' ')}>
            {toast.message}
          </div>
        ))}
      </div>
    </section>
  )
}

function weight(view: ClientJobView): number {
  if (view.job.archivedAt !== undefined) return 2
  if (view.job.source === 'plugin') return 1
  return 0
}

function latestLine(state: ClientState, nowMs: number): JSX.Element {
  const withRuns = state.jobs.filter(view => view.runs.length > 0 || view.running !== null)
  if (withRuns.length === 0) return <span>尚无运行记录。</span>
  const latest = withRuns.flatMap(view => view.running !== null
    ? [{ view, at: view.running.startedAt, label: '运行中' }]
    : view.runs.slice(0, 1).map(run => ({ view, at: run.finishedAt ?? run.startedAt, label: `${run.status}${run.summary !== undefined && run.summary !== '' ? ` · ${run.summary.slice(0, 60)}` : ''}` })))
    .sort((a, b) => b.at - a.at)[0]
  if (latest === undefined) return <span>尚无运行记录。</span>
  return <span className={css.mono}>{latest.view.job.name} · {latest.label} · {fmtDuration(nowMs - latest.at)}前</span>
}
