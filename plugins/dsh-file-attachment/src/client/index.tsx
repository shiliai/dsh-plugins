import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { AttachmentButton, AttachmentDock } from './AttachmentControls.tsx'
import { DraftAttachmentStore } from './draft-store.ts'
import { installStyles } from './styles.ts'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  installStyles()
  const store = new DraftAttachmentStore()
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-file-attachment-button',
    order: 60,
    label: 'Attach local file',
    inject: () => ({ store }),
  }, AttachmentButton))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-file-attachment-dock',
    order: 60,
    label: 'Local file attachments',
    inject: () => ({ store }),
  }, AttachmentDock))
}
