import type { ContextReference } from '@dsh-plugins/dsh-reading-core'
import { appendContext, formatContext } from '@dsh-plugins/dsh-reading-core'
import type { VaultContextReference } from '../contracts.ts'

function toContext(reference: VaultContextReference): ContextReference {
  const entries = reference.kind === 'note'
    ? [{ type: 'note', path: reference.value, ...(reference.absolutePath === undefined ? {} : { absolutePath: reference.absolutePath }), workspaceId: 'vault', writable: true }]
    : reference.kind === 'directory'
      ? [{ type: 'directory', path: reference.value, ...(reference.absolutePath === undefined ? {} : { absolutePath: reference.absolutePath }), workspaceId: 'vault', writable: true }]
      : reference.entries.map(entry => ({ type: reference.kind, path: entry.path, absolutePath: entry.absolutePath, workspaceId: 'vault', writable: true }))
  return {
    source: 'obsidian-vault',
    workspaces: [{ id: 'vault', label: 'Obsidian vault', path: reference.vaultRoot, writable: true }],
    entries,
    ...(reference.kind === 'directory' ? { instructions: ['Read recursively under the directory entry above.'] } : {}),
  }
}

export function formatVaultContext(reference: VaultContextReference): string {
  return formatContext(toContext(reference))
}

export function appendVaultContext(draft: string, reference: VaultContextReference): string {
  return appendContext(draft, toContext(reference))
}
