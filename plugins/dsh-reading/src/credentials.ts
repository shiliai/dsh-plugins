import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Read the flat `refs:` mapping from `$DSH_HOME/.credentials.yaml`
 * (two-space-indented `KEY: value` lines). Malformed files and missing
 * entries yield an empty map; secrets never leave the host process.
 */
export function readCredentialRefs(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.local', 'dsh_home')
  try {
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const refs: Record<string, string> = {}
    for (const line of text.split(/\r?\n/u)) {
      const match = /^\s{0,2}([A-Z0-9_]+):\s*(.*?)\s*$/u.exec(line)
      if (match?.[1] !== undefined && match[2] !== undefined) refs[match[1]] = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2')
    }
    return refs
  } catch { return {} }
}
