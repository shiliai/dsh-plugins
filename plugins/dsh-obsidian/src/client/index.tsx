import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useRef, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import NotebookTabs from 'lucide-react/dist/esm/icons/notebook-tabs'
import { NotePanel } from './NotePanel.tsx'
import { VaultBrowser } from './VaultBrowser.tsx'
import { VaultStore } from './store.ts'
import { vaultApi } from './api.ts'
import { appendVaultContext } from './context-reference.ts'
import { currentSessionIsBlank, landInVaultWorkspace, type VaultLandingContext } from './vault-landing.ts'
import { samePath, useWorkspaceStatus, vaultWorkspaceTitle, type WorkspaceStatusSource } from './workspace-status.ts'
import { pluginVersion } from './version.ts'
import type { VaultContextKind } from '../contracts.ts'
import { Workbench, type WorkbenchExitInfo } from './Workbench.tsx'
import { ThoughtsPanel } from './ThoughtsPanel.tsx'
import css from './styles.module.css?dsh-inline'
import { SkillBrowser } from './SkillBrowser.tsx'
import { WorkspaceRegistry } from '@dsh-plugins/dsh-reading-core'

// `uiWorkspace` is intentionally NOT declared here: `inject` entries are hard
// activation dependencies, so hosts without the service (dsh-client-runtime
// 0.1.0-rc.6) would park the whole plugin forever. Resolve it per call with
// `ctx.get('uiWorkspace')`, which returns undefined where it is absent.
export const inject = ['slots', 'layout', 'sessions', 'conversation', 'workspaces']

function ObsidianSkillsSettings({ store }: { store: VaultStore }) {
  const state = store.getSnapshot()
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <div style={{ padding: '8px 16px', fontSize: 12, opacity: .65, borderBottom: '1px solid rgba(127,127,127,.25)' }}>
      Obsidian skills <span style={{ opacity: .8 }}>v{pluginVersion}</span>
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      <SkillBrowser store={store} root={state.vaultRoot} closeBrowser={() => undefined} wide expandSidebar={() => undefined} />
    </div>
  </div>
}

export type PanelTarget = 'conversation' | 'conversation.session' | 'details'

/** Outcome of adding Vault context to the composer (issue #135). */
export interface VaultContextAddResult {
  /** True when the conversation moved into the vault workspace. */
  landed: boolean
  /** Session whose composer received the reference. */
  sessionId: string
}

export function panelTargetFor(sessions: { current: string | undefined; byId: Record<string, { blank: boolean }> }): PanelTarget {
  if (sessions.current === undefined) return 'conversation'
  return sessions.byId[sessions.current]?.blank === false ? 'details' : 'conversation.session'
}

/** Non-modal exit confirmation shown by the footer for 8s (docs design §5.3). */
interface ExitNotice {
  key: number
  text: string
  sub?: string | undefined
  /** Visibility to restore when the user clicks 撤销 within the window. */
  undoVisibility?: import('./workbench-geometry.ts').WorkbenchVisibility | undefined
}

interface FooterProps {
  wide: boolean
  store: VaultStore
  addContextToChat(kind: VaultContextKind, value: string): Promise<VaultContextAddResult>
  status?: WorkspaceStatusSource | undefined
  openVaultConversation?: (() => Promise<void>) | undefined
}

