import { useCallback, useEffect, useState } from 'react'
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left'
import Check from 'lucide-react/dist/esm/icons/check'
import CircleAlert from 'lucide-react/dist/esm/icons/circle-alert'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle'
import Pencil from 'lucide-react/dist/esm/icons/pencil'
import Plus from 'lucide-react/dist/esm/icons/plus'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw'
import Trash2 from 'lucide-react/dist/esm/icons/trash-2'
import Wand2 from 'lucide-react/dist/esm/icons/wand-2'
import X from 'lucide-react/dist/esm/icons/x'
import type { AgentSkillDocument, AgentSkillInput, AgentSkillListResult } from '../contracts.ts'
import type { VaultStore } from './store.ts'
import { vaultApi } from './api.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  store: VaultStore
  root: string
  closeBrowser(): void
  wide: boolean
  expandSidebar(): void
}

interface SkillListState {
  data: AgentSkillListResult | null
  loading: boolean
  error: string | null
}

const EMPTY_INPUT: AgentSkillInput = {
  name: '',
  description: '',
  modelInvocable: true,
  userInvocable: true,
  instructions: '',
}

// Pre-fill for the meeting-transcript summary skill the user described.
const MEETING_TRANSCRIPT_TEMPLATE: AgentSkillInput = {
  name: 'meeting-transcript-summary',
  description: '识别会议转写主题并生成与该 vault 相关知识结合的结构化总结文档。',
  whenToUse: '用户给出一段会议转写文字,并要求结合 vault 既有知识生成总结时。',
  modelInvocable: true,
  userInvocable: true,
  instructions: [
    '这是一个会议的转写,你要尝试识别主题。',
    '先检查用户消息中是否包含 [Obsidian context]。如果有,优先只在其中列出的文件、目录、tag 或搜索结果范围内检索背景;目录范围使用 obsidian_list_notes 或 obsidian_search_notes 的 prefix 参数。只有用户没有添加上下文范围时,才搜索整个 vault。',
    '使用 obsidian_list_tags、obsidian_search_by_tag、obsidian_search_notes 和 obsidian_read_note 查找并核对背景资料。不要仅凭搜索摘要完成关联,引用前必须读取原笔记。',
    '如果对于其中细节、关联、名词不清楚,先询问用户,不要自己强行关联。',
    '总结正文中关联到 vault 里已有的笔记、项目或名词时,用 [[双链]] 或引用的方式标明来源。',
    '在文档末尾列出实际读取并采用的 vault 来源;不要列出未读取或未用于总结的候选文件。',
    '总结后的文档单独生成,放在 transcript 目录下。',
  ].join('\n\n'),
}

