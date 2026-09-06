import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import NotebookTabs from 'lucide-react/dist/esm/icons/notebook-tabs'
import { NotePanel } from './NotePanel.tsx'
import { VaultBrowser } from './VaultBrowser.tsx'
import { VaultStore } from './store.ts'
import { vaultApi } from './api.ts'
import { appendVaultContext } from './context-reference.ts'
import type { VaultContextKind } from '../contracts.ts'
import { Workbench } from './Workbench.tsx'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'layout', 'sessions', 'conversation']

export type PanelTarget = 'conversation' | 'conversation.session' | 'details'

export function panelTargetFor(sessions: { current: string | undefined; byId: Record<string, { blank: boolean }> }): PanelTarget {
  if (sessions.current === undefined) return 'conversation'
  return sessions.byId[sessions.current]?.blank === false ? 'details' : 'conversation.session'
}

interface FooterProps {
  wide: boolean
  store: VaultStore
  addContextToChat(kind: VaultContextKind, value: string): Promise<void>
}

function FooterButton({ wide, store, addContextToChat }: FooterProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={css.iconButton} type="button" title="Obsidian notes workbench" aria-label="Obsidian notes" onClick={() => { setOpen(value => !value) }}>
        <NotebookTabs size={wide ? 16 : 18} />
      </button>
      {open && <Workbench store={store} close={() => setOpen(false)} addContextToChat={addContextToChat} />}
    </>
  )
}

export function apply(ctx: ClientContext): void {
  let browserDispose: (() => void) | undefined
  let panelDispose: (() => void) | undefined
  let panelTarget: PanelTarget | undefined

  const desiredPanelTarget = (): PanelTarget => panelTargetFor(ctx.sessions.list.getSnapshot())

  const addContextToChat = async (kind: VaultContextKind, value: string): Promise<void> => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) throw new Error('Open a chat before adding Vault context.')
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) throw new Error('The current chat is not available.')
    const input = ctx.conversation.input.for(actx)
    const reference = await vaultApi.context(kind, value)
    input.setDraft(appendVaultContext(input.state.getSnapshot().draft, reference))
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

  const closeBrowser = (): void => {
    browserDispose?.()
    browserDispose = undefined
  }
  const openBrowser = (): void => {
    if (browserDispose !== undefined) return
    browserDispose = ctx.slots.register({
      name: 'sidebar.workspaces',
      priority: -10,
      inject: () => ({ store, closeBrowser, addContextToChat }),
    }, VaultBrowser)
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-obsidian',
    order: 40,
    label: 'Obsidian notes',
    inject: () => ({ openBrowser, store, addContextToChat }),
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
