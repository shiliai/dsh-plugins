import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WecomAgentBridge } from '../src/index.ts'
import type { InboundCardEvent } from '../src/bot.ts'

/** Minimal fake WecomBot exposing only what the question-card flow touches. */
function cardBot() {
  const sentCards: Array<{ chatId: string; card: any }> = []
  const updates: Array<{ frame: unknown; card: any; userids?: string[] | undefined }> = []
  const bot = {
    identity: 'bot-a',
    sentCards,
    updates,
    isReady: vi.fn(() => true),
    replyText: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendTemplateCard: vi.fn(async (chatId: string, card: any) => { sentCards.push({ chatId, card }) }),
    updateTemplateCard: vi.fn(async (frame: unknown, card: any, userids?: string[]) => { updates.push({ frame, card, userids }) }),
  }
  return bot
}

function emptyCtx() {
  return { get: () => undefined }
}

/** Wait for the deferred (setTimeout 0) provider registration to run. */
function flushRegistration(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function cardEvent(taskId: string, eventKey: string): InboundCardEvent {
  return {
    chatId: 'u1',
    chatType: 'single',
    senderId: 'user-1',
    taskId,
    eventKey,
    msgId: `evt-${taskId}-${eventKey}`,
    frame: { headers: { req_id: `req-${taskId}` } } as never,
  }
}

function submittedCardEvent(taskId: string, optionId: string): InboundCardEvent {
  return {
    ...cardEvent(taskId, 'submit'),
    selectedItems: [{ questionKey: QUESTION.id, optionIds: [optionId] }],
  }
}

const QUESTION = { id: 'q1', question: '请问需要哪种部署方式？', options: [{ label: '快速部署' }, { label: '标准部署' }] }

function installLiveState(bridge: WecomAgentBridge, agent: object, senderId = 'user-1'): void {
  const internals = bridge as unknown as { states: Map<string, unknown> }
  internals.states.set('single:u1', {
    chatId: 'u1', chatType: 'single', handle: { agent, dispose: async () => {} }, activeSenderId: senderId,
  })
}

describe('question card flow: template_card_event → session injection', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.clearAllMocks())

  it('constructs a bridge without a `userQuestions` service (safe optional lookup, no inject error)', async () => {
    // Regression: cordis blocks direct `ctx.userQuestions` property access when
    // `userQuestions` is not in the plugin `inject` array. The bridge must use a
    // safe optional `ctx.get` lookup and not throw when the service is absent.
    const bot = cardBot()
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    try {
      expect(bridge).toBeDefined()
    } finally {
      await bridge.dispose()
    }
  })

  it('registers the routed WeCom provider', async () => {
    const provider = {
      supportsRouting: true,
      registerProvider: vi.fn((channel: string, p: unknown) => {
        expect(channel).toBe('wecom')
        expect(p).toMatchObject({ ask: expect.any(Function) })
        return vi.fn()
      }),
    }
    const bot = cardBot()
    const bridge = new WecomAgentBridge({ get: (name: string) => (name === 'userQuestions' ? provider : undefined) } as never, bot as never, { botId: 'b', botSecret: 's', questionHostWaitMs: 0 })
    try {
      await bridge.registerUserQuestionsProvider()
      expect(provider.registerProvider).toHaveBeenCalledWith('wecom', expect.objectContaining({ ask: expect.any(Function) }))
      await bridge.dispose()
    } finally {
      await bridge.dispose()
    }
  })

  it('coexists with the DSH browser when an api-proxy host is present', async () => {
    const provider = {
      supportsRouting: true,
      registerProvider: vi.fn(() => vi.fn()),
    }
    const bot = cardBot()
    const bridge = new WecomAgentBridge({ get: (name: string) => (name === 'apiProxy' ? { live: true } : name === 'userQuestions' ? provider : undefined) } as never, bot as never, { botId: 'b', botSecret: 's', questionHostWaitMs: 0 })
    try {
      await bridge.registerUserQuestionsProvider()
      expect(bridge).toBeDefined()
      expect(provider.registerProvider).toHaveBeenCalledWith('wecom', expect.objectContaining({ ask: expect.any(Function) }))
    } finally {
      await bridge.dispose()
    }
  })

  it('keeps the connection available when WeCom channel registration fails', async () => {
    const provider = {
      supportsRouting: true,
      registerProvider: vi.fn(() => { throw Object.assign(new Error('a user-questions provider is already registered'), { code: 'DUPLICATE_PROVIDER' }) }),
    }
    const bot = cardBot()
    const bridge = new WecomAgentBridge({ get: (name: string) => (name === 'userQuestions' ? provider : undefined) } as never, bot as never, { botId: 'b', botSecret: 's', questionHostWaitMs: 0 })
    try {
      await bridge.registerUserQuestionsProvider()
      expect(bridge).toBeDefined()
      expect(provider.registerProvider).toHaveBeenCalledTimes(1)
    } finally {
      await bridge.dispose()
    }
  })

  it('reports routed questions unsupported on legacy single-provider DSH', async () => {
    const provider = { registerProvider: vi.fn(() => vi.fn()) }
    const bot = cardBot()
    const bridge = new WecomAgentBridge({ get: (name: string) => (name === 'userQuestions' ? provider : undefined) } as never, bot as never, { botId: 'b', botSecret: 's' })
    try {
      await expect(bridge.registerUserQuestionsProvider()).resolves.toBe('unsupported')
      expect(provider.registerProvider).not.toHaveBeenCalled()
    } finally {
      await bridge.dispose()
    }
  })

  it('reports corrupt binding storage independently from question capability', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-wecom-bindings-'))
    const bindingsFile = join(directory, 'bindings.json')
    await writeFile(bindingsFile, '{bad json', 'utf8')
    const bridge = new WecomAgentBridge(emptyCtx() as never, cardBot() as never, { botId: 'b', botSecret: 's', bindingsFile })
    try {
      expect(bridge.getCapabilityStatus()).toEqual({ questions: 'unknown', bindings: 'unknown' })
      await (bridge as unknown as { loadBindings(): Promise<unknown> }).loadBindings()
      expect(bridge.getCapabilityStatus()).toEqual({ questions: 'unknown', bindings: 'degraded' })
    } finally {
      await bridge.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('renders a multiple_interaction card and feeds the tapped choice back into the session', async () => {
    const bot = cardBot()
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    try {
      const pending = bridge.openQuestion('u1', QUESTION)
      // let sendTemplateCard resolve so the pending wait (keyed by task_id) is registered
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(bot.sendTemplateCard).toHaveBeenCalledTimes(1)
      const card = bot.sendTemplateCard.mock.calls[0]![1]
      expect(card.card_type).toBe('multiple_interaction')
      expect(card.task_id).toBeTruthy()

      // user taps the second option
      await bridge.onCardSelection(submittedCardEvent(card.task_id, '2'))
      const answer = await pending

      // the selection is delivered back into the same session as the answer
      expect(answer.answers).toEqual([{ id: 'q1', selected: ['标准部署'] }])
    } finally {
      await bridge.dispose()
    }
  })

  it('reflects the selection on the card (updateTemplateCard) when it arrives', async () => {
    const bot = cardBot()
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    try {
      const pending = bridge.openQuestion('u1', QUESTION)
      await new Promise(resolve => setTimeout(resolve, 0))
      const taskId = bot.sentCards[0]!.card.task_id as string
      await bridge.onCardSelection(cardEvent(taskId, `${QUESTION.id}::1`))
      await pending
      expect(bot.updateTemplateCard).toHaveBeenCalledTimes(1)
      const update = bot.updates[0]!
      expect(update.card.task_id).toBe(taskId)
      expect(update.userids).toEqual(['user-1'])
      expect(update.card.sub_title_text).toContain('快速部署')
    } finally {
      await bridge.dispose()
    }
  })

  it('still feeds the selection into the session when reflecting the card update fails', async () => {
    const bot = cardBot()
    bot.updateTemplateCard = vi.fn(async () => { throw new Error('update transport failure') })
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    try {
      const pending = bridge.openQuestion('u1', QUESTION)
      await new Promise(resolve => setTimeout(resolve, 0))
      await bridge.onCardSelection(cardEvent(bot.sentCards[0]!.card.task_id, `${QUESTION.id}::2`))
      await expect(pending).resolves.toMatchObject({ answers: [{ id: 'q1', selected: ['标准部署'] }] })
    } finally {
      await bridge.dispose()
    }
  })

  it('accepts only the originating chat and sender, then ignores duplicate taps', async () => {
    const bot = cardBot()
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    const agent = {}
    installLiveState(bridge, agent)
    try {
      const pending = bridge.openQuestion('u1', QUESTION, {
        chatKey: 'single:u1', senderId: 'user-1', agent: agent as never,
      })
      await flushRegistration()
      const taskId = bot.sentCards[0]!.card.task_id as string
      await bridge.onCardSelection({ ...cardEvent(taskId, `${QUESTION.id}::1`), chatId: 'u2' })
      await bridge.onCardSelection({ ...cardEvent(taskId, `${QUESTION.id}::1`), senderId: 'user-2' })
      expect(bot.updateTemplateCard).not.toHaveBeenCalled()

      await bridge.onCardSelection(cardEvent(taskId, `${QUESTION.id}::2`))
      await expect(pending).resolves.toMatchObject({ answers: [{ selected: ['标准部署'] }] })
      await bridge.onCardSelection(cardEvent(taskId, `${QUESTION.id}::1`))
      expect(bot.updateTemplateCard).toHaveBeenCalledTimes(1)
    } finally {
      await bridge.dispose()
    }
  })

  it('settles an aborted question once and makes its card stale', async () => {
    const bot = cardBot()
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    const agent = {}
    const abort = new AbortController()
    installLiveState(bridge, agent)
    try {
      const pending = bridge.openQuestion('u1', QUESTION, {
        chatKey: 'single:u1', senderId: 'user-1', agent: agent as never, signal: abort.signal,
      })
      await flushRegistration()
      const taskId = bot.sentCards[0]!.card.task_id as string
      abort.abort()
      await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
      await bridge.onCardSelection(cardEvent(taskId, `${QUESTION.id}::1`))
      expect(bot.updateTemplateCard).not.toHaveBeenCalled()
    } finally {
      await bridge.dispose()
    }
  })

  it('rejects a pending card once when the bridge is disposed', async () => {
    const bot = cardBot()
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    const pending = bridge.openQuestion('u1', QUESTION)
    await flushRegistration()
    const settled = expect(pending).rejects.toMatchObject({ code: 'WECOM_DISPOSED' })

    await bridge.dispose()

    await settled
  })

  it('routes provider asks only to the exact live WeCom turn owner', async () => {
    let registered: { ask(request: unknown): Promise<unknown> } | undefined
    const service = {
      supportsRouting: true,
      registerProvider: vi.fn((_channel: string, provider: typeof registered) => {
        registered = provider
        return vi.fn()
      }),
    }
    const bot = cardBot()
    const bridge = new WecomAgentBridge({ get: (name: string) => name === 'userQuestions' ? service : undefined } as never, bot as never, { botId: 'b', botSecret: 's' })
    const agent = {}
    installLiveState(bridge, agent)
    try {
      await bridge.registerUserQuestionsProvider()
      await expect(registered!.ask({
        questions: [QUESTION], agent,
        route: { channel: 'wecom', destination: 'single:other' },
      })).rejects.toMatchObject({ code: 'WECOM_CALLER_NOT_LIVE' })

      const pending = registered!.ask({
        questions: [QUESTION], agent,
        route: { channel: 'wecom', destination: 'single:u1' },
      })
      await flushRegistration()
      const taskId = bot.sentCards.at(-1)!.card.task_id as string
      await bridge.onCardSelection(cardEvent(taskId, `${QUESTION.id}::1`))
      await expect(pending).resolves.toMatchObject({ answers: [{ selected: ['快速部署'] }] })
    } finally {
      await bridge.dispose()
    }
  })

  it('ignores a card event whose task_id has no pending question', async () => {
    const bot = cardBot()
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    try {
      await bridge.onCardSelection(cardEvent('task-unknown', 'q1::1'))
      expect(bot.updateTemplateCard).not.toHaveBeenCalled()
    } finally {
      await bridge.dispose()
    }
  })

  it('falls back to readable text when a question cannot be card-rendered', async () => {
    const bot = cardBot()
    const bridge = new WecomAgentBridge(emptyCtx() as never, bot as never, { botId: 'b', botSecret: 's' })
    try {
      await expect(
        bridge.openQuestion('u1', { id: 'q2', question: '请输入你的想法' }),
      ).rejects.toMatchObject({ code: 'WECOM_CARD_UNRENDERABLE' })
      expect(bot.sendText).toHaveBeenCalledWith('u1', '请输入你的想法')
      expect(bot.sendTemplateCard).not.toHaveBeenCalled()
    } finally {
      await bridge.dispose()
    }
  })
})
