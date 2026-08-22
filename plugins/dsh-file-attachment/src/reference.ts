import type { UploadedFile } from './contracts.ts'

export function formatAttachmentReference(file: UploadedFile): string {
  return [
    `[Attached file: ${file.name}]`,
    `type: ${file.mediaType}`,
    `size: ${file.bytes} bytes`,
    `uri: ${file.uri}`,
  ].join('\n')
}

export function appendAttachmentReferences(draft: string, files: readonly UploadedFile[]): string {
  if (files.length === 0) return draft
  const block = files.map(formatAttachmentReference).join('\n\n')
  return draft.trimEnd() === '' ? block : `${draft.trimEnd()}\n\n${block}`
}