export function SkillBrowser({ store, root, closeBrowser, wide, expandSidebar }: Props) {
  const [state, setState] = useState<SkillListState>({ data: null, loading: false, error: null })
  const [editor, setEditor] = useState<{ skill: AgentSkillDocument | null; seed: AgentSkillInput | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AgentSkillDocument | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }))
    try {
      const { result } = await vaultApi.skillList()
      setState({ data: result, loading: false, error: null })
    } catch (error) {
      setState(prev => ({ ...prev, loading: false, error: messageOf(error) }))
    }
  }, [])

  // Refresh when the active vault changes (multi-vault support); the server
  // resolves skillList() against the currently selected vault.
  const vaultRoot = store.getSnapshot().vaultRoot
  useEffect(() => {
    setEditor(null)
    setConfirmDelete(null)
    setMessage(null)
    void refresh()
  }, [vaultRoot, refresh])

  if (!wide) {
    return (
      <button className={css.railButton} type="button" title="Open skills" aria-label="Open skills" onClick={expandSidebar}>
        <Wand2 size={18} />
      </button>
    )
  }

  return (
    <section className={css.browser} aria-label="Obsidian skills">
      <header className={css.browserHeader}>
        <button className={css.iconButton} type="button" title="Back to sessions" aria-label="Back to sessions" onClick={closeBrowser}>
          <ArrowLeft size={16} />
        </button>
        <strong title={root}>Skills</strong>
        <button className={css.iconButton} type="button" title="Refresh" aria-label="Refresh skills" onClick={() => { void refresh() }}><RefreshCw size={15} /></button>
        <button className={css.iconButton} type="button" title="New skill" aria-label="New skill" onClick={() => { setEditor({ skill: null, seed: null }) }}><Plus size={16} /></button>
      </header>

      <p className={css.skillsHint}>保存在当前 vault 的 <code>.agents/skills</code> 下,只对该 vault 生效。</p>

      {state.error !== null && <div className={css.inlineError} role="alert">{state.error}</div>}
      {message !== null && <div className={css.inlineSuccess} role="status">{message}</div>}

      {state.loading && state.data === null && <div className={css.emptyDirectory}><LoaderCircle className={css.spin} size={15} /></div>}

      {state.data !== null && (
        <>
          {state.data.skills.length === 0
            ? (
              <div className={css.emptyDirectory}>
                <p>暂无 skill。</p>
                <button className={css.templateButton} type="button" onClick={() => { setEditor({ skill: null, seed: { ...MEETING_TRANSCRIPT_TEMPLATE } }) }}>
                  <Wand2 size={14} />用「会议转写总结」模板新建
                </button>
              </div>
            )
            : (
              <div className={css.skillList}>
                {state.data.skills.map(skill => (
                  <div key={skill.name} className={css.skillItem}>
                    <div className={css.skillItemInfo}>
                      <div className={css.skillItemHeader}>
                        <span className={css.skillItemName}>{skill.name}</span>
                        <span className={css.skillBadge}>skill</span>
                      </div>
                      <div className={css.skillItemDesc}>{skill.description}</div>
                      <div className={css.skillItemMeta}>
                        <span>模型:{skill.modelInvocable ? '可调用' : '不可调用'}</span>
                        <span>用户:{skill.userInvocable ? '可调用' : '不可调用'}</span>
                      </div>
                    </div>
                    <div className={css.skillItemActions}>
                      <button className={css.iconButton} type="button" title="Edit" aria-label="Edit skill" onClick={() => { setEditor({ skill, seed: null }) }}><Pencil size={15} /></button>
                      <button className={`${css.iconButton} ${css.dangerButton}`} type="button" title="Delete" aria-label="Delete skill" onClick={() => { setConfirmDelete(skill) }}><Trash2 size={15} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )
          }

          {state.data.skills.length > 0 && (
            <button className={css.templateButton} type="button" onClick={() => { setEditor({ skill: null, seed: { ...MEETING_TRANSCRIPT_TEMPLATE } }) }}>
              <Wand2 size={14} />用「会议转写总结」模板新建
            </button>
          )}

          {state.data.diagnostics.length > 0 && (
            <div className={css.skillDiagnostics} role="alert">
              <div className={css.skillDiagnosticsTitle}><CircleAlert size={14} />无法读取的 skill 目录</div>
              {state.data.diagnostics.map((diagnostic, index) => (
                <div key={`${diagnostic.directoryPath}:${index}`} className={css.skillDiagnostic}>
                  <code>{diagnostic.directoryPath}</code>
                  <span>{diagnostic.message}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {editor !== null && (
        <SkillEditorModal
          skill={editor.skill}
          seed={editor.seed}
          onClose={() => { setEditor(null) }}
          onSaved={() => {
            setEditor(null)
            void refresh()
          }}
        />
      )}

      {confirmDelete !== null && (
        <div className={css.modalOverlay} role="dialog" aria-modal="true" aria-label="Delete skill">
          <div className={css.deleteModal}>
            <p>确定删除 skill <code>{confirmDelete.name}</code>?</p>
            <p className={css.deleteModalDesc}>文件位于 {confirmDelete.directoryPath},删除后不可恢复。</p>
            <div className={css.modalActions}>
              <button className={css.cancelButton} type="button" onClick={() => { setConfirmDelete(null) }}>取消</button>
              <button className={`${css.saveButton} ${css.dangerButton}`} type="button" onClick={async () => {
                try {
                  await vaultApi.skillDelete(confirmDelete.name, confirmDelete.revision)
                  setConfirmDelete(null)
                  setMessage(`已删除 ${confirmDelete.name}`)
                  void refresh()
                } catch (error) {
                  setState(prev => ({ ...prev, error: messageOf(error) }))
                }
              }}>删除</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

interface EditorProps {
  skill: AgentSkillDocument | null
  seed: AgentSkillInput | null
  onClose(): void
  onSaved(): void
}

function SkillEditorModal({ skill, seed, onClose, onSaved }: EditorProps) {
  const [input, setInput] = useState<AgentSkillInput>(() => {
    if (seed !== null) return seed
    const whenToUse = skill?.whenToUse
    return {
      name: skill?.name ?? '',
      description: skill?.description ?? '',
      ...(whenToUse === undefined ? {} : { whenToUse }),
      modelInvocable: skill?.modelInvocable ?? true,
      userInvocable: skill?.userInvocable ?? true,
      instructions: skill?.instructions ?? '',
    }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setField = <K extends keyof AgentSkillInput>(key: K, value: AgentSkillInput[K]): void => {
    setInput(prev => ({ ...prev, [key]: value }))
  }

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await vaultApi.skillWrite({
        input,
        ...(skill === null ? {} : { previousName: skill.name, expectedRevision: skill.revision }),
      })
      onSaved()
    } catch (saveError) {
      setError(messageOf(saveError))
      setSaving(false)
    }
  }

  return (
    <div className={css.modalOverlay} role="dialog" aria-modal="true" aria-label={skill === null ? 'New skill' : 'Edit skill'}>
      <div className={css.skillModal}>
        <div className={css.modalHeader}>
          <strong>{skill === null ? '新建 Skill' : '编辑 Skill'}</strong>
          <button className={css.iconButton} type="button" title="Close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>

        <label className={css.field}>
          <span>名称</span>
          <input
            value={input.name}
            placeholder="kebab-case,如 meeting-transcript-summary"
            disabled={skill !== null}
            onChange={event => { setField('name', event.target.value) }}
          />
        </label>

        <label className={css.field}>
          <span>描述</span>
          <input
            value={input.description}
            placeholder="一句话描述用途"
            onChange={event => { setField('description', event.target.value) }}
          />
        </label>

        <label className={css.field}>
          <span>何时使用 (whenToUse)</span>
          <input
            value={input.whenToUse ?? ''}
            placeholder="可选:触发条件"
            onChange={event => { setField('whenToUse', event.target.value === '' ? undefined : event.target.value) }}
          />
        </label>

        <div className={css.fieldRow}>
          <label className={css.toggle}>
            <input type="checkbox" checked={input.modelInvocable} onChange={event => { setField('modelInvocable', event.target.checked) }} />
            <span>模型可自动调用</span>
          </label>
          <label className={css.toggle}>
            <input type="checkbox" checked={input.userInvocable} onChange={event => { setField('userInvocable', event.target.checked) }} />
            <span>用户可 / 调用</span>
          </label>
        </div>

        <label className={css.field}>
          <span>指令正文</span>
          <textarea
            className={css.instructionsArea}
            rows={12}
            value={input.instructions}
            placeholder="给模型的 Markdown 指令…"
            onChange={event => { setField('instructions', event.target.value) }}
          />
        </label>

        {error !== null && <div className={css.inlineError} role="alert">{error}</div>}

        <div className={css.modalActions}>
          <button className={css.cancelButton} type="button" onClick={onClose}>取消</button>
          <button className={css.saveButton} type="button" disabled={saving} onClick={() => { void onSave() }}>
            {saving ? <LoaderCircle className={css.spin} size={15} /> : <Check size={15} />}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error.'
}
