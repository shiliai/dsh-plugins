export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

export interface SkillScope {
  readonly id: string
  readonly label: string
  readonly root: string
  readonly writable: boolean
}

export interface SkillCandidate {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  source: string
  provider: string
  rank: number
  scope: SkillScope
  metadata?: Readonly<Record<string, unknown>>
  path?: string
  locator: unknown
}

export interface SkillDefinition extends SkillCandidate {
  content: string
}

export interface SkillLookupOptions {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export interface SkillProvider {
  readonly name: string
  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
}

export function skillScope(id: string, label: string, root: string, writable: boolean): SkillScope {
  return { id, label, root, writable }
}

export class ScopedSkillProvider implements SkillProvider {
  constructor(
    readonly name: string,
    private store: SkillStore | null,
    readonly scopeId: string,
    readonly scopeLabel: string,
    readonly scopeWritable: boolean,
    readonly rank = 300,
  ) {}

  get scope(): SkillScope {
    return skillScope(this.scopeId, this.scopeLabel, this.store?.root ?? '', this.scopeWritable)
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
      source: 'project-agents', provider: this.name, rank: this.rank, scope: this.scope,
      metadata: skill.frontmatter, path: `${store.root}/${skill.name}/SKILL.md`, locator: skill.name,
    }))
  }

  async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const store = this.store
    if (store === null || typeof candidate.locator !== 'string') return undefined
    try {
      const skill = await store.read(candidate.locator)
      return {
        name: skill.name, description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
        source: 'project-agents', provider: this.name, rank: this.rank, scope: this.scope,
        metadata: skill.frontmatter, path: `${store.root}/${skill.name}/SKILL.md`, locator: skill.name, content: skill.instructions,
      }
    } catch { return undefined }
  }

  setStore(store: SkillStore | null): void { this.store = store }
}
import type { SkillStore } from './skill-store.js'
