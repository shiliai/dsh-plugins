import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import NotebookTabs from 'lucide-react/dist/esm/icons/notebook-tabs'
import { NotePanel } from './NotePanel.tsx'
import { VaultBrowser } from './VaultBrowser.tsx'
import { VaultStore } from './store.ts'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'layout', 'sessions']

export type PanelTarget = 'conversation' | 'conversation.session' | 'details'

export function panelTargetFor(sessions: { current: string | undefined; byId: Record<string, { blank: boolean }> }): PanelTarget {
  if (sessions.current === undefined) return 'conversation'
  return sessions.byId[sessions.current]?.blank === false ? 'details' : 'conversation.session'
}

interface FooterProps {
  wide: boolean
  openBrowser(): void
}

function FooterButton({ wide, openBrowser }: FooterProps) {
  return (
    <button className={css.iconButton} type="button" title="Obsidian notes" aria-label="Obsidian notes" onClick={openBrowser}>
      <NotebookTabs size={wide ? 16 : 18} />
    </button>
  )
}

export function apply(ctx: ClientContext): void {
  let browserDispose: (() => void) | undefined
  let panelDispose: (() => void) | undefined
  let panelTarget: PanelTarget | undefined

  const desiredPanelTarget = (): PanelTarget => panelTargetFor(ctx.sessions.list.getSnapshot())

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

  const closeBrowser = (): void => {
    browserDispose?.()
    browserDispose = undefined
  }
  const openBrowser = (): void => {
    if (browserDispose !== undefined) return
    browserDispose = ctx.slots.register({
      name: 'sidebar.workspaces',
      priority: -10,
      inject: () => ({ store, closeBrowser }),
    }, VaultBrowser)
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-obsidian',
    order: 40,
    label: 'Obsidian notes',
    inject: () => ({ openBrowser }),
  }, FooterButton))

  const unsubscribeSessions = ctx.sessions.list.subscribe(() => {
    if (panelDispose !== undefined) mountPanel()
  })

  ctx.effect(() => () => {
    unsubscribeSessions()
    browserDispose?.()
    panelDispose?.()
  }, 'dsh-obsidian: client surfaces')
}
