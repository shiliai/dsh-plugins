import type { UploadedFile } from '../contracts.ts'

export function formatClientReference(file: UploadedFile): string {
  return [
    `[Attached file: ${file.name}]`,
    `type: ${file.mediaType}`,
    `size: ${file.bytes} bytes`,
    `uri: ${file.uri}`,
  ].join('\n')
}

export function appendClientReferences(draft: string, files: readonly UploadedFile[]): string {
  const block = files.map(formatClientReference).join('\n\n')
  return draft.trimEnd() === '' ? block : `${draft.trimEnd()}\n\n${block}`
}

export function removeClientReference(draft: string, file: UploadedFile): string {
  const block = formatClientReference(file)
  const index = draft.indexOf(block)
  if (index < 0) return draft
  const before = draft.slice(0, index).replace(/\n{1,2}$/u, '')
  const after = draft.slice(index + block.length).replace(/^\n{1,2}/u, '')
  return before !== '' && after !== '' ? `${before}\n\n${after}` : `${before}${after}`
}
