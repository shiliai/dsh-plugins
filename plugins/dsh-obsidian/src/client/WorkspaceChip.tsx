/** Workspace-consistency chip for the workbench header (docs design §6). */

import { useState } from 'react'
import AlertTriangle from 'lucide-react/dist/esm/icons/alert-triangle'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle'
import type { WorkspaceStatus } from './workspace-status.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  status: WorkspaceStatus
  vaultName: string
  vaultRoot: string
  /** Land the current blank conversation in the vault workspace, or open a new vault conversation. */
  openVaultConversation(): Promise<void>
}

const CHIP_LABEL: Record<WorkspaceStatus['state'], string> = {
  vault: '对话在 Vault 工作区',
  other: '对话在其他工作区',
  unknown: '工作区未知',
}

export function WorkspaceChip({ status, vaultName, vaultRoot, openVaultConversation }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // §6.5: no current conversation → no chip (nothing to describe).
  if (status.currentSessionId === undefined) return null

  const className = status.state === 'vault' ? css.chipOk : status.state === 'other' ? css.chipWarn : css.chipUnknown
  const label = status.state === 'other' && status.vaultWorkspace !== undefined
    ? `对话在 ${status.vaultWorkspace.title} 工作区`
    : CHIP_LABEL[status.state]
  const migrateLabel = status.sessionBlank === false ? '在 Vault 中新开对话' : '迁移本对话到 Vault'
  const migrate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      await openVaultConversation()
      setResult({ kind: 'success', text: `已切换到 Vault 工作区 — 生成的文件将保存到 ${vaultName}` })
    } catch (error) {
      setResult({ kind: 'error', text: error instanceof Error ? error.message : '无法进入 Vault 工作区。' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.chipWrap}>
      <button
        className={`${css.chip} ${className}`}
        type="button"
        role={status.state === 'other' ? 'status' : undefined}
        aria-label={label}
        aria-expanded={open}
        disabled={status.state === 'unknown'}
        onClick={() => { setOpen(value => !value) }}
      >
        {status.state === 'vault' && <span className={css.chipDot} aria-hidden />}
        {status.state === 'other' && <AlertTriangle size={12} aria-hidden />}
        <span>{label}</span>
      </button>
      {open && status.state !== 'unknown' && (
        <div className={css.chipPopover} role="dialog" aria-label="工作区详情">
          <div className={css.chipRow}><span>当前对话</span><strong>{status.sessionTitle ?? status.currentSessionId}</strong></div>
          <div className={css.chipRow}><span>对话工作区</span><span title={status.sessionCwd}>{status.sessionCwd !== undefined ? status.sessionCwd : '未知'}</span></div>
          <div className={css.chipRow}><span>Vault</span><span title={vaultRoot}>{vaultName} · {vaultRoot}</span></div>
          {status.state === 'other' && (
            <div className={css.chipWarnLine} role="alert">
              {status.sessionBlank === false
                ? '该对话已有内容:在本模式里生成的文件将保存到当前工作区,而不会进入 Vault。'
                : '该对话的文件不会写入 Vault。'}
            </div>
          )}
          {result !== null && <div className={result.kind === 'success' ? css.chipResultOk : css.chipResultError} role={result.kind === 'success' ? 'status' : 'alert'}>{result.text}</div>}
          {status.state === 'other' && (
            <>
              <div className={css.chipActions}>
                <button className={css.chipPrimary} type="button" disabled={busy} onClick={() => { void migrate() }}>
                  {busy ? <LoaderCircle className={css.spin} size={13} aria-hidden /> : null}
                  {migrateLabel}
                </button>
                <button className={css.chipGhost} type="button" onClick={() => { setOpen(false) }}>知道了</button>
              </div>
              <div className={css.chipHint}>
                {status.sessionBlank === false
                  ? '进行中的对话无法迁移工作区;新开的 Vault 对话中,生成的文件将保存到 Vault。'
                  : '迁移后,生成的文件将保存到 Vault。'}
              </div>
            </>
          )}
          {status.state === 'vault' && (
            <div className={css.chipActions}>
              <button className={css.chipGhost} type="button" onClick={() => { setOpen(false) }}>关闭</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
