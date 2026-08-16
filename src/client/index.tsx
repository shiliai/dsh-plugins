import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Radio } from 'lucide-react'
import { RemotePanel } from './RemotePanel.tsx'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'layout']

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
  let panelDispose: (() => void) | undefined
  const close = (): void => {
    panelDispose?.()
    panelDispose = undefined
    ctx.layout.closeDetails()
  }
  const open = (): void => {
    if (panelDispose !== undefined) return
    panelDispose = ctx.slots.register({
      name: 'details',
      priority: -10,
      inject: () => ({ close }),
    }, RemotePanel)
    ctx.layout.openDetails()
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
