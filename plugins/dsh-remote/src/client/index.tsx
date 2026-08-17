import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Radio } from 'lucide-react'
import { RemotePanel } from './RemotePanel.tsx'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots']
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

function FooterButton({ wide, open }: FooterProps) {
  return (
    <button className={css.iconButton} type="button" title="Remote access" aria-label="Remote access" onClick={open}>
      <Radio size={wide ? 16 : 18} />
    </button>
  )
}

export function apply(ctx: ClientContext): void {
  clearAccessFragment(window.location, window.history)
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
  ctx.effect(() => () => { close() }, 'dsh-remote: client surfaces')
}
