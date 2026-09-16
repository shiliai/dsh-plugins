import type { SkillStore } from './skill-store.ts'
import { skillScope, type SkillCandidate as CoreSkillCandidate, type SkillDefinition as CoreSkillDefinition, type SkillInvocationPolicy as CoreSkillInvocationPolicy, type SkillLookupOptions as CoreSkillLookupOptions, type SkillProvider as CoreSkillProvider } from '@dsh-plugins/dsh-reading-core'

const PROVIDER_RANK = 300

// Structural types mirroring the @deepseek-ai/dsh-skill provider contract, kept
// local so the plugin needs no extra dependency. Runtime values are compatible.
export type SkillInvocationPolicy = CoreSkillInvocationPolicy

export type SkillCandidate = CoreSkillCandidate

export type SkillLookupOptions = CoreSkillLookupOptions

export interface SkillProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

export type SkillDefinition = CoreSkillDefinition

export type SkillProvider = CoreSkillProvider

/**
 * A vault-scoped skill provider. `list()` and `get()` resolve against the
 * currently selected vault's `.agents/skills` root via the SkillStore, so the
 * skill set follows the active vault. Registered in the global layer by the
 * host plugin, it is visible to every agent.
 */
export class ObsidianSkillProvider implements SkillProvider {
  readonly name = 'obsidian-vault'
  private store: SkillStore | null

  get scope() {
    return skillScope('vault', 'Obsidian vault', this.store?.root ?? '', true)
  }

  constructor(initialStore: SkillStore | null) {
    this.store = initialStore
  }

  async list(_options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const store = this.store
    if (store === null) return []
    const { skills } = await store.list()
    return skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
      source: 'project-agents',
      provider: this.name,
      rank: PROVIDER_RANK,
      scope: this.scope,
      metadata: skill.frontmatter,
      path: `${store.root}/${skill.name}/SKILL.md`,
      locator: skill.name,
    }))
  }

  async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const store = this.store
    if (store === null) return undefined
    const name = candidate.locator
    if (typeof name !== 'string') return undefined
    try {
      const skill = await store.read(name)
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
        source: 'project-agents',
        provider: this.name,
        rank: PROVIDER_RANK,
        scope: this.scope,
        metadata: skill.frontmatter,
        path: `${store.root}/${name}/SKILL.md`,
        locator: name,
        content: skill.instructions,
      }
    } catch {
      return undefined
    }
  }

  /** Swap the store when the selected vault changes. Caller triggers invalidate(). */
  setStore(store: SkillStore | null): void {
    this.store = store
  }
}
