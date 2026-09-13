import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function cacheFile(namespace: string, key: string): string {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.local', 'dsh_home')
  const digest = createHash('sha1').update(key).digest('hex')
  return join(root, 'cache', 'dsh-reading', namespace, `${digest}.json`)
}

export async function readRemoteCache<T>(namespace: string, key: string): Promise<{ value: T; cachedAt: number } | undefined> {
  try {
    const raw = JSON.parse(await readFile(cacheFile(namespace, key), 'utf8')) as { value: T; cachedAt: number }
    return raw && typeof raw.cachedAt === 'number' ? raw : undefined
  } catch { return undefined }
}

export async function writeRemoteCache<T>(namespace: string, key: string, value: T): Promise<void> {
  const file = cacheFile(namespace, key)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify({ value, cachedAt: Date.now() }), 'utf8')
}
