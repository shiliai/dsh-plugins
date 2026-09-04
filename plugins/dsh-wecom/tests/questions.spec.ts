import { describe, expect, it } from 'vitest'
import { TemplateCardType } from '@wecom/aibot-node-sdk'
import {
  MAX_CARD_OPTIONS,
  buildQuestionCard,
  buildSelectionCard,
  renderQuestionText,
  resolveSelection,
  toAnswer,
  toCardQuestion,
  type AskUserQuestionItem,
} from '../src/questions.ts'

function item(overrides: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
  return {
    id: 'q1',
    question: '请问需要哪种部署方式？',
    options: [
      { label: '快速部署' },
      { label: '标准部署' },
      { label: '自定义部署' },
    ],
    ...overrides,
  }
}

describe('toCardQuestion (structured question → cardable question)', () => {
  it('maps options to 1-based ids and keeps a stable task id', () => {
    const q = toCardQuestion(item(), 'task-1')
    expect(q).toEqual({
      id: 'q1',
      question: '请问需要哪种部署方式？',
      options: [
        { id: '1', label: '快速部署' },
        { id: '2', label: '标准部署' },
        { id: '3', label: '自定义部署' },
      ],
      taskId: 'task-1',
    })
  })

  it('returns undefined when there are no selectable options', () => {
    expect(toCardQuestion(item({ options: [] }), 'task-1')).toBeUndefined()
    expect(toCardQuestion({ id: 'q1', question: '无选项问题' }, 'task-1')).toBeUndefined()
  })

  it('returns undefined when there are more than MAX_CARD_OPTIONS options', () => {
    const options = Array.from({ length: MAX_CARD_OPTIONS + 1 }, (_, i) => ({ label: `选项${i + 1}` }))
    expect(toCardQuestion(item({ options }), 'task-1')).toBeUndefined()
  })

  it('caps at MAX_CARD_OPTIONS options', () => {
    const options = Array.from({ length: MAX_CARD_OPTIONS }, (_, i) => ({ label: `选项${i + 1}` }))
    expect(toCardQuestion(item({ options }), 'task-1')?.options).toHaveLength(MAX_CARD_OPTIONS)
  })

  it('returns undefined for multi-select questions (WeCom renders single-select only)', () => {
    expect(toCardQuestion(item({ multiSelect: true }), 'task-1')).toBeUndefined()
  })
})

describe('buildQuestionCard (rendering payload)', () => {
  it('builds a multiple_interaction card with the question and options', () => {
    const q = toCardQuestion(item(), 'task-9')!
    const card = buildQuestionCard(q)
    expect(card.card_type).toBe(TemplateCardType.MultipleInteraction)
    expect(card.task_id).toBe('task-9')
    expect(card.select_list).toEqual([
      {
        question_key: 'q1',
        title: '请问需要哪种部署方式？',
        option_list: [
          { id: '1', text: '快速部署' },
          { id: '2', text: '标准部署' },
          { id: '3', text: '自定义部署' },
        ],
      },
    ])
    expect(card.submit_button).toEqual({ text: '提交选择', key: 'submit' })
    expect(card.main_title?.title).toBe('请问需要哪种部署方式？')
  })

  it('truncates the main title to a safe length for WeCom', () => {
    const long = item({ question: '这是一个特别特别特别特别特别特别特别长的问题标题用来测试截断行为' })
    const card = buildQuestionCard(toCardQuestion(long, 'task-1')!)
    expect(card.main_title!.title!.length).toBeLessThanOrEqual(26)
  })
})

describe('renderQuestionText (readable fallback)', () => {
  it('renders the question with numbered options', () => {
    expect(renderQuestionText(item())).toBe('请问需要哪种部署方式？\n1. 快速部署\n2. 标准部署\n3. 自定义部署')
  })
})

describe('resolveSelection (template_card_event → chosen option)', () => {
  const q = toCardQuestion(item(), 'task-1')!

  it('parses the WeCom `question_key::option_id` shape', () => {
    expect(resolveSelection('q1::2', q)?.label).toBe('标准部署')
  })

  it('accepts a bare option id', () => {
    expect(resolveSelection('3', q)?.label).toBe('自定义部署')
  })

  it('accepts a bare option label', () => {
    expect(resolveSelection('快速部署', q)?.label).toBe('快速部署')
  })

  it('returns undefined for an unknown option or missing key', () => {
    expect(resolveSelection('q1::nope', q)).toBeUndefined()
    expect(resolveSelection(undefined, q)).toBeUndefined()
    expect(resolveSelection('', q)).toBeUndefined()
  })
})

describe('toAnswer / buildSelectionCard (selection fed back into the session)', () => {
  it('maps the chosen option to the structured answer delivered to the session', () => {
    const q = toCardQuestion(item(), 'task-1')!
    const answer = toAnswer(q, q.options[1]!)
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['标准部署'] }])
  })

  it('builds a disabled multiple_interaction card reflecting the choice', () => {
    const q = toCardQuestion(item(), 'task-1')!
    const card = buildSelectionCard(q, q.options[1]!)
    expect(card.card_type).toBe(TemplateCardType.MultipleInteraction)
    expect(card.task_id).toBe('task-1')
    expect(card.source).toEqual({ desc: '已提交选择', desc_color: 3 })
    expect(card.select_list).toEqual([
      {
        question_key: 'q1',
        title: '请问需要哪种部署方式？',
        disable: true,
        selected_id: '2',
        option_list: [
          { id: '1', text: '快速部署' },
          { id: '2', text: '标准部署' },
          { id: '3', text: '自定义部署' },
        ],
      },
    ])
    expect(card.submit_button).toEqual({ text: '已提交', key: 'submitted' })
  })
})
