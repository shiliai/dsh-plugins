import { useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import BookOpen from 'lucide-react/dist/esm/icons/book-open'
import type { Article } from '../contracts.ts'
import { ReadingStore } from './store.ts'
import { Workbench } from './Workbench.tsx'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'layout', 'sessions', 'conversation']

function appendContext(draft: string, block: string): string {
  const trimmed = draft.trimEnd()
  return trimmed === '' ? block : `${trimmed}\n\n${block}`
}

function articleContext(article: Article): string {
  const plain = (article.extractedHtml ?? '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
  const excerpt = plain.length > 16000 ? `${plain.slice(0, 16000)}…` : plain
  return ['[Reading context]', `title: ${JSON.stringify(article.title)}`, `url: ${JSON.stringify(article.url)}`, `articleId: ${JSON.stringify(article.id)}`, 'content:', excerpt].join('\n')
}

export function apply(ctx: ClientContext): void {
  const store = new ReadingStore()

  const currentInput = () => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) throw new Error('请先打开一个会话。')
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) throw new Error('当前会话不可用。')
    return ctx.conversation.input.for(actx)
  }

  const addArticleContext = async (article: Article): Promise<void> => {
    const input = currentInput()
    input.setDraft(appendContext(input.state.getSnapshot().draft, articleContext(article)))
  }

  const addObsidianReadingContext = async (): Promise<void> => {
    const input = currentInput()
    const response = await fetch('/dsh-obsidian/api/context?kind=directory&value=reading')
    if (!response.ok && response.status !== 404) throw new Error(`Obsidian context unavailable (${response.status}).`)
    const reference = response.ok
      ? await response.json() as { kind?: string; value?: string; vaultRoot?: string; absolutePath?: string; entries?: Array<{ path: string; absolutePath: string }> }
      : await (async () => {
        const info = await fetch('/dsh-obsidian/api/info')
        if (!info.ok) throw new Error(`Obsidian context unavailable (${info.status}).`)
        const value = await info.json() as { root?: string }
        return { kind: 'directory', value: 'reading', vaultRoot: value.root ?? '', absolutePath: '', entries: [] }
      })()
    const lines = ['[Obsidian context]', `type: ${reference.kind ?? 'directory'}`, `vault: ${JSON.stringify(reference.vaultRoot ?? '')}`, `directory: ${JSON.stringify(reference.value ?? 'reading')}`, `absolutePath: ${JSON.stringify(reference.absolutePath ?? '')}`, 'recursive: true']
    if (reference.entries !== undefined) {
      lines.push('files:')
      for (const entry of reference.entries) lines.push(`- absolutePath: ${JSON.stringify(entry.absolutePath)}; vaultRelativePath: ${JSON.stringify(entry.path)}`)
    }
    input.setDraft(appendContext(input.state.getSnapshot().draft, lines.join('\n')))
  }

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
        {open && <Workbench store={store} close={() => toggle(false)} addArticleContext={addArticleContext} addObsidianReadingContext={addObsidianReadingContext} />}
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
