import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { MessageCircle } from 'lucide-react'
import { WecomPanel } from './WecomPanel.tsx'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots']

function FooterButton({ open, wide }: { open(): void; wide: boolean }) {
  return <button className={css.iconButton} type="button" title="WeCom connection" aria-label="WeCom connection" onClick={open}><MessageCircle size={wide ? 16 : 18} /></button>
}

export function apply(ctx: ClientContext): void {
  let panelDispose: (() => void) | undefined
  const close = (): void => { panelDispose?.(); panelDispose = undefined }
  const open = (): void => {
    if (panelDispose !== undefined) return
    panelDispose = ctx.slots.register({ name: 'shell.overlay', id: 'dsh-wecom-panel', order: 50, inject: () => ({ close }) }, WecomPanel)
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-wecom', order: 60, label: 'WeCom connection', inject: () => ({ open }) }, FooterButton))
  ctx.effect(() => () => close(), 'dsh-wecom: client surfaces')
}
