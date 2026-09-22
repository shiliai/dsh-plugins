import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeConfig, type Config, type Worker } from '../src/config.ts'
import type { JevVerdict } from '../src/jev-client.ts'
import { createTeamDelegateTool, type SubagentGateway, type TeamDelegateResult } from '../src/tool.ts'

const WORKERS: Worker[] = [
  {
    name: 'local-deepseek',
    provider: 'ds-haitian',
    model: 'deepseek-v4-flash',
    description: '私有化 DeepSeek',
    reasoningEffort: 'low',
  },
  { name: 'local-qwen', provider: 'ds-haitian', model: 'qwen3.8-27b', description: '本地 Qwen' },
]

const PARENT = { id: 'agent-parent-1' } as unknown as Agent

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tmpStatsConfig(overrides: Config = {}): Promise<{ config: ReturnType<typeof normalizeConfig>, statsFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-tool-'))
  tmpDirs.push(dir)
  const statsFile = join(dir, 'routing-stats.jsonl')
  return { config: normalizeConfig({ statsFile, ...overrides }), statsFile }
}

function fakeExec(signal = new AbortController().signal): ToolRunContext {
  return {
    agent: PARENT,
    signal,
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'team_delegate',
    arguments: {},
    token: Symbol('token'),
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  } as unknown as ToolRunContext
}

function verdict(overrides: Partial<Pick<JevVerdict, 'complexity' | 'executor' | 'confidence'>>): JevVerdict {
  return { complexity: 1, executor: 'local-deepseek', confidence: 0.9, usage: { input_tokens: 10, output_tokens: 5 }, raw: {}, ...overrides }
}

function makeGateway(run: SubagentRun | Error) {
  const start = vi.fn((_name: string, _request: SubagentStartRequest) => {
    if (run instanceof Error) return Promise.reject(run)
    return Promise.resolve(run)
  })
  return { gateway: { start } as unknown as SubagentGateway, start }
}

function completedRun(outputText: string, stopReason = 'completed'): SubagentRun {
  return {
    id: 'child-1',
    localAgent: undefined,
    result: Promise.resolve({ output: [{ type: 'text', text: outputText }], stopReason }),
    dispose: () => Promise.resolve(),
  } as unknown as SubagentRun
}

function execute(tool: ReturnType<typeof createTeamDelegateTool>, args: { task: string; label?: string }, exec = fakeExec()): Promise<unknown> {
  return tool.execute(args, exec)
}

