import { randomUUID } from 'node:crypto'
import { TemplateCardType } from '@wecom/aibot-node-sdk'
import type { TemplateCard } from '@wecom/aibot-node-sdk'

/**
 * Structural subset of the `@deepseek-ai/dsh-user-questions` wire types. The
 * plugin deliberately defines these locally (mirroring the live `ask_user_question`
 * tool contract) so it can render questions without a hard dependency on that
 * package.
 */

/** One selectable choice offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}

/** One question in an `ask_user_question` request. */
export interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question. */
  detail?: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. WeCom renders single-select only. */
  multiSelect?: boolean
  /** Optional presentation intent; the plugin renders the generic option list. */
  intent?: unknown
}

/** Selected option or custom text for one question. */
export interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}

/** The human's answer, delivered back into the DSH session. */
export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[]
}

/** The `userQuestions.ask` request the plugin's provider receives. */
export interface AskUserQuestionRequest {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Exact live calling agent (opaque to the plugin). */
  agent?: unknown
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
}

/** Structured error thrown when an interactive question cannot be completed. */
export class QuestionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'QuestionError'
  }
}

/**
 * WeCom `multiple_interaction` template cards render each question as a
 * dropdown selector plus one submit button. Selectors render comfortably up to
 * this many options; questions with more options (or no options) fall back to
 * readable text.
 */
export const MAX_CARD_OPTIONS = 5

/** A question that can be rendered as an interactive WeCom card. */
export interface CardQuestion {
  /** stable question id echoed in the answer */
  id: string
  /** the question to display */
  question: string
  /** selectable options (1..MAX_CARD_OPTIONS) */
  options: CardOption[]
  /** unique WeCom card task_id used to correlate the tap event */
  taskId: string
}

export interface CardOption {
  /** short stable id for the option (1-based index) */
  id: string
  /** user-facing label (echoed back as the selection) */
  label: string
}

/** Generate a unique WeCom template-card task_id. */
export function generateTaskId(): string {
  return `wsq_${Date.now()}_${randomUUID()}`
}

/**
 * Normalize an `AskUserQuestionItem` into a cardable question, or `undefined`
 * when it cannot be card-rendered (no options, more than MAX_CARD_OPTIONS, or a
 * multi-select question WeCom's single-select card cannot express). Multi-select
 * and out-of-range questions fall back to readable text.
 */
export function toCardQuestion(item: AskUserQuestionItem, taskId: string): CardQuestion | undefined {
  if (item.multiSelect === true) return undefined
  const options: CardOption[] = []
  for (const option of item.options ?? []) {
    if (options.length >= MAX_CARD_OPTIONS) return undefined
    options.push({ id: String(options.length + 1), label: option.label })
  }
  if (options.length === 0) return undefined
  return { id: item.id, question: item.question, options, taskId }
}

/** Build the WeCom `multiple_interaction` card a question maps to. */
export function buildQuestionCard(q: CardQuestion): TemplateCard {
  return {
    card_type: TemplateCardType.MultipleInteraction,
    source: { desc: '请在下方选择一个选项', desc_color: 0 },
    main_title: { title: q.question.slice(0, 26) },
    select_list: [
      {
        question_key: q.id,
        title: q.question,
        option_list: q.options.map(option => ({ id: option.id, text: option.label })),
      },
    ],
    submit_button: { text: '提交选择', key: 'submit' },
    task_id: q.taskId,
  }
}

/**
 * Resolve the option selected by a template-card event. WeCom encodes a
 * `multiple_interaction` submission in `event_key` as
 * `<question_key>::<option_id>`; we accept that shape and, defensively, a bare
 * option id or label. Returns `undefined` when the event does not reference a
 * known option of this question.
 */
export function resolveSelection(eventKey: string | undefined, q: CardQuestion): CardOption | undefined {
  if (!eventKey) return undefined
  const tail = eventKey.split('::').pop() ?? ''
  return q.options.find(option => option.id === tail || option.label === tail)
}

/** The card shown after a selection so the user sees their choice. */
export function buildSelectionCard(q: CardQuestion, label: string): TemplateCard {
  return {
    card_type: TemplateCardType.TextNotice,
    main_title: { title: '已选择' },
    sub_title_text: `${q.question}\n✅ ${label}`,
    task_id: q.taskId,
  }
}

/** Render a question as readable numbered text (card fallback). */
export function renderQuestionText(question: AskUserQuestionItem): string {
  const lines = [question.question]
  ;(question.options ?? []).forEach((option, index) => lines.push(`${index + 1}. ${option.label}`))
  return lines.join('\n')
}

/** Map a selected option to the answer delivered back into the DSH session. */
export function toAnswer(q: CardQuestion, option: CardOption): AskUserQuestionAnswer {
  return { answers: [{ id: q.id, selected: [option.label] }] }
}
