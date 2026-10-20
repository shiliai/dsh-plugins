/**
 * Absolute-path helpers for the vault browser's "Copy path" action.
 *
 * The host hands the browser the canonical vault root; every browser row is
 * vault-relative. Joining them must respect the root's own separator so a
 * Windows vault yields `C:\vault\Notes\Today.md`, not a mixed path that a
 * terminal or editor would not resolve.
 */
export function absoluteVaultPath(vaultRoot: string, path: string): string {
  const root = vaultRoot.replace(/[\\/]+$/u, '')
  if (root === '') return path
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const relative = path.replace(/^[\\/]+/u, '').split(/[\\/]+/u).filter(segment => segment !== '').join(separator)
  return relative === '' ? root : `${root}${separator}${relative}`
}
