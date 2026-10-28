import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PanelLeftOpen, Radio } from 'lucide-react'
import { RemotePanel } from './RemotePanel.tsx'
import { installMobileCompatibility } from './mobile-compat.ts'
import { installWorkspaceSessionReadiness } from './workspace-session-readiness.ts'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'sessions', 'workspaces', 'modelDirectories']
const ACCESS_FRAGMENT = /^#\/access\/[A-Za-z0-9_-]{43}$/u

export interface BrowserLocation {
  hash: string
  pathname: string
  search: string
}

export interface BrowserHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void
}

export function clearAccessFragment(location: BrowserLocation, history: BrowserHistory): boolean {
  if (!ACCESS_FRAGMENT.test(location.hash)) return false
  history.replaceState(null, '', `${location.pathname}${location.search}`)
  return true
}

interface FooterProps {
  wide: boolean
  open(): void
}

const SIDEBAR_OPEN_LABELS = new Set(['Open sidebar', '打开侧边栏'])

export function openMobileSidebar(document: Document = window.document): boolean {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .find(candidate => SIDEBAR_OPEN_LABELS.has(candidate.getAttribute('aria-label') ?? ''))
  if (button === undefined) return false
  button.click()
  return true
}

function MobileSidebarButton() {
  return (
    <button
      className={css.mobileSidebarButton}
      type="button"
      title="Open navigation"
      aria-label="Open navigation"
      onClick={() => { openMobileSidebar() }}
    >
      <PanelLeftOpen size={20} />
    </button>
  )
}

function FooterButton({ wide, open }: FooterProps) {
  return (
    <button className={css.iconButton} type="button" title="Remote access" aria-label="Remote access" onClick={open}>
      <Radio size={wide ? 16 : 18} />
    </button>
  )
}

export function apply(ctx: ClientContext): void {
  clearAccessFragment(window.location, window.history)
  const disposeWorkspaceSessionReadiness = installWorkspaceSessionReadiness(ctx)
  const disposeMobileCompatibility = installMobileCompatibility()
  const disposeMobileSidebarButton = ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-remote-mobile-sidebar-toggle',
    order: 40,
  }, MobileSidebarButton)
  let panelDispose: (() => void) | undefined
  const close = (): void => {
    panelDispose?.()
    panelDispose = undefined
  }
  const open = (): void => {
    if (panelDispose !== undefined) return
    panelDispose = ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-remote-panel',
      order: 50,
      inject: () => ({ close }),
    }, RemotePanel)
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-remote',
    order: 50,
    label: 'Remote access',
    inject: () => ({ open }),
  }, FooterButton))
  ctx.effect(() => () => {
    close()
    disposeMobileSidebarButton()
    disposeMobileCompatibility()
    return disposeWorkspaceSessionReadiness()
  }, 'dsh-remote: client surfaces')
}
