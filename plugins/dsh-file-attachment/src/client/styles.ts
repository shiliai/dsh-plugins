const STYLE_ID = '@dsh-plugins/dsh-file-attachment'

export const css = {
  attachButton: 'dshFileAttachment_attachButton',
  error: 'dshFileAttachment_error',
  fileIcon: 'dshFileAttachment_fileIcon',
  fileMeta: 'dshFileAttachment_fileMeta',
  fileName: 'dshFileAttachment_fileName',
  fileRow: 'dshFileAttachment_fileRow',
  files: 'dshFileAttachment_files',
  hiddenInput: 'dshFileAttachment_hiddenInput',
  removeButton: 'dshFileAttachment_removeButton',
  spinner: 'dshFileAttachment_spinner',
}

export function installStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.pluginCss = STYLE_ID
  style.textContent = `
.${css.hiddenInput}{display:none}
.${css.attachButton},.${css.removeButton}{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
.${css.attachButton}:hover,.${css.removeButton}:hover{background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-label-primary)}
.${css.attachButton}:disabled,.${css.removeButton}:disabled{cursor:not-allowed;opacity:.45}
.${css.files}{display:flex;flex-direction:column;gap:6px;width:100%}
.${css.fileRow}{min-height:42px;display:flex;align-items:center;gap:10px;padding:6px 8px;border:1px solid var(--dsw-alias-border-subtle);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
.${css.fileIcon}{width:28px;height:28px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.${css.fileMeta}{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.${css.fileName}{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${css.fileMeta} small{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.${css.error}{font-size:12px;line-height:18px;color:var(--dsw-alias-status-error);padding:2px 4px}
.${css.spinner}{animation:dshFileAttachmentSpin .8s linear infinite}@keyframes dshFileAttachmentSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.${css.spinner}{animation:none}}
`
  document.head.appendChild(style)
}
