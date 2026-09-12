import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerReadingApi } from './http-api.ts'
import { LocalLibrary, ReadingError } from './library.ts'
import { ReadingStateStore } from './state-store.ts'

export const name = 'dsh-reading'
export const inject = ['webServer']

export interface Config {
  /** Reading data directory (books + state). Defaults to $READING_DATA_DIR or ~/.dsh/reading. */
  dataDir?: string | null
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataDir = resolveDataDir(config)
  const library = new LocalLibrary(dataDir)
  const store = await ReadingStateStore.create(dataDir)
  ctx.effect(
    () => registerReadingApi(ctx.webServer, library, store),
    'dsh-reading: reading HTTP API',
  )
}

export function resolveDataDir(config: Config): string {
  const fromEnv = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  if (fromEnv !== '') return expandHome(fromEnv)
  // Keep the previous name as a fallback so an existing profile can be
  // restarted while its environment is migrated to the shorter name.
  const envValue = (process.env.READING_DATA_DIR ?? process.env.DSH_READING_DATA_DIR)?.trim()
  if (envValue !== undefined && envValue !== '') return expandHome(envValue)
  return join(homedir(), '.dsh', 'reading')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export { ReadingStateStore } from './state-store.ts'
export { LocalLibrary, ReadingError } from './library.ts'
export type {
  Annotation, Book, BookFormat, BookWithProgress, Locator, PublicBook, PublicBookWithProgress, ReadingProgress, ReadingStateSnapshot,
} from './contracts.ts'
