/**
 * Browser-side glue for the config-portability contract: a `window` registry
 * where every plugin client registers its API prefix, helpers to export /
 * import envelopes across all registered plugins, and a ready-made React
 * settings tab (`mountConfigPortabilityTab`) so joining plugins need zero UI
 * work of their own.
 */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { CONFIG_EXPORT_KIND, CONFIG_FORMAT_VERSION, parseEnvelope, type ConfigExportEnvelope } from './contracts.js'
import type { ImportOutcome } from './provider.js'

/** A plugin's client-side registration entry. */
export interface RegisteredPortabilityProvider {
  /** Stable plugin id (must match the server-side provider id). */
  id: string
  displayName: string
  /** Plugin API prefix the contract endpoints hang off, e.g. `/dsh-reading/api`. */
  apiPrefix: string
}

interface PortabilityWindowRegistry {
  providers: Map<string, RegisteredPortabilityProvider>
  tabMounted: boolean
}

declare global {
  interface Window {
    __DSH_CONFIG_PORTABILITY__?: PortabilityWindowRegistry
  }
}

/** Id of the shared settings tab (slot `settings.plugins.tab`). */
export const CONFIG_PORTABILITY_TAB_ID = 'dsh-config-portability'

function registry(): PortabilityWindowRegistry {
  const existing = typeof window !== 'undefined' ? window.__DSH_CONFIG_PORTABILITY__ : undefined
  if (existing !== undefined) return existing
  const created: PortabilityWindowRegistry = { providers: new Map(), tabMounted: false }
  if (typeof window !== 'undefined') window.__DSH_CONFIG_PORTABILITY__ = created
  return created
}

/** Register this plugin's client so the shared tab can discover its endpoints. */
export function registerPortabilityProvider(entry: RegisteredPortabilityProvider): void {
  registry().providers.set(entry.id, entry)
}

/** Snapshot of all registered providers. */
export function listPortabilityProviders(): RegisteredPortabilityProvider[] {
  return [...registry().providers.values()]
}

export interface ExportAllOptions {
  redact: boolean
  /** Defaults to every registered provider. */
  providers?: RegisteredPortabilityProvider[]
}

/** Export one plugin's envelope via its contract endpoint. */
export async function exportProviderEnvelope(apiPrefix: string, redact: boolean): Promise<ConfigExportEnvelope> {
  const response = await fetch(`${apiPrefix}/config/export${redact ? '?redact=1' : ''}`)
  if (!response.ok) {
    throw new Error(await errorMessage(response, '导出配置失败'))
  }
  return parseEnvelope(await response.json())
}

/** Export all registered plugins and merge their sections into one envelope. */
export async function exportAllProviders(options: ExportAllOptions): Promise<ConfigExportEnvelope> {
  const providers = options.providers ?? listPortabilityProviders()
  if (providers.length === 0) throw new Error('没有已注册的可迁移配置。')
  const envelopes = await Promise.all(providers.map(provider => exportProviderEnvelope(provider.apiPrefix, options.redact)))
  return mergeClientEnvelopes(envelopes)
}

export interface ProviderImportResult {
  id: string
  displayName: string
  ok: boolean
  status: number
  dryRun: boolean
  report?: ImportOutcome
  error?: string
}

