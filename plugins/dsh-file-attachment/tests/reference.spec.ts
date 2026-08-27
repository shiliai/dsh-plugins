import { describe, expect, it } from 'vitest'
import type { UploadedFile } from '../src/contracts.ts'
import { appendAttachmentReferences, formatAttachmentReference } from '../src/reference.ts'
import { appendClientReferences, removeClientReference } from '../src/client/reference.ts'

const file: UploadedFile = {
  fileId: 'id', name: 'shot.png', mediaType: 'image/png', bytes: 42,
  uri: 'file:///tmp/shot.png', expiresAt: 123,
}

describe('attachment references', () => {
  it('formats model-visible text without native image content', () => {
    expect(formatAttachmentReference(file)).toBe('[Attached file: shot.png]\ntype: image/png\nsize: 42 bytes\nuri: file:///tmp/shot.png')
    expect(appendAttachmentReferences('inspect this', [file])).toBe(`inspect this\n\n${formatAttachmentReference(file)}`)
    expect(appendClientReferences('', [file])).toBe(formatAttachmentReference(file))
  })

  it('removes only the selected reference block from a draft', () => {
    const other = { ...file, fileId: 'other', name: 'notes.txt', uri: 'file:///tmp/notes.txt' }
    const draft = appendClientReferences('question', [file, other])
    expect(removeClientReference(draft, file)).toBe(`question\n\n${formatAttachmentReference(other)}`)
  })
})