describe('team_delegate tool', () => {
  it('registers with name team_delegate, bilingual description and task/label parameters', async () => {
    const { config } = await tmpStatsConfig()
    const { gateway } = makeGateway(completedRun('ok'))
    const tool = createTeamDelegateTool({ config, subagents: gateway })
    expect(tool.name).toBe('team_delegate')
    expect(tool.description).toContain('团队路由器')
    expect(tool.description).toContain('self-contained task')
    expect(tool.timeoutMs).toBe(600000)
    const parameters = tool.parameters as { properties: Record<string, { type: string; description?: string }>; required: string[] }
    expect(parameters.properties.task?.type).toBe('string')
    expect(parameters.properties.label?.type).toBe('string')
    expect(parameters.required).toContain('task')
    expect(parameters.required).not.toContain('label')
  })

  it('leader decision does not call subagents and returns a leader result', async () => {
    const { config, statsFile } = await tmpStatsConfig({ workers: WORKERS })
    const { gateway, start } = makeGateway(completedRun('unused'))
    const tool = createTeamDelegateTool({
      config,
      subagents: gateway,
      judge: async () => verdict({ executor: 'leader', complexity: 3, confidence: 0.95 }),
    })
    const result = await execute(tool, { task: '设计一个容灾方案' }) as TeamDelegateResult
    expect(start).not.toHaveBeenCalled()
    expect(result.decision).toBe('leader')
    if (result.decision === 'leader' && 'jev' in result) {
      expect(result.jev).toEqual({ complexity: 3, confidence: 0.95 })
    } else {
      throw new Error('expected leader decision with jev summary')
    }
    const lines = (await readFile(statsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ decision: 'leader', verdict: { executor: 'leader' } })
    expect(typeof lines[0].durationMs).toBe('number')
    expect(typeof lines[0].jevDurationMs).toBe('number')
  })

  it('worker decision starts the subagent with correct route, parent, signal, and maxDepth', async () => {
    const { config } = await tmpStatsConfig({ workers: WORKERS })
    const { gateway, start } = makeGateway(completedRun('任务完成'))
    const signal = new AbortController().signal
    const tool = createTeamDelegateTool({
      config,
      subagents: gateway,
      judge: async () => verdict({ executor: 'local-qwen', complexity: 0.8, confidence: 0.9 }),
    })
    const result = await execute(tool, { task: '把 README 摘要成 5 句话', label: 'summarize' }, fakeExec(signal)) as TeamDelegateResult
    expect(start).toHaveBeenCalledTimes(1)
    const [provider, request] = start.mock.calls[0] as unknown as [string, SubagentStartRequest]
    expect(provider).toBe('spawn')
    expect(request.parent).toBe(PARENT)
    expect(request.signal).toBe(signal)
    expect(request.maxDepth).toBe(0)
    expect(request.label).toBe('summarize')
    expect(request.agentOptions).toEqual({ provider: 'ds-haitian', model: 'qwen3.8-27b' })
    expect(request.prompt).toHaveLength(1)
    const text = (request.prompt[0] as { text: string }).text
    expect(text).toContain('worker')
    expect(text).toContain('不要再调用')
    expect(text.endsWith('把 README 摘要成 5 句话')).toBe(true)
    expect(result).toEqual({
      decision: 'worker',
      worker: 'local-qwen',
      reason: expect.stringContaining('local-qwen') as unknown as string,
      jev: { complexity: 0.8, confidence: 0.9 },
      result: '任务完成',
    })
  })

  it('forwards reasoningEffort when the worker declares one', async () => {
    const { config } = await tmpStatsConfig({ workers: WORKERS })
    const { gateway, start } = makeGateway(completedRun('ok'))
    const tool = createTeamDelegateTool({
      config,
      subagents: gateway,
      judge: async () => verdict({ executor: 'local-deepseek' }),
    })
    await execute(tool, { task: '格式化以下 JSON' })
    const [, request] = start.mock.calls[0] as unknown as [string, SubagentStartRequest]
    expect(request.agentOptions).toEqual({ provider: 'ds-haitian', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
  })

  it('start throwing falls back to fallback-leader (not isError) and records stats', async () => {
    const { config, statsFile } = await tmpStatsConfig({ workers: WORKERS })
    const { gateway, start } = makeGateway(new Error('route ds-haitian/deepseek-v4-flash is not available'))
    const tool = createTeamDelegateTool({
      config,
      subagents: gateway,
      judge: async () => verdict({ executor: 'local-deepseek' }),
    })
    const result = await execute(tool, { task: 'x' }) as TeamDelegateResult
    expect(result.decision).toBe('fallback-leader')
    if (result.decision === 'fallback-leader') {
      expect(result.error).toContain('not available')
      expect(result.jev.confidence).toBe(0.9)
    }
    const lines = (await readFile(statsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toMatchObject({ decision: 'fallback-leader', worker: 'local-deepseek' })
    expect(lines[0].error).toContain('not available')
  })

  it('retries once without maxDepth when the provider rejects the depth capability', async () => {
    const { config } = await tmpStatsConfig({ workers: WORKERS })
    const start = vi.fn((_name: string, request: SubagentStartRequest) => {
      if (request.maxDepth !== undefined) return Promise.reject(new Error('provider "spawn" lacks capability depthLimit for maxDepth'))
      return Promise.resolve(completedRun('ok'))
    })
    const tool = createTeamDelegateTool({
      config,
      subagents: { start } as unknown as SubagentGateway,
      judge: async () => verdict({ executor: 'local-deepseek' }),
    })
    const result = await execute(tool, { task: 'x' }) as TeamDelegateResult
    expect(start).toHaveBeenCalledTimes(2)
    expect(result.decision).toBe('worker')
  })

  it('non-completed stop reason maps to fallback-leader with partial output', async () => {
    const { config } = await tmpStatsConfig({ workers: WORKERS })
    const run = completedRun('部分内容', 'max-tokens')
    const { gateway } = makeGateway(run)
    const tool = createTeamDelegateTool({
      config,
      subagents: gateway,
      judge: async () => verdict({ executor: 'local-deepseek' }),
    })
    const result = await execute(tool, { task: 'x' }) as TeamDelegateResult
    expect(result.decision).toBe('fallback-leader')
    if (result.decision === 'fallback-leader') {
      expect(result.error).toContain('token limit')
      expect(result.error).toContain('部分内容')
    }
  })

  it('jev throwing returns a leader fail-open decision with the error', async () => {
    const { config, statsFile } = await tmpStatsConfig({ workers: WORKERS })
    const { gateway, start } = makeGateway(completedRun('unused'))
    const tool = createTeamDelegateTool({
      config,
      subagents: gateway,
      judge: async () => { throw new Error('jev request failed with status 401') },
    })
    const result = await execute(tool, { task: 'x' }) as TeamDelegateResult
    expect(start).not.toHaveBeenCalled()
    expect(result.decision).toBe('leader')
    if (result.decision === 'leader' && 'error' in result) {
      expect(result.error).toContain('401')
      expect(result.reason).toContain('fail-open')
    } else {
      throw new Error('expected leader decision with error')
    }
    const lines = (await readFile(statsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toMatchObject({ decision: 'leader', error: expect.stringContaining('401') })
  })

  it('throws (isError) when exec.agent is undefined', async () => {
    const { config } = await tmpStatsConfig()
    const { gateway } = makeGateway(completedRun('unused'))
    const tool = createTeamDelegateTool({ config, subagents: gateway })
    const exec = { ...fakeExec(), agent: undefined } as unknown as ToolRunContext
    await expect(execute(tool, { task: 'x' }, exec)).rejects.toThrow('exec.agent')
  })

  it('renders model-facing text with a natural-language routing line plus the JSON', async () => {
    const { config } = await tmpStatsConfig({ workers: WORKERS })
    const { gateway } = makeGateway(completedRun('done'))
    const tool = createTeamDelegateTool({
      config,
      subagents: gateway,
      judge: async () => verdict({ executor: 'local-deepseek' }),
    })
    const result = await execute(tool, { task: 'x' }) as TeamDelegateResult
    const content = tool.output.render({ task: 'x' }, result) as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toContain('路由结果')
    expect(content[0]!.text).toContain('local-deepseek')
    expect(content[0]!.text).toContain('"decision": "worker"')
  })
})
