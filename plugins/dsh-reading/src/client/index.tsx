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
import { pluginVersion } from './version.ts'
import { Workbench } from './Workbench.tsx'
import { articleContext, bookContext } from './context.ts'
import { WorkspaceRegistry } from '@dsh-plugins/dsh-reading-core'
import { mountConfigPortabilityTab, registerPortabilityProvider } from '@dsh-plugins/dsh-config-portability/client'
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
    <h2 style={{ margin: '0 0 8px', display: 'flex', alignItems: 'baseline', gap: 8 }}>Reading <span style={{ fontSize: 12, fontWeight: 400, opacity: .55 }}>v{pluginVersion}</span></h2>
    <p style={{ opacity: .72, marginTop: 0 }}>配置项目缓存目录、数据源和打开项目时的会话行为。</p>
    <label style={{ display: 'block', margin: '18px 0 6px' }}>默认 workspace 根目录</label>
    <input style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px' }} value={draft.rootDir} onChange={event => setDraft({ ...draft, rootDir: event.target.value })} />
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '18px 0' }}><input type="checkbox" checked={draft.createSessionOnOpen} onChange={event => setDraft({ ...draft, createSessionOnOpen: event.target.checked })} /> 打开书籍或文章时切换到 Reading workspace 对话</label>
    <h3 style={{ margin: '24px 0 8px' }}>数据源</h3>
    <p style={{ opacity: .72, fontSize: 13 }}>服务地址由部署环境提供，凭据不会显示在浏览器中。</p>
    <div style={{ fontSize: 13, lineHeight: 1.7 }}><div>Wallabag：{draft.sources?.wallabag?.origin ?? '未配置'}</div><div>OPDS：{draft.sources?.opds?.url ?? '未配置'}</div><div>缓存：{draft.cache?.directory ?? 'DSH_HOME/cache/dsh-reading'}；成功结果写入本地，服务不可用时使用旧缓存。</div></div>
    <button type="button" onClick={() => void save()}>保存</button>
    {status !== null && <span style={{ marginLeft: 12, opacity: .75 }}>{status}</span>}
    {settings !== null && <p style={{ opacity: .6, fontSize: 12 }}>已有项目目录不会因修改根目录而移动。</p>}
  </div>
}

function appendContext(draft: string, block: string): string {
  const trimmed = draft.trimEnd()
  return trimmed === '' ? block : `${trimmed}\n\n${block}`
}

type SessionFace = NonNullable<ReturnType<ClientContext['sessions']['sessionOf']>>

/**
 * Subscribe to the conversation until the in-flight turn settles and a new
 * assistant message with text arrives; returns its text. Rejects on timeout or
 * when the turn ends without producing any assistant text.
 */
function waitForAssistantReply(face: SessionFace, afterSeq: number, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let sawNewNode = false
    let idleStrikes = 0
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: () => void = () => {}
    const timer = setTimeout(() => fail(new Error('生成概要超时，请稍后在对话中查看结果。')), timeoutMs)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      unsubscribe()
      reject(error)
    }
    const succeed = (text: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      unsubscribe()
      resolve(text)
    }
    function check(): void {
      if (settled) return
      const snapshot = face.getSnapshot()
      if (snapshot.promptError !== null) {
        fail(new Error(snapshot.promptError.error.message ?? '生成概要失败。'))
        return
      }
      for (let index = snapshot.nodes.length - 1; index >= 0; index--) {
        const node = snapshot.nodes[index]!
        if (node.seq <= afterSeq) break
        sawNewNode = true
        if (node.kind === 'assistant' && node.interrupted !== true) {
          const text = node.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n').trim()
          if (text !== '') {
            succeed(text)
            return
          }
        }
      }
      if (sawNewNode && !snapshot.running && snapshot.partial === null) {
        // The queued user node and the host's turn/start can land as separate
        // snapshot emissions; require the idle condition to persist briefly
        // before concluding nothing was produced.
        idleStrikes += 1
        if (idleStrikes >= 2) fail(new Error('对话未产生概要内容，请检查对话状态后重试。'))
        else idleTimer = setTimeout(() => { check() }, 400)
      } else {
        idleStrikes = 0
        if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
      }
    }
    unsubscribe = face.subscribe(check)
    check()
  })
}

