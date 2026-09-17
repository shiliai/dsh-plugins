/**
 * dsh-cron client surfaces: a「定时任务」entry in the sidebar footer actions
 * that opens the CronPanel into the shell overlay slot. Agent runs jump to
 * native session replay through ctx.sessions.open.
 * @module @dsh-plugins/dsh-cron/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { Clock } from 'lucide-react'
import { CronPanel } from './CronPanel.tsx'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'sessions']

export function apply(ctx: ClientContext): void {
  let panelDispose: (() => void) | undefined
  const close = (): void => {
    panelDispose?.()
    panelDispose = undefined
  }
  const open = (): void => {
    if (panelDispose !== undefined) return
    panelDispose = ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-cron-panel', order: 55, inject: () => ({ close, openSession: (id: string) => ctx.sessions.open(id) }) },
      CronPanel,
    )
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'dsh-cron', order: 55, label: '定时任务 Cron Jobs', inject: () => ({ open }) },
    FooterButton,
  ))
  ctx.effect(() => () => close(), 'dsh-cron: client surfaces')
}

function FooterButton({ open, wide }: { open(): void; wide: boolean }): JSX.Element {
  return (
    <button className={css.footerBtn} type="button" title="定时任务 Cron Jobs" aria-label="定时任务 Cron Jobs" onClick={open}>
      <Clock size={wide ? 16 : 18} />
    </button>
  )
}
