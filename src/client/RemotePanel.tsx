import { useEffect, useState } from 'react'
import { Check, Copy, RefreshCw, RotateCcw, X } from 'lucide-react'
import type { RemoteStatus } from '../contracts.ts'
import { remoteApi } from './api.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  close(): void
}

export function RemotePanel({ close }: Props) {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rotating, setRotating] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await remoteApi.status())
      setError(null)
    } catch {
      setError('Remote status is unavailable.')
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 10_000)
    return () => { window.clearInterval(timer) }
  }, [])

  const copy = async (): Promise<void> => {
    if (status === null) return
    try {
      await navigator.clipboard.writeText(status.accessUrl)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1500)
    } catch {
      setError('Private link could not be copied.')
    }
  }

  const rotate = async (): Promise<void> => {
    setRotating(true)
    try {
      setStatus(await remoteApi.rotate())
      setError(null)
      setConfirming(false)
    } catch {
      setError('Remote link could not be rotated.')
    } finally {
      setRotating(false)
    }
  }

  const reconnect = async (): Promise<void> => {
    try {
      setStatus(await remoteApi.reconnect())
      setError(null)
    } catch {
      setError('Tunnel reconnect could not start.')
    }
  }

  return (
    <section className={css.panel} aria-label="Remote access">
      <header className={css.header}>
        <strong>Remote access</strong>
        <button className={css.iconButton} type="button" title="Close remote access" aria-label="Close remote access" onClick={close}><X size={16} /></button>
      </header>
      <div className={css.statusRow}>
        <span className={`${css.indicator} ${status === null ? css.unknown : css[status.tunnel.phase]}`} aria-hidden="true" />
        <span>{status?.tunnel.phase ?? 'checking'}</span>
        <span className={css.detail}>{status?.tunnel.reason ?? ''}</span>
      </div>
      <div className={css.actions}>
        <button className={css.iconButton} type="button" title="Copy private link" aria-label="Copy private link" disabled={status === null} onClick={() => { void copy() }}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <button className={css.iconButton} type="button" title="Reconnect tunnel" aria-label="Reconnect tunnel" onClick={() => { void reconnect() }}><RefreshCw size={16} /></button>
        <button className={css.rotateButton} type="button" onClick={() => { setConfirming(true) }}><RotateCcw size={15} />Rotate</button>
      </div>
      {confirming && (
        <section className={css.confirmation} role="alertdialog" aria-label="Rotate remote link confirmation">
          <span>Rotate remote link?</span>
          <div className={css.confirmationActions}>
            <button className={css.iconButton} type="button" title="Cancel rotation" aria-label="Cancel rotation" autoFocus onClick={() => { setConfirming(false) }}><X size={15} /></button>
            <button className={css.rotateButton} type="button" disabled={rotating} onClick={() => { void rotate() }}><RotateCcw size={15} />Rotate</button>
          </div>
        </section>
      )}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </section>
  )
}