/** Push an envelope to one plugin's import endpoint. */
export async function importProviderEnvelope(apiPrefix: string, id: string, displayName: string, envelope: ConfigExportEnvelope, dryRun: boolean): Promise<ProviderImportResult> {
  const response = await fetch(`${apiPrefix}/config/import${dryRun ? '?dryRun=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  if (!response.ok) return { id, displayName, ok: false, status: response.status, dryRun, error: await errorMessage(response, '导入失败') }
  const payload = await response.json() as { ok?: unknown; dryRun?: unknown; report?: ImportOutcome }
  const report = payload.report
  return {
    id,
    displayName,
    ok: payload.ok === true,
    status: response.status,
    dryRun: payload.dryRun === true || dryRun,
    ...(report === undefined ? {} : { report }),
  }
}

/** Push an envelope to every registered plugin (each picks its own section). */
export async function importEnvelopeEverywhere(envelope: ConfigExportEnvelope, dryRun: boolean, providers?: RegisteredPortabilityProvider[]): Promise<ProviderImportResult[]> {
  const targets = providers ?? listPortabilityProviders()
  if (targets.length === 0) throw new Error('没有已注册的可迁移配置。')
  return Promise.all(targets.map(provider => importProviderEnvelope(provider.apiPrefix, provider.id, provider.displayName, envelope, dryRun)))
}

/** Trigger a browser download of the envelope as a `.json` file. */
export function downloadJson(envelope: ConfigExportEnvelope, fileName: string = `dsh-config-export-${new Date().toISOString().slice(0, 10)}.json`): void {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') return body.error
  } catch { /* keep fallback */ }
  return `${fallback} (${response.status})`
}

/** Client-side envelope merge — mirrors the server contract (later wins, earliest exportedAt). */
function mergeClientEnvelopes(envelopes: ConfigExportEnvelope[]): ConfigExportEnvelope {
  const plugins: ConfigExportEnvelope['plugins'] = {}
  let exportedAt: string | undefined
  for (const envelope of envelopes) {
    for (const [id, section] of Object.entries(envelope.plugins)) plugins[id] = section
    if (exportedAt === undefined || envelope.exportedAt < exportedAt) exportedAt = envelope.exportedAt
  }
  return { kind: CONFIG_EXPORT_KIND, formatVersion: CONFIG_FORMAT_VERSION, exportedAt: exportedAt ?? new Date().toISOString(), plugins }
}

/**
 * Mount the shared「配置迁移」settings tab once per window. Multiple plugins
 * may call this; only the first mount wins (tracked on the window registry).
 */
export function mountConfigPortabilityTab(ctx: unknown): void {
  const state = registry()
  if (state.tabMounted) return
  const slots = (ctx as { slots?: { register(meta: unknown, component: unknown): unknown } } | undefined)?.slots
  if (slots === undefined) return
  state.tabMounted = true
  slots.register(
    { name: 'settings.plugins.tab', id: CONFIG_PORTABILITY_TAB_ID, order: 900, label: '配置迁移', inject: () => ({}) },
    ConfigPortabilityTab,
  )
}

const cardStyle: CSSProperties = { border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: 16, marginBottom: 16 }
const mutedStyle: CSSProperties = { opacity: 0.72, fontSize: 13, lineHeight: 1.7, marginTop: 4 }
const buttonStyle: CSSProperties = { padding: '6px 14px', cursor: 'pointer' }

function ReportList({ results }: { results: ProviderImportResult[] }): ReactElement {
  return (
    <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.8 }}>
      {results.map(result => (
        <div key={result.id} style={{ marginBottom: 8 }}>
          <strong>{result.displayName}</strong>{' '}
          {result.ok
            ? <span style={{ opacity: 0.8 }}>{result.dryRun ? '预检通过' : '已导入'}</span>
            : <span style={{ color: '#c0392b' }}>失败：{result.error ?? `HTTP ${result.status}`}</span>}
          {result.report !== undefined && (
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {result.report.applied.length > 0 && <li>已应用：{result.report.applied.join('、')}</li>}
              {result.report.skipped.length > 0 && <li>已跳过：{result.report.skipped.join('、')}</li>}
              {result.report.warnings.map((warning, index) => <li key={index} style={{ opacity: 0.75 }}>{warning}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

/** Shared「配置迁移」settings tab: export all registered plugins, import an envelope file. */
export function ConfigPortabilityTab(): ReactElement {
  const [providers, setProviders] = useState<RegisteredPortabilityProvider[]>([])
  const [includeSecrets, setIncludeSecrets] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<ProviderImportResult[] | null>(null)
  const [pendingEnvelope, setPendingEnvelope] = useState<ConfigExportEnvelope | null>(null)

  useEffect(() => { setProviders(listPortabilityProviders()) }, [])

  const runExport = async (): Promise<void> => {
    setBusy(true); setMessage(null)
    try {
      const envelope = await exportAllProviders({ redact: !includeSecrets })
      downloadJson(envelope)
      setMessage(`已导出 ${Object.keys(envelope.plugins).length} 个插件的配置${includeSecrets ? '（含明文凭据）' : '（凭据已脱敏）'}。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const onFilePicked = async (file: File | undefined): Promise<void> => {
    setPreview(null); setPendingEnvelope(null); setMessage(null)
    if (file === undefined) return
    try {
      const envelope = parseEnvelope(JSON.parse(await file.text()))
      setPendingEnvelope(envelope)
      setBusy(true)
      const results = await importEnvelopeEverywhere(envelope, true)
      setPreview(results)
      setMessage('预检完成。确认无误后点击「确认导入」写入配置。')
    } catch (error) {
      setMessage(`文件无法作为配置迁移信封解析：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const confirmImport = async (): Promise<void> => {
    if (pendingEnvelope === null) return
    setBusy(true); setMessage(null)
    try {
      const results = await importEnvelopeEverywhere(pendingEnvelope, false)
      setPreview(results)
      setMessage('导入完成，配置已即时生效。')
      setPendingEnvelope(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <h2 style={{ margin: '0 0 8px' }}>配置迁移</h2>
      <p style={mutedStyle}>将各插件的配置（数据源、用户设置）导出为一个 JSON 文件，在另一台电脑的 DSH 上一键导入。导出内容不含书籍文件、阅读进度与批注。</p>
      {providers.length === 0 && <p style={mutedStyle}>当前没有支持配置迁移的插件。</p>}
      {providers.length > 0 && (
        <p style={mutedStyle}>支持插件：{providers.map(provider => provider.displayName).join('、')}</p>
      )}

      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 8px' }}>导出</h3>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
          <input type="checkbox" checked={includeSecrets} onChange={event => setIncludeSecrets(event.target.checked)} />
          包含敏感凭据（明文）
        </label>
        {includeSecrets && <p style={{ ...mutedStyle, color: '#c0392b' }}>警告：导出文件将以明文包含 Wallabag 等服务的密码，请妥善保管，不要通过不可信渠道传输。</p>}
        {!includeSecrets && <p style={mutedStyle}>脱敏导出后，新机器导入时对应数据源会被跳过，需要手动重新填写凭据。</p>}
        <button type="button" style={buttonStyle} disabled={busy || providers.length === 0} onClick={() => void runExport()}>导出配置</button>
      </div>

      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 8px' }}>导入</h3>
        <p style={mutedStyle}>选择之前导出的 JSON 文件。系统会先做预检（不写入），确认后再真正导入并即时生效。</p>
        <input type="file" accept="application/json,.json" disabled={busy} onChange={event => void onFilePicked(event.target.files?.[0])} />
        {preview !== null && <ReportList results={preview} />}
        {pendingEnvelope !== null && (
          <button type="button" style={{ ...buttonStyle, marginTop: 12 }} disabled={busy} onClick={() => void confirmImport()}>确认导入</button>
        )}
      </div>

      {message !== null && <p style={{ ...mutedStyle }}>{message}</p>}
    </div>
  )
}
