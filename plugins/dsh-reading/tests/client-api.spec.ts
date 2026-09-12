import { afterEach, describe, expect, it, vi } from 'vitest'
import { readingApi } from '../src/client/api.ts'

afterEach(() => vi.unstubAllGlobals())

describe('reading client API', () => {
  it('accepts a 204 response for annotation deletion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(readingApi.removeAnnotation('annotation-1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/dsh-reading/api/annotations/annotation-1', { method: 'DELETE' })
  })
})