export function apply(ctx: ClientContext): void {
  // Config-portability contract (issue #105): expose Reading's config to the
  // shared「配置迁移」tab and mount that tab once for all joining plugins.
  registerPortabilityProvider({ id: 'dsh-reading', displayName: 'Reading', apiPrefix: '/dsh-reading/api' })
  mountConfigPortabilityTab(ctx)

  const store = new ReadingStore()
  const workspaces = new WorkspaceRegistry(ctx.workspaces)
  let vaultRootPromise: Promise<string | undefined> | undefined

  const ensureReadingWorkspace = async (path: string): Promise<void> => { await workspaces.register(path) }

  const getVaultRoot = async (): Promise<string | undefined> => {
    vaultRootPromise ??= fetch('/dsh-obsidian/api/info').then(async response => {
      if (!response.ok) return undefined
      const value = await response.json() as { root?: unknown }
      return typeof value.root === 'string' && value.root !== '' ? value.root : undefined
    }).catch(() => undefined)
    return vaultRootPromise
  }

  const openProjectSession = async (_path: string): Promise<void> => {
    const settings = await readingApi.settings()
    // Register the Reading root even when per-item session switching is off.
    // Context references are rooted there and must remain resolvable by tools.
    await ensureReadingWorkspace(settings.rootDir)
    if (!settings.createSessionOnOpen) return
    // Keep the conversation cwd at the Reading root so projectPath remains
    // meaningful for both books and articles.
    const workspace = await ctx.workspaces.create({ path: settings.rootDir })
    const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId)
    ctx.sessions.open(sessionId)
  }

  // The settings plugin contributes this slot at runtime; older client UI
  // typings do not include the plural alias yet.
  ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-reading', order: 50, label: 'Reading', inject: () => ({}) } as never, ReadingSettingsPanel)

  const currentInput = () => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) throw new Error('请先打开一个会话。')
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) throw new Error('当前会话不可用。')
    return ctx.conversation.input.for(actx)
  }

  const addArticleContext = async (article: Article): Promise<void> => {
    const settings = await readingApi.settings()
    await ensureReadingWorkspace(settings.rootDir)
    const project = article.projectAbsolutePath === undefined || article.projectPath === undefined
      ? await readingApi.ensureArticleProjectFor(article)
      : { path: article.projectPath, absolutePath: article.projectAbsolutePath }
    const vaultRoot = await getVaultRoot()
    if (vaultRoot !== undefined) await workspaces.register(vaultRoot)
    const enriched: Article = { ...article, projectPath: project.path, projectAbsolutePath: project.absolutePath, readingWorkspace: settings.rootDir, ...(vaultRoot === undefined ? {} : { vaultRoot }) }
    const input = currentInput()
    input.setDraft(appendContext(input.state.getSnapshot().draft, articleContext(enriched)))
  }
  const addBookContext = async (book: { id: string; title: string; format: string; fileName: string; projectPath?: string; projectAbsolutePath?: string; readingWorkspace?: string; vaultRoot?: string }): Promise<void> => {
    const settings = await readingApi.settings()
    await ensureReadingWorkspace(settings.rootDir)
    const project = book.projectAbsolutePath === undefined || book.projectPath === undefined
      ? await readingApi.ensureBookProject(book.id)
      : { path: book.projectPath, absolutePath: book.projectAbsolutePath }
    const vaultRoot = await getVaultRoot()
    if (vaultRoot !== undefined) await workspaces.register(vaultRoot)
    const enriched = { ...book, projectPath: project.path, projectAbsolutePath: project.absolutePath, readingWorkspace: settings.rootDir, ...(vaultRoot === undefined ? {} : { vaultRoot }) }
    const input = currentInput(); input.setDraft(appendContext(input.state.getSnapshot().draft, bookContext(enriched)))
  }

  /**
   * Ask the current conversation's LLM to write a summary, then capture the
   * assistant reply. The book context is already injected in the conversation
   * when the book was opened, so the model can draw on both the book and the
   * preceding discussion.
   */
  const generateBookSummary = async (book: { title: string }): Promise<string> => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) throw new Error('请先打开一个会话再生成概要。')
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) throw new Error('当前会话不可用。')
    const face = ctx.sessions.sessionOf(actx)
    if (face === undefined) throw new Error('会话连接不可用，请刷新后重试。')
    const nodes = face.getSnapshot().nodes
    const afterSeq = nodes.length === 0 ? -1 : nodes[nodes.length - 1]!.seq
    const prompt = [
      `请为《${book.title}》写一段 150~250 字的中文概要，覆盖主题、核心内容/论点与阅读价值。`,
      '只输出概要正文本身，不要标题、列表、引号或任何额外说明。',
    ].join('')
    const result = await face.prompt([{ type: 'text', text: prompt }], 'queue')
    if (!result.ok) throw new Error(result.error.message ?? '发送生成请求失败。')
    return waitForAssistantReply(face, afterSeq, 180_000)
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
        {open && <Workbench store={store} close={() => toggle(false)} addArticleContext={addArticleContext} addBookContext={addBookContext} addObsidianReadingContext={addObsidianReadingContext} openProjectSession={openProjectSession} generateBookSummary={generateBookSummary} />}
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
