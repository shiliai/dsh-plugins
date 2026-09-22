import { describe, expect, it, vi } from 'vitest'
import { judge, JEV_ENDPOINT } from '../src/jev-client.ts'
import type { Worker } from '../src/config.ts'

const WORKERS: Worker[] = [
  { name: 'local-deepseek', provider: 'ds-haitian', model: 'deepseek-v4-flash', description: '私有化 DeepSeek,适合简单任务' },
  { name: 'local-qwen', provider: 'ds-haitian', model: 'qwen3.8-27b', description: '本地 Qwen,适合中等任务' },
]

// Never a real key: the client only echoes this into the Authorization header
// of a mocked fetch.
const API_KEY = 'test-jev-key-not-real'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      complexity: { type: 'score', score: 0.9, legend: {}, probabilities: {}, confidence: 0.9, ...overrides.complexity as object | undefined },
      executor: { type: 'choice', choice: 'local-deepseek', probabilities: { 'local-deepseek': 0.9, leader: 0.1 }, confidence: 0.9, ...overrides.executor as object | undefined },
    },
    usage: { input_tokens: 300, output_tokens: 20, ...overrides.usage as object | undefined },
  }
}

function fetchMock(impl: (input: unknown, init?: RequestInit) => Promise<Response> | Response) {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('jev-client judge', () => {
  it('parses a normal response', async () => {
    const mock = fetchMock(() => jsonResponse(successBody()))
    const verdict = await judge({ apiKey: API_KEY, model: 'jev-latest', timeoutMs: 5000, task: '总结 README', workers: WORKERS })
    expect(verdict.complexity).toBe(0.9)
    expect(verdict.executor).toBe('local-deepseek')
    expect(verdict.confidence).toBe(0.9)
    expect(verdict.usage).toEqual({ input_tokens: 300, output_tokens: 20 })
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(JEV_ENDPOINT)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions).sort()).toEqual(['complexity', 'executor'])
    expect(body.questions.complexity.type).toBe('score')
    expect(body.questions.complexity.criteria).toHaveLength(5)
    expect(body.questions.executor.type).toBe('choice')
    const criteria = body.questions.executor.criteria
    for (const worker of WORKERS) expect(criteria[worker.name]).toBe(worker.description)
    expect(typeof criteria.leader).toBe('string')
    expect(body.state.task).toBe('总结 README')
    expect(body.state.workers).toHaveLength(2)
  })

  it('retries once after a 429 and then succeeds', async () => {
    const mock = fetchMock(() => jsonResponse(successBody()))
    mock.mockImplementationOnce(() => Promise.resolve(jsonResponse({ error: 'rate limited' }, 429)))
    const verdict = await judge({ apiKey: API_KEY, model: 'jev-latest', timeoutMs: 5000, task: 't', workers: WORKERS })
    expect(verdict.executor).toBe('local-deepseek')
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('throws when the retry also gets a 429', async () => {
    const mock = fetchMock(() => Promise.resolve(jsonResponse({ error: 'rate limited' }, 429)))
    await expect(judge({ apiKey: API_KEY, model: 'jev-latest', timeoutMs: 5000, task: 't', workers: WORKERS }))
      .rejects.toThrow('429')
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('throws on 422 without retrying', async () => {
    const mock = fetchMock(() => Promise.resolve(jsonResponse({ error: 'validation' }, 422)))
    await expect(judge({ apiKey: API_KEY, model: 'jev-latest', timeoutMs: 5000, task: 't', workers: WORKERS }))
      .rejects.toThrow('422')
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('throws on 401 without retrying', async () => {
    const mock = fetchMock(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)))
    await expect(judge({ apiKey: API_KEY, model: 'jev-latest', timeoutMs: 5000, task: 't', workers: WORKERS }))
      .rejects.toThrow('401')
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('throws when the request times out (abort)', async () => {
    fetchMock((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    await expect(judge({ apiKey: API_KEY, model: 'jev-latest', timeoutMs: 20, task: 't', workers: WORKERS }))
      .rejects.toThrow()
  })

  it('aborts promptly when the caller signal fires', async () => {
    fetchMock((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('caller aborted')))
    }))
    const controller = new AbortController()
    const pending = judge({ apiKey: API_KEY, model: 'jev-latest', timeoutMs: 5000, task: 't', workers: WORKERS, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('caller aborted')
  })

  it('throws when answers are missing required fields', async () => {
    for (const bad of [
      { answers: { executor: { type: 'choice', choice: 'local-deepseek', confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } },
      { answers: { complexity: { type: 'score', score: 1, confidence: 1 }, executor: { type: 'choice', confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } },
      { answers: { complexity: { type: 'score', score: 'high', confidence: 1 }, executor: { type: 'choice', choice: 'x', confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } },
      { answers: { complexity: { type: 'score', score: 1, confidence: 1 }, executor: { type: 'choice', choice: 'x', confidence: 0.9 } }, usage: { input_tokens: 'many', output_tokens: 1 } },
      {},
    ]) {
      fetchMock(() => jsonResponse(bad))
      await expect(judge({ apiKey: API_KEY, model: 'jev-latest', timeoutMs: 5000, task: 't', workers: WORKERS }))
        .rejects.toThrow()
    }
  })
})
