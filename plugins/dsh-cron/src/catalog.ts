/**
 * Server-built capability catalog for the job modal: models with per-model
 * reasoning efforts (straight from the provider catalogs — never hardcoded),
 * agent presets, and permission presets. The modal's reasoning-effort select
 * mirrors the DSH model selector semantics: empty = follow provider default;
 * a model with no efforts disables the row.
 * @module @dsh-plugins/dsh-cron/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CatalogModel, CatalogOption, CatalogPreset, CatalogView, ModelEffortInfo } from './types.ts'

interface ModelSelectionLike {
  currentSelection(): { provider: string; model: string }
}

/** Shape shared by `llm.listModels` rows and `llm.resolveModelInfo` results. */
type ReasoningSource = {
  reasoning?: { efforts?: Array<{ id?: string; name?: string; description?: string }>; defaultEffort?: string }
}

interface LlmRuntimeLike {
  listProviders(): Array<{ name: string; label?: string }>
  listModels(provider: string): Promise<Array<{ id?: string; name?: string; model?: string; label?: string; displayName?: string } & ReasoningSource>>
  /**
   * Exact-route resolution; the only source of reasoning metadata on current
   * hosts (`listModels` results are stripped to identity + description).
   * Optional so older hosts keep working through the legacy fallback.
   */
  resolveModelInfo?(provider: string, model: string): Promise<ReasoningSource>
}

interface PresetsLike {
  defaultId: string
  list(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
}

interface PermissionPresetsLike {
  names: readonly string[]
  optionOf(name: string): CatalogOption
}

export async function buildCatalog(ctx: Context): Promise<CatalogView> {
  const [models, agentPresets, permissionPresets] = await Promise.all([
    buildModels(ctx),
    buildPresets(ctx),
    buildPermissions(ctx),
  ])
  const defaultModel = (ctx.get('agentDefaultModel') as ModelSelectionLike | undefined)?.currentSelection()
  return {
    models,
    agentPresets,
    permissionPresets,
    ...(defaultModel ? { defaultModel: { provider: defaultModel.provider, model: defaultModel.model } } : {}),
  }
}

async function buildModels(ctx: Context): Promise<CatalogModel[]> {
  const llm = ctx.get('llm') as LlmRuntimeLike | undefined
  if (!llm || typeof llm.listProviders !== 'function') return []
  const out: CatalogModel[] = []
  let providers: Array<{ name: string; label?: string }>
  try {
    providers = llm.listProviders()
  } catch {
    return []
  }
  for (const provider of providers) {
    let models: Awaited<ReturnType<LlmRuntimeLike['listModels']>>
    try {
      models = await llm.listModels(provider.name)
    } catch {
      continue
    }
    for (const model of models) {
      const modelId = model.id ?? model.model ?? model.name
      if (typeof modelId !== 'string' || modelId.length === 0) continue
      // Reasoning efforts live only on the exact-route resolution; a failed
      // or missing resolution just means the effort row stays disabled.
      let reasoning: ModelEffortInfo[] = []
      let defaultEffort: string | undefined
      try {
        const resolved = typeof llm.resolveModelInfo === 'function'
          ? await llm.resolveModelInfo(provider.name, modelId)
          : model
        reasoning = (resolved.reasoning?.efforts ?? [])
          .filter(effort => typeof effort?.id === 'string')
          .map(effort => ({
            id: effort.id!,
            name: typeof effort.name === 'string' && effort.name ? effort.name : effort.id!,
            ...(typeof effort.description === 'string' ? { description: effort.description } : {}),
          }))
        if (typeof resolved.reasoning?.defaultEffort === 'string') defaultEffort = resolved.reasoning.defaultEffort
      } catch {
        // Adapter rejected this exact route; keep the model listed without efforts.
      }
      out.push({
        provider: provider.name,
        model: modelId,
        label: typeof model.label === 'string' && model.label ? model.label : typeof model.displayName === 'string' && model.displayName ? model.displayName : modelId,
        ...(reasoning.length > 0
          ? { reasoning: { efforts: reasoning, ...(defaultEffort !== undefined ? { defaultEffort } : {}) } }
          : {}),
      })
    }
  }
  return out
}

async function buildPresets(ctx: Context): Promise<CatalogPreset[]> {
  const presets = ctx.get('agentPresets') as PresetsLike | undefined
  if (!presets || typeof presets.list !== 'function') return []
  try {
    const rows = await presets.list()
    return rows
      .filter(row => !row.broken)
      .map(row => ({
        id: row.id,
        ...(row.name !== undefined ? { name: row.name } : {}),
        ...(row.description !== undefined ? { description: row.description } : {}),
      }))
  } catch {
    return []
  }
}

async function buildPermissions(ctx: Context): Promise<CatalogOption[]> {
  const permissions = ctx.get('permissionPresets') as PermissionPresetsLike | undefined
  if (!permissions || !Array.isArray(permissions.names) || typeof permissions.optionOf !== 'function') return []
  try {
    return permissions.names.map(name => permissions.optionOf(name))
  } catch {
    return []
  }
}
