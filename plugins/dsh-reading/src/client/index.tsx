import { useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins'
import BookOpen from 'lucide-react/dist/esm/icons/book-open'
import type { Article } from '../contracts.ts'
import { ReadingStore } from './store.ts'
import { readingApi, type ReadingSettings } from './api.ts'
import { Workbench } from './Workbench.tsx'
import css from './styles.module.css?dsh-inline'

export const inject = ['slots', 'layout', 'sessions', 'conversation', 'workspaces']

function ReadingSettingsPanel() {
  const [settings, setSettings] = useState<ReadingSettings | null>(null)
  const [draft, setDraft] = useState<ReadingSettings | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => { void readingApi.settings().then(value => { setSettings(value); setDraft(value) }).catch(error => setStatus(error instanceof Error ? error.message : String(error))) }, [])
  if (draft === null) return <div style={{ padding: 16 }}>{status ?? '加载 Reading 设置…'}</div>
  const save = async () => { setStatus(null); try { const value = await readingApi.updateSettings(draft); setSettings(value); setDraft(value); setStatus('已保存') } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) } }
  return <div style={{ padding: 16, maxWidth: 760 }}>
    <h2 style={{ margin: '0 0 8px' }}>Reading</h2>
    <p style={{ opacity: .72, marginTop: 0 }}>配置项目缓存目录和打开项目时的会话行为。</p>
    <label style={{ display: 'block', margin: '18px 0 6px' }}>默认 workspace 根目录</label>
    <input style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px' }} value={draft.rootDir} onChange={event => setDraft({ ...draft, rootDir: event.target.value })} />
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '18px 0' }}><input type="checkbox" checked={draft.createSessionOnOpen} onChange={event => setDraft({ ...draft, createSessionOnOpen: event.target.checked })} /> 打开书籍或文章时创建/切换到本篇对话</label>
    <button type="button" onClick={() => void save()}>保存</button>
    {status !== null && <span style={{ marginLeft: 12, opacity: .75 }}>{status}</span>}
    {settings !== null && <p style={{ opacity: .6, fontSize: 12 }}>已有项目目录不会因修改根目录而移动。</p>}
  </div>
}

function appendContext(draft: string, block: string): string {
  const trimmed = draft.trimEnd()
  return trimmed === '' ? block : `${trimmed}\n\n${block}`
}

function articleContext(article: Article): string {
  return ['[Reading item]', 'kind: article', `title: ${JSON.stringify(article.title)}`, `url: ${JSON.stringify(article.url)}`, `articleId: ${JSON.stringify(article.id)}`, `projectPath: ${JSON.stringify(article.projectPath ?? '')}`].join('\n')
}

function bookContext(book: { id: string; title: string; format: string; fileName: string; projectPath?: string }): string {
  return ['[Reading item]', 'kind: book', `title: ${JSON.stringify(book.title)}`, `bookId: ${JSON.stringify(book.id)}`, `format: ${JSON.stringify(book.format)}`, `fileName: ${JSON.stringify(book.fileName)}`, `projectPath: ${JSON.stringify(book.projectPath ?? '')}`].join('\n')
}

export function apply(ctx: ClientContext): void {
  const store = new ReadingStore()

  const openProjectSession = async (path: string): Promise<void> => {
    const settings = await readingApi.settings()
    if (!settings.createSessionOnOpen) return
    const workspace = await ctx.workspaces.create({ path })
    const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId)
    ctx.sessions.open(sessionId)
  }

  ctx.slots.register({ name: 'settings.plugin.item', id: 'dsh-reading', order: 50, label: 'Reading', inject: () => ({}) }, ReadingSettingsPanel)

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
  const addBookContext = async (book: { id: string; title: string; format: string; fileName: string; projectPath?: string }): Promise<void> => {
    const input = currentInput(); input.setDraft(appendContext(input.state.getSnapshot().draft, bookContext(book)))
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
        {open && <Workbench store={store} close={() => toggle(false)} addArticleContext={addArticleContext} addBookContext={addBookContext} addObsidianReadingContext={addObsidianReadingContext} openProjectSession={openProjectSession} />}
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
