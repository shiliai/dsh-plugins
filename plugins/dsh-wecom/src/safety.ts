import { realpath, stat } from 'node:fs/promises'
import { sep } from 'node:path'

export const WECOM_MAX_MESSAGE_BYTES = 20_480

/** Limit text by UTF-8 bytes without splitting a Unicode code point. */
export function truncateUtf8(value: string, limit = WECOM_MAX_MESSAGE_BYTES): string {
  let bytes = 0
  let result = ''
  for (const codePoint of value) {
    const next = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + next > limit) break
    result += codePoint
    bytes += next
  }
  return result
}

export function isAllowed(value: string | undefined, allowlist: readonly string[] | undefined): boolean {
  if (!value || !allowlist?.length) return false
  return allowlist.includes('*') || allowlist.includes(value)
}

export function safeErrorKind(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError'
}

/** Resolve paths before comparison so `..` and symlinks cannot leave a root. */
export async function resolveAllowedDirectory(target: string, roots: readonly string[]): Promise<string | undefined> {
  let resolvedTarget: string
  try {
    resolvedTarget = await realpath(target)
    if (!(await stat(resolvedTarget)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(root)
      if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) return resolvedTarget
    } catch {
      // A malformed configured root must not broaden access.
    }
  }
  return undefined
}
