import { describe, expect, it } from 'vitest'
import { buildCatalog } from '../src/catalog.ts'
import type { Context } from '@deepseek-ai/cordis'

function fakeCtx(services: Record<string, unknown>): Context {
  return { get: (key: string) => services[key] } as unknown as Context
}

describe('catalog models', () => {
  it('takes reasoning efforts from resolveModelInfo (current hosts)', async () => {
    const ctx = fakeCtx({
      llm: {
        listProviders: () => [{ name: 'ds-haitian' }],
        listModels: async () => [{ id: 'deepseek-v4-flash-0731', name: 'flash' }],
        resolveModelInfo: async () => ({
          reasoning: {
            efforts: [
              { id: 'high', name: '高', description: 'deep' },
              { id: 'off', name: 'off' },
            ],
            defaultEffort: 'high',
          },
        }),
      },
    })
    const catalog = await buildCatalog(ctx)
    expect(catalog.models).toHaveLength(1)
    expect(catalog.models[0]!.reasoning).toEqual({
      efforts: [
        { id: 'high', name: '高', description: 'deep' },
        { id: 'off', name: 'off' },
      ],
      defaultEffort: 'high',
    })
  })

  it('keeps a model listed without efforts when resolveModelInfo rejects', async () => {
    const ctx = fakeCtx({
      llm: {
        listProviders: () => [{ name: 'p' }],
        listModels: async () => [{ id: 'a' }, { id: 'b' }],
        resolveModelInfo: async (_provider: string, model: string) => {
          if (model === 'a') throw new Error('no route')
          return { reasoning: { efforts: [{ id: 'mid', name: '中' }] } }
        },
      },
    })
    const catalog = await buildCatalog(ctx)
    expect(catalog.models.find(model => model.model === 'a')?.reasoning).toBeUndefined()
    expect(catalog.models.find(model => model.model === 'b')?.reasoning?.efforts).toEqual([{ id: 'mid', name: '中' }])
  })

  it('falls back to legacy listModels reasoning when resolveModelInfo is absent', async () => {
    const ctx = fakeCtx({
      llm: {
        listProviders: () => [{ name: 'p' }],
        listModels: async () => [{ id: 'legacy', reasoning: { efforts: [{ id: 'low', name: '低' }] } }],
      },
    })
    const catalog = await buildCatalog(ctx)
    expect(catalog.models[0]!.reasoning?.efforts).toEqual([{ id: 'low', name: '低' }])
  })

  it('tolerates a missing llm service and absent preset services', async () => {
    const empty = await buildCatalog(fakeCtx({}))
    expect(empty.models).toEqual([])
    expect(empty.agentPresets).toEqual([])
    expect(empty.permissionPresets).toEqual([])
  })
})
