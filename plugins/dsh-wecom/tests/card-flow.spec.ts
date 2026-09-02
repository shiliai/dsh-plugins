import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const QUESTION = { id: 'q1', question: '请问需要哪种部署方式？', options: [{ label: '快速部署' }, { label: '标准部署' }] }

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

  it('registers as the provider when no browser host is present (standalone)', async () => {
    const provider = {
      registerProvider: vi.fn((p: unknown) => {
        expect(p).toMatchObject({ ask: expect.any(Function) })
        return vi.fn()
      }),
    }
    const bot = cardBot()
    const bridge = new WecomAgentBridge({ get: (name: string) => (name === 'userQuestions' ? provider : undefined) } as never, bot as never, { botId: 'b', botSecret: 's', questionHostWaitMs: 0 })
    try {
      await bridge.registerUserQuestionsProvider()
      expect(provider.registerProvider).toHaveBeenCalledTimes(1)
      await bridge.dispose()
    } finally {
      await bridge.dispose()
    }
  })

  it('defers to the DSH browser (no registration) when an api-proxy host is present', async () => {
    const provider = {
      registerProvider: vi.fn(() => { throw Object.assign(new Error('a user-questions provider is already registered'), { code: 'DUPLICATE_PROVIDER' }) }),
    }
    const bot = cardBot()
    const bridge = new WecomAgentBridge({ get: (name: string) => (name === 'apiProxy' ? { live: true } : name === 'userQuestions' ? provider : undefined) } as never, bot as never, { botId: 'b', botSecret: 's', questionHostWaitMs: 0 })
    try {
      await bridge.registerUserQuestionsProvider()
      expect(bridge).toBeDefined()
      expect(provider.registerProvider).not.toHaveBeenCalled()
    } finally {
      await bridge.dispose()
    }
  })

  it('still registers and survives when another UI raced us (DUPLICATE_PROVIDER caught)', async () => {
    // `userQuestions` allows a single provider. Even if the host registered
    // before our deferred attempt, `registerProvider` throws DUPLICATE_PROVIDER
    // and the bridge must catch it and continue instead of failing startup.
    const provider = {
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
      await bridge.onCardSelection(cardEvent(card.task_id, `${QUESTION.id}::2`))
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
