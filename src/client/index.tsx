import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import NotebookTabs from 'lucide-react/dist/esm/icons/notebook-tabs'
import { NotePanel } from './NotePanel.tsx'
import { VaultBrowser } from './VaultBrowser.tsx'
import { VaultStore } from './store.ts'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'layout']

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

  const closePanel = (): void => {
    panelDispose?.()
    panelDispose = undefined
    ctx.layout.closeDetails()
  }

  const store = new VaultStore({
    open: () => {
      if (panelDispose === undefined) {
        panelDispose = ctx.slots.register({
          name: 'details',
          inject: () => ({ store }),
        }, NotePanel)
      }
      ctx.layout.openDetails()
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

  ctx.effect(() => () => {
    browserDispose?.()
    panelDispose?.()
  }, 'dsh-obsidian: client surfaces')
}
