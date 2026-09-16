import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerReadingApi } from './http-api.ts'
import { LocalLibrary, ReadingError } from './library.ts'
import { ReadingStateStore } from './state-store.ts'
import { WallabagAdapter, type WallabagConfig } from './wallabag-adapter.ts'
import { OpdsAdapter, type OpdsConfig } from './opds-adapter.ts'
import { defaultProjectConfig, readProjectConfig, saveProjectConfig, type ReadingProjectConfig } from './project-cache.ts'
import { ScopedSkillProvider, SkillStore } from '@dsh-plugins/dsh-reading-core'

export const name = 'dsh-reading'
export const inject = ['webServer', 'skills']

export interface Config {
  /** Reading data directory (books + state). Defaults to $READING_DATA_DIR or ~/.dsh/reading. */
  dataDir?: string | null
  wallabag?: WallabagConfig | null
  opds?: OpdsConfig | null
  projectRoot?: string | null
  createSessionOnOpen?: boolean
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataDir = resolveDataDir(config)
  const library = new LocalLibrary(dataDir)
  const store = await ReadingStateStore.create(dataDir)
  const wallabag = config.wallabag === null ? undefined : config.wallabag === undefined ? WallabagAdapter.fromEnv() : new WallabagAdapter(config.wallabag)
  const opds = config.opds === null ? undefined : config.opds === undefined ? OpdsAdapter.fromEnv() : new OpdsAdapter(config.opds)
  const configFile = join(dataDir, 'reading-settings.json')
  const fallback = { ...defaultProjectConfig(dataDir), ...(typeof config.projectRoot === 'string' && config.projectRoot.trim() !== '' ? { rootDir: expandHome(config.projectRoot) } : {}), ...(typeof config.createSessionOnOpen === 'boolean' ? { createSessionOnOpen: config.createSessionOnOpen } : {}) }
  let projectConfig: ReadingProjectConfig = await readProjectConfig(configFile, fallback)
  const skillContext = ctx as Context & { skills: { registerProvider(create: (control: { invalidate(): void }) => ScopedSkillProvider): () => void } }
  let readingSkills = new SkillStore(projectConfig.rootDir)
  let readingProvider: ScopedSkillProvider | undefined
  ctx.effect(() => skillContext.skills.registerProvider(_control => {
    readingProvider = new ScopedSkillProvider('reading-workspace', readingSkills, 'reading', 'Reading workspace', false, 250)
    return readingProvider
  }), 'dsh-reading: workspace skill provider')
  ctx.effect(
    () => registerReadingApi(ctx.webServer, library, store, wallabag, opds, {
      get: () => projectConfig,
      update: async (next: ReadingProjectConfig) => { projectConfig = next; readingSkills = new SkillStore(next.rootDir); readingProvider?.setStore(readingSkills); await saveProjectConfig(configFile, next) },
      skills: () => readingSkills,
    }),
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
export { WallabagAdapter } from './wallabag-adapter.ts'
export type { WallabagConfig } from './wallabag-adapter.ts'
export { OpdsAdapter } from './opds-adapter.ts'
export type { OpdsConfig, OpdsBook } from './opds-adapter.ts'
export type {
  Annotation, Book, BookFormat, BookWithProgress, Locator, PublicBook, PublicBookWithProgress, ReadingProgress, ReadingStateSnapshot,
  Article,
} from './contracts.ts'
