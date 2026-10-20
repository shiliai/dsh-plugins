import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import Copy from 'lucide-react/dist/esm/icons/copy'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle'
import X from 'lucide-react/dist/esm/icons/x'
import { vaultApi } from './api.ts'
import { copyText } from './clipboard.ts'
import { formatBytes, formatTimestamp } from './format.ts'
import type { VaultEntryProperty } from '../contracts.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  /** Vault-relative path of the note or directory the dialog describes. */
  path: string
  close(): void
}

/**
 * Read-only properties of one vault entry: location, absolute path, size,
 * timestamps, permissions, and — for notes — text statistics and tags.
 *
 * It fetches its own data so every browser surface (sidebar, workbench) can
 * open it from the row context menu without plumbing extra state.
 */
export function EntryProperties({ path, close }: Props) {
  const [property, setProperty] = useState<VaultEntryProperty | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'relative' | 'absolute' | null>(null)

  useEffect(() => {
    let cancelled = false
    setProperty(null)
    setError(null)
    setCopied(null)
    void vaultApi.property(path).then(
      result => { if (!cancelled) setProperty(result) },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not read entry properties.') },
    )
    return () => { cancelled = true }
  }, [path])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [close])

  const copy = async (kind: 'relative' | 'absolute', value: string): Promise<void> => {
    try {
      await copyText(value)
      setCopied(kind)
      window.setTimeout(() => { setCopied(current => (current === kind ? null : current)) }, 1500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not copy the path.')
    }
  }

  return (
    <div
      className={css.modalOverlay}
      data-dsh-obsidian-properties=""
      onPointerDown={event => { if (event.target === event.currentTarget) close() }}
    >
      <section
        className={css.propertyCard}
        role="dialog"
        aria-modal="true"
        aria-label={`Properties of ${property?.name ?? path}`}
        onPointerDown={event => { event.stopPropagation() }}
      >
        <header className={css.propertyHeader}>
          <strong title={path}>{property?.name ?? path}</strong>
          {property !== null && <span className={css.propertyKind}>{property.kind === 'directory' ? 'Folder' : 'Note'}</span>}
          <button className={css.iconButton} type="button" title="Close (Esc)" aria-label="Close properties" onClick={close}><X size={15} /></button>
        </header>

        {property === null && error === null && (
          <div className={css.propertyLoading} role="status"><LoaderCircle className={css.spin} size={15} />Reading properties…</div>
        )}
        {error !== null && <div className={css.inlineError} role="alert">{error}</div>}

        {property !== null && (
          <dl className={css.propertyList}>
            <PropertyRow label="Location" value={property.path}>
              <CopyButton copied={copied === 'relative'} label="Copy relative path" onClick={() => { void copy('relative', property.path) }} />
            </PropertyRow>
            <PropertyRow label="Absolute path" value={property.absolutePath}>
              <CopyButton copied={copied === 'absolute'} label="Copy absolute path" onClick={() => { void copy('absolute', property.absolutePath) }} />
            </PropertyRow>
            <PropertyRow label="Size" value={formatBytes(property.size)} />
            <PropertyRow label="Created" value={formatTimestamp(property.createdMs)} />
            <PropertyRow label="Modified" value={formatTimestamp(property.modifiedMs)} />
            <PropertyRow label="Accessed" value={formatTimestamp(property.accessedMs)} />
            <PropertyRow label="Permissions" value={property.permissions} mono />
            {property.kind === 'note' ? (
              <>
                <PropertyRow label="Lines" value={formatCount(property.lines)} />
                <PropertyRow label="Words" value={formatCount(property.words)} />
                <PropertyRow label="Characters" value={formatCount(property.characters)} />
                <PropertyRow label="Tags" value={property.tags === undefined ? '—' : property.tags.length === 0 ? 'None' : property.tags.map(tag => `#${tag}`).join(' ')} />
              </>
            ) : (
              <>
                <PropertyRow label="Files" value={formatCount(property.files)} />
                <PropertyRow label="Subfolders" value={formatCount(property.directories)} />
              </>
            )}
          </dl>
        )}
      </section>
    </div>
  )
}

function PropertyRow({ label, value, mono, children }: {
  label: string
  value: string
  mono?: boolean
  children?: ReactNode
}) {
  return (
    <div className={css.propertyRow}>
      <dt>{label}</dt>
      <dd className={mono === true ? css.propertyMono : undefined} title={value}>{value}{children}</dd>
    </div>
  )
}

function CopyButton({ copied, label, onClick }: { copied: boolean; label: string; onClick(): void }) {
  return (
    <button className={css.iconButton} type="button" title={copied ? 'Copied' : label} aria-label={label} onClick={onClick}>
      <Copy size={13} />
    </button>
  )
}

function formatCount(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString()
}
