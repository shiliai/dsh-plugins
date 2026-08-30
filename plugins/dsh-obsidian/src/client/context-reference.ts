import type { VaultContextReference } from '../contracts.ts'

export function formatVaultContext(reference: VaultContextReference): string {
  const lines = [
    '[Obsidian context]',
    `type: ${reference.kind}`,
    `vault: ${JSON.stringify(reference.vaultRoot)}`,
  ]

  if (reference.kind === 'note') {
    lines.push(`note: ${JSON.stringify(reference.value)}`, `absolutePath: ${JSON.stringify(reference.absolutePath ?? '')}`)
  } else if (reference.kind === 'directory') {
    lines.push(`directory: ${JSON.stringify(reference.value)}`, `absolutePath: ${JSON.stringify(reference.absolutePath ?? '')}`, 'recursive: true')
  } else {
    lines.push(reference.kind === 'tag' ? `tag: #${reference.value}` : `query: ${JSON.stringify(reference.value)}`)
    if (reference.kind === 'tag') lines.push('includeDescendants: true')
    lines.push('files:')
    for (const entry of reference.entries) {
      lines.push(`- absolutePath: ${JSON.stringify(entry.absolutePath)}; vaultRelativePath: ${JSON.stringify(entry.path)}`)
    }
  }
  return lines.join('\n')
}

export function appendVaultContext(draft: string, reference: VaultContextReference): string {
  const block = formatVaultContext(reference)
  return draft.trimEnd() === '' ? block : `${draft.trimEnd()}\n\n${block}`
}
