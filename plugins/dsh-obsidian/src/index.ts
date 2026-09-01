import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { registerVaultApi } from './http-api.ts'
import { registerNoteTools } from './tools.ts'
import { SkillCoordinator } from './skill-coordinator.ts'
import { SkillStore } from './skill-store.ts'
import { ObsidianSkillProvider } from './skills.ts'
import { VaultManager } from './vault-manager.ts'

export const name = 'dsh-obsidian'
export const inject = ['webServer', 'tools', 'skills']

export interface Config {
  vaultRoot: string
  mutationOrigin: string
  maxNoteBytes?: number
  searchResultLimit?: number
  skillRoot?: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.vaultRoot !== 'string' || config.vaultRoot.trim() === '' || typeof config.mutationOrigin !== 'string') {
    throw new Error('dsh-obsidian: vaultRoot and mutationOrigin are required')
  }
  const relativeSkillsDir = config.skillRoot ?? '.agents/skills'

  // Mutable references, reassigned on vault switch; closures capture the binding.
  let skillsStore: SkillStore
  let coordinator: SkillCoordinator
  let invalidate: () => void = () => undefined
  let provider: ObsidianSkillProvider | undefined

  const vault = await VaultManager.create(
    config.vaultRoot,
    config.maxNoteBytes ?? 2 * 1024 * 1024,
    config.searchResultLimit ?? 100,
    (root: string) => {
      skillsStore = new SkillStore(root, relativeSkillsDir)
      coordinator.setStore(skillsStore)
      provider?.setStore(skillsStore)
      invalidate()
    },
  )

  skillsStore = new SkillStore(vault.root, relativeSkillsDir)
  coordinator = new SkillCoordinator(skillsStore, () => invalidate())

  // Vault-scoped skill provider in the global layer so every agent sees the
  // currently selected vault's skills. Rebuild on vault switch + invalidate.
  ctx.effect(() => ctx.skills.registerProvider((control) => {
    invalidate = control.invalidate
    provider = new ObsidianSkillProvider(skillsStore)
    return provider
  }), 'dsh-obsidian: vault-scoped skill provider')

  ctx.effect(() => registerVaultApi(ctx.webServer, vault, config.mutationOrigin, coordinator), 'dsh-obsidian: vault HTTP API')
  registerNoteTools(ctx, vault)
}

export { VaultError, VaultService } from './vault-service.ts'
export { VaultManager } from './vault-manager.ts'
export type {
  NoteDocument, NoteSearchResult, VaultContextEntry, VaultContextKind,
  VaultContextReference, VaultTag, VaultTreeNode,
} from './contracts.ts'
export { isObsidianTag, normalizeTag, parseObsidianTags } from './tags.ts'
export { SkillStore } from './skill-store.ts'
export { ObsidianSkillProvider } from './skills.ts'
