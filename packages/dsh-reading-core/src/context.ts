export interface ContextWorkspace {
  id: string
  label: string
  path: string
  writable?: boolean
}

export interface ContextEntry {
  type: string
  title?: string
  path?: string
  absolutePath?: string
  workspaceId?: string
  writable?: boolean
  metadata?: Readonly<Record<string, unknown>>
}

export interface ContextReference {
  source: string
  entries: readonly ContextEntry[]
  workspaces: readonly ContextWorkspace[]
  instructions?: readonly string[]
}

export function formatContext(reference: ContextReference): string {
  const lines = ['[Reading context]', `source: ${JSON.stringify(reference.source)}`]
  if (reference.workspaces.length > 0) {
    lines.push('availableWorkspaces:')
    for (const workspace of reference.workspaces) {
      lines.push(`- id: ${JSON.stringify(workspace.id)}; label: ${JSON.stringify(workspace.label)}; path: ${JSON.stringify(workspace.path)}; writable: ${String(workspace.writable === true)}`)
    }
  }
  lines.push('entries:')
  for (const entry of reference.entries) {
    const fields = [`type: ${JSON.stringify(entry.type)}`]
    if (entry.title !== undefined) fields.push(`title: ${JSON.stringify(entry.title)}`)
    if (entry.path !== undefined) fields.push(`path: ${JSON.stringify(entry.path)}`)
    if (entry.absolutePath !== undefined) fields.push(`absolutePath: ${JSON.stringify(entry.absolutePath)}`)
    if (entry.workspaceId !== undefined) fields.push(`workspaceId: ${JSON.stringify(entry.workspaceId)}`)
    if (entry.writable !== undefined) fields.push(`writable: ${String(entry.writable)}`)
    lines.push(`- ${fields.join('; ')}`)
  }
  for (const instruction of reference.instructions ?? []) lines.push(instruction)
  return lines.join('\n')
}

export function appendContext(draft: string, reference: ContextReference): string {
  const block = formatContext(reference)
  const trimmed = draft.trimEnd()
  return trimmed === '' ? block : `${trimmed}\n\n${block}`
}
