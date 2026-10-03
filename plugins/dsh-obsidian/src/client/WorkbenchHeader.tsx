/** Workbench top bar: mode identity, pane segmented control, chip seat, exit (docs design §4). */

import NotebookTabs from 'lucide-react/dist/esm/icons/notebook-tabs'
import X from 'lucide-react/dist/esm/icons/x'
import type { WorkbenchPaneKey, WorkbenchVisibility } from './workbench-geometry.ts'
import css from './styles.module.css?dsh-inline'

const PANE_LABELS: Record<WorkbenchPaneKey, string> = { tree: 'Vault', editor: '编辑器', preview: '预览', chat: '对话' }
const PANE_ORDER: WorkbenchPaneKey[] = ['tree', 'editor', 'preview', 'chat']

interface Props {
  vaultName: string
  vaultRoot: string
  visibility: WorkbenchVisibility
  /** Toggle one pane; `chat` false with no content pane visible triggers the auto-exit path in the owner. */
  onTogglePane(key: WorkbenchPaneKey, visible: boolean): void
  onVaultChooser(): void
  onExit(): void
  /** Right-side seat: the workspace-consistency chip (may be null). */
  chip?: React.ReactNode
}

export function WorkbenchHeader({ vaultName, vaultRoot, visibility, onTogglePane, onVaultChooser, onExit, chip }: Props) {
  return (
    <div className={css.workbenchBar} role="toolbar" aria-label="Obsidian 工作台">
      <button
        className={css.workbenchMode}
        type="button"
        title={`${vaultRoot} (切换 Vault 目录)`}
        aria-label={`Obsidian · ${vaultName};选择 Vault 目录`}
        onClick={onVaultChooser}
      >
        <NotebookTabs size={14} className={css.workbenchModeGlyph} aria-hidden />
        <span>Obsidian</span>
        <span className={css.workbenchVault}>· {vaultName}</span>
      </button>
      <div className={css.workbenchSeg} role="group" aria-label="面板开关">
        {PANE_ORDER.map(key => (
          <button
            key={key}
            type="button"
            className={css.workbenchSegBtn}
            aria-pressed={visibility[key]}
            aria-label={`${visibility[key] ? '隐藏' : '显示'} ${PANE_LABELS[key]}面板`}
            onClick={() => { onTogglePane(key, !visibility[key]) }}
          >{PANE_LABELS[key]}</button>
        ))}
      </div>
      {chip}
      <button
        className={css.workbenchExit}
        type="button"
        title="退出 Obsidian 模式 (Esc)"
        aria-label="退出 Obsidian 模式"
        aria-keyshortcuts="Esc"
        onClick={onExit}
      >
        退出 Obsidian <X size={13} aria-hidden />
      </button>
    </div>
  )
}
