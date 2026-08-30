import type { AgentSkillDocument, AgentSkillInput, AgentSkillListResult } from './contracts.ts'
import type { SkillStore } from './skill-store.ts'

export interface AgentSkillMutationResult<T> {
  value: T
  refreshFailed: boolean
}

export type AgentSkillPanelRefresh = () => void | Promise<void>
export type AgentSkillsChangedCallback = () => void | Promise<void>

/**
 * Owns panel refresh subscriptions and broadcasts "skills changed" so the
 * skill registry's consumers (provider invalidation, model catalogs) reload
 * after any mutation. Mirrors claudian's AgentSkillManagementCoordinator.
 */
export class SkillCoordinator {
  private readonly panelRefreshers = new Set<AgentSkillPanelRefresh>()

  constructor(
    private _store: SkillStore,
    private readonly notifyAgentSkillsChanged: AgentSkillsChangedCallback,
  ) {}

  get store(): SkillStore {
    return this._store
  }

  setStore(store: SkillStore): void {
    this._store = store
  }

  list(): Promise<AgentSkillListResult> {
    return this.store.list()
  }

  read(name: string): Promise<AgentSkillDocument> {
    return this.store.read(name)
  }

  subscribe(refresh: AgentSkillPanelRefresh): () => void {
    this.panelRefreshers.add(refresh)
    return () => { this.panelRefreshers.delete(refresh) }
  }

  resetSubscriptions(): void {
    this.panelRefreshers.clear()
  }

  async create(input: AgentSkillInput): Promise<AgentSkillMutationResult<AgentSkillDocument>> {
    const value = await this.store.create(input)
    return this.completeMutation(value)
  }

  async update(
    previousName: string,
    expectedRevision: string,
    input: AgentSkillInput,
  ): Promise<AgentSkillMutationResult<AgentSkillDocument>> {
    const value = await this.store.update(previousName, expectedRevision, input)
    return this.completeMutation(value)
  }

  async delete(name: string, expectedRevision: string): Promise<AgentSkillMutationResult<void>> {
    await this.store.delete(name, expectedRevision)
    return this.completeMutation(undefined)
  }

  private async completeMutation<T>(value: T): Promise<AgentSkillMutationResult<T>> {
    const refreshers = [...this.panelRefreshers]
    const [providerRefresh] = await Promise.all([
      Promise.resolve().then(() => this.notifyAgentSkillsChanged())
        .then(() => false, () => true),
      Promise.allSettled(refreshers.map(refresh => Promise.resolve().then(refresh))),
    ])
    return { value, refreshFailed: providerRefresh }
  }
}
