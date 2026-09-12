import { useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import BookOpen from 'lucide-react/dist/esm/icons/book-open'
import { ReadingStore } from './store.ts'
import { Workbench } from './Workbench.tsx'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'layout', 'sessions', 'conversation']

export function apply(ctx: ClientContext): void {
  const store = new ReadingStore()

  function ReadingButton() {
    const [open, setOpen] = useState(false)
    const toggle = (value: boolean): void => {
      setOpen(value)
      if (!value) store.closeBook()
    }
    return (
      <>
        <button className={css.iconButton} type="button" title="Reading workbench" aria-label="Reading workbench"
          aria-pressed={open} onClick={() => toggle(!open)}>
          <BookOpen size={18} />
        </button>
        {open && <Workbench store={store} close={() => toggle(false)} />}
      </>
    )
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-reading',
    order: 50,
    label: 'Reading',
    inject: () => ({}),
  }, ReadingButton))

  ctx.effect(() => () => {
    store.closeBook()
  }, 'dsh-reading: client surfaces')
}
