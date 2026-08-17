import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { registerVaultApi } from './http-api.ts'
import { registerNoteTools } from './tools.ts'
import { VaultManager } from './vault-manager.ts'

export const name = 'dsh-obsidian'
export const inject = ['webServer', 'tools']

export interface Config {
  vaultRoot: string
  mutationOrigin: string
  maxNoteBytes?: number
  searchResultLimit?: number
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.vaultRoot !== 'string' || config.vaultRoot.trim() === '' || typeof config.mutationOrigin !== 'string') {
    throw new Error('dsh-obsidian: vaultRoot and mutationOrigin are required')
  }
  const vault = await VaultManager.create(
    config.vaultRoot,
    config.maxNoteBytes ?? 2 * 1024 * 1024,
    config.searchResultLimit ?? 100,
  )
  ctx.effect(() => registerVaultApi(ctx.webServer, vault, config.mutationOrigin), 'dsh-obsidian: vault HTTP API')
  registerNoteTools(ctx, vault)
}

export { VaultError, VaultService } from './vault-service.ts'
export { VaultManager } from './vault-manager.ts'
export type { NoteDocument, NoteSearchResult, VaultTreeNode } from './contracts.ts'
