import { useEffect, useState } from 'react'
import { RefreshCw, RotateCcw, X } from 'lucide-react'
import type { WecomStatus } from '../lifecycle.ts'
import { wecomApi } from './api.ts'
import css from './styles.module.css?dsh-inline'

function date(value: number | undefined): string {
  return value === undefined ? 'Never' : new Date(value).toLocaleString()
}

export function WecomPanel({ close }: { close(): void }) {
  const [status, setStatus] = useState<WecomStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const refresh = async (): Promise<void> => {
    try { setStatus(await wecomApi.status()); setError(null) } catch { setError('WeCom status is unavailable.') }
  }
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2_000)
    return () => window.clearInterval(timer)
  }, [])
  const restart = async (): Promise<void> => {
    setRestarting(true)
    try { setStatus(await wecomApi.restart()); setError(null); setConfirming(false) } catch { setError('WeCom restart could not start.') } finally { setRestarting(false) }
  }
  const phase = status?.state ?? 'offline'
  return <section className={css.panel} aria-label="WeCom connection">
    <header className={css.header}><strong>WeCom connection</strong><button className={css.iconButton} type="button" title="Close WeCom connection" aria-label="Close WeCom connection" onClick={close}><X size={16} /></button></header>
    <div className={css.statusRow}><span className={`${css.indicator} ${css[phase]}`} aria-hidden="true" /><span className={css.phase}>{phase}</span></div>
    <dl className={css.details}>
      <div><dt>Changed</dt><dd>{date(status?.changedAt)}</dd></div>
      <div><dt>Authenticated</dt><dd>{date(status?.authenticatedAt)}</dd></div>
      <div><dt>Disconnected</dt><dd>{date(status?.disconnectedAt)}</dd></div>
      <div><dt>Bot</dt><dd>{status?.botIdentity ?? 'Not configured'}</dd></div>
      <div><dt>Version</dt><dd>{status?.version ?? 'Unknown'}</dd></div>
    </dl>
    {status?.error !== undefined && <div className={css.diagnostic} role="status">{status.error}</div>}
    <div className={css.actions}><button className={css.iconButton} type="button" title="Refresh status" aria-label="Refresh status" onClick={() => { void refresh() }}><RefreshCw size={16} /></button><button className={css.restartButton} type="button" disabled={restarting || status?.restarting === true} onClick={() => setConfirming(true)}><RotateCcw size={15} />Restart</button></div>
    {confirming && <section className={css.confirmation} role="alertdialog" aria-label="Restart WeCom confirmation"><span>Restarting resets process-local conversations.</span><div><button className={css.iconButton} type="button" title="Cancel restart" aria-label="Cancel restart" onClick={() => setConfirming(false)}><X size={15} /></button><button className={css.restartButton} type="button" disabled={restarting} onClick={() => { void restart() }}><RotateCcw size={15} />Restart</button></div></section>}
    {error !== null && <div className={css.error} role="alert">{error}</div>}
  </section>
}