function FooterButton({ wide, store, addContextToChat, status, openVaultConversation }: FooterProps) {
  const [open, setOpen] = useState(false)
  const [thoughts, setThoughts] = useState(false)
  const [exitNotice, setExitNotice] = useState<ExitNotice | null>(null)
  /** Visibility for the next workbench mount (undo reopen); ref survives the unmount gap. */
  const reopenVisibility = useRef<import('./workbench-geometry.ts').WorkbenchVisibility | undefined>(undefined)
  const vaultState = store.useSnapshot()
  const workspaceStatus = useWorkspaceStatus(status, vaultState.vaultRoot)
  useEffect(() => {
    if (exitNotice === null) return
    const timer = window.setTimeout(() => { setExitNotice(current => (current !== null && current.key === exitNotice.key ? null : current)) }, 8000)
    return () => window.clearTimeout(timer)
  }, [exitNotice])

  const handleWorkbenchClose = (info?: WorkbenchExitInfo): void => {
    setOpen(false)
    if (info === undefined) { setExitNotice(null); return }
    // §5.3: 撤销 is a convenience — visibility is persisted, so reopening
    // Obsidian mode restores the layout even after the toast is gone.
    const text = info.reason === 'auto'
      ? '已退出 Obsidian 模式(所有面板已收起)'
      : info.dirtyDrafts ? '已退出 Obsidian 模式 · 未保存草稿已保留' : '已退出 Obsidian 模式'
    const sub = workspaceStatus.state === 'vault'
      ? `该对话仍在 Vault 工作区,生成的文件将继续保存到 ${vaultState.vaultName}`
      : undefined
    setExitNotice({ key: Date.now(), text, sub, undoVisibility: info.visibility })
  }

  return (
    <>
      <button
        className={`${css.iconButton} ${open ? css.iconButtonActive : ''}`}
        type="button"
        title={open ? '退出 Obsidian 模式' : 'Obsidian notes workbench'}
        aria-label={open ? '退出 Obsidian 模式' : 'Obsidian notes'}
        aria-pressed={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <NotebookTabs size={wide ? 16 : 18} />
      </button>
      {open && <Workbench store={store} close={handleWorkbenchClose} addContextToChat={addContextToChat} status={status} openVaultConversation={openVaultConversation} initialVisibility={reopenVisibility.current} />}
      {exitNotice !== null && !open && (
        <div className={css.exitToast} role="status">
          <span>{exitNotice.text}{exitNotice.sub !== undefined && <><br /><span className={css.exitToastSub}>{exitNotice.sub}</span></>}</span>
          <button
            className={css.exitToastAction}
            type="button"
            onClick={() => {
              reopenVisibility.current = exitNotice.undoVisibility
              setExitNotice(current => (current !== null && current.key === exitNotice.key ? null : current))
              setOpen(true)
            }}
          >撤销</button>
        </div>
      )}
      <button className={css.iconButton} type="button" title="Thoughts inbox" aria-label="Thoughts inbox" onClick={() => setThoughts(value => !value)}>T</button>
      {thoughts && <div className={css.modalOverlay}><ThoughtsPanel close={() => setThoughts(false)} /></div>}
    </>
  )
}

export function apply(ctx: ClientContext): void {
  const workspaces = new WorkspaceRegistry(ctx.workspaces)
  let panelDispose: (() => void) | undefined
  let panelTarget: PanelTarget | undefined
  /** Workspaces already retitled to `Obsidian · …` (one-time, per registry id). */
  const renamedWorkspaceIds = new Set<string>()

  /** Host faces for the workspace chip; undefined faces degrade it to 'unknown'. */
  const statusSource: WorkspaceStatusSource = {
    sessions: ctx.sessions?.list,
    workspaces: ctx.workspaces?.list,
  }

  const desiredPanelTarget = (): PanelTarget => panelTargetFor(ctx.sessions.list.getSnapshot())

  /**
   * One-time retitle of the vault workspace so it is findable in the sidebar
   * (docs design §6.4). Only the create-default title (the path basename) is
   * touched; user-renamed workspaces are left alone. Idempotent via the
   * `renamedWorkspaceIds` marker.
   */
  const ensureVaultWorkspaceTitle = async (vaultRoot: string): Promise<void> => {
    try {
      const items = ctx.workspaces.list?.getSnapshot().items ?? []
      const workspace = items.find(candidate => samePath(candidate.path, vaultRoot))
      if (workspace === undefined || renamedWorkspaceIds.has(workspace.workspaceId)) return
      renamedWorkspaceIds.add(workspace.workspaceId)
      const base = vaultRoot.split('/').filter(segment => segment !== '').at(-1) ?? vaultRoot
      if (workspace.title !== base) return
      const desired = vaultWorkspaceTitle(vaultRoot, items.map(candidate => candidate.title))
      if (desired !== workspace.title) await ctx.workspaces.rename(workspace.workspaceId, desired)
    } catch { /* naming is best-effort */ }
  }

  /**
   * Enter the vault workspace: the reusable blank session for a blank
   * conversation is migrated, otherwise a fresh vault conversation is opened.
   */
  const openVaultConversation = async (): Promise<void> => {
    const vaultRoot = store.getSnapshot().vaultRoot
    if (vaultRoot === '') throw new Error('Vault 尚未就绪,请先打开一个 Vault。')
    const workspaceId = await workspaces.register(vaultRoot)
    // ctx.get skips the inject declaration gate: the service exists on rc.1
    // hosts and is undefined on rc.6, where the workspaces face falls back.
    const uiWorkspace = ctx.get('uiWorkspace') as VaultLandingContext['uiWorkspace']
    const landing: VaultLandingContext = { uiWorkspace, workspaces: ctx.workspaces, sessions: ctx.sessions }
    const sessionId = await landInVaultWorkspace(landing, workspaceId)
    if (sessionId === undefined) throw new Error('无法进入 Vault 工作区(当前宿主不支持工作区导航)。')
    void ensureVaultWorkspaceTitle(vaultRoot)
  }

  const addContextToChat = async (kind: VaultContextKind, value: string): Promise<VaultContextAddResult> => {
    const sessions = ctx.sessions.list.getSnapshot()
    const sessionId = sessions.current
    if (sessionId === undefined) throw new Error('Open a chat before adding Vault context.')
    const reference = await vaultApi.context(kind, value)
    const workspaceId = await workspaces.register(reference.vaultRoot)
    // Issue #135: a still-blank conversation follows the reference into the
    // vault workspace; a conversation in progress stays in its own workspace
    // and only receives the reference block.
    let targetSessionId = sessionId
    if (currentSessionIsBlank(sessions)) {
      const uiWorkspace = ctx.get('uiWorkspace') as VaultLandingContext['uiWorkspace']
      const landing: VaultLandingContext = { uiWorkspace, workspaces: ctx.workspaces, sessions: ctx.sessions }
      targetSessionId = await landInVaultWorkspace(landing, workspaceId) ?? sessionId
    }
    void ensureVaultWorkspaceTitle(reference.vaultRoot)
    const actx = ctx.sessions.scope(targetSessionId)
    if (actx === undefined) throw new Error('The current chat is not available.')
    const input = ctx.conversation.input.for(actx)
    input.setDraft(appendVaultContext(input.state.getSnapshot().draft, reference))
    return { landed: targetSessionId !== sessionId, sessionId: targetSessionId }
  }

  const mountPanel = (): void => {
    const target = desiredPanelTarget()
    if (panelDispose !== undefined && panelTarget === target) return
    const previousTarget = panelTarget
    panelDispose?.()
    panelDispose = undefined
    if (previousTarget === 'details') ctx.layout.closeDetails()
    panelTarget = target
    panelDispose = ctx.slots.register({
      name: target,
      priority: -10,
      inject: () => ({ store }),
    }, NotePanel)
    if (target === 'details') ctx.layout.openDetails()
  }

  const closePanel = (): void => {
    panelDispose?.()
    panelDispose = undefined
    if (panelTarget === 'details') ctx.layout.closeDetails()
    panelTarget = undefined
  }

  const store = new VaultStore({
    open: () => {
      mountPanel()
    },
    close: closePanel,
  })

  ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'dsh-obsidian-skills',
    order: 40,
    label: 'Obsidian skills',
    inject: () => ({ store }),
  }, ObsidianSkillsSettings)

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-obsidian',
    order: 40,
    label: 'Obsidian notes',
    inject: () => ({ store, addContextToChat, status: statusSource, openVaultConversation }),
  }, FooterButton))

  const unsubscribeSessions = ctx.sessions.list.subscribe(() => {
    if (panelDispose !== undefined) mountPanel()
  })

  ctx.effect(() => () => {
    unsubscribeSessions()
    panelDispose?.()
  }, 'dsh-obsidian: client surfaces')
}
