import type { WsFrame } from '@wecom/aibot-node-sdk'

export interface TurnResult {
  text: string
  ok: boolean
}

/** Extract replyable plain text from a WeCom message frame. */
export function extractTextFromFrame(frame: WsFrame): string {
  const body = frame?.body ?? {}
  const text = (body.text?.content ?? '') as string
  return String(text).trim()
}

/** Aggregate the last assistant text and turn outcome from a session event suffix. */
export function summarizeTurn(events: readonly unknown[], firstSeq: number): TurnResult {
  let started = false
  let text = ''
  let ok = false
  for (const event of events as Array<{
    seq?: number
    type?: string
    data?: {
      message?: { content?: Array<{ type?: string; text?: string }> }
      reason?: { kind?: string }
    }
  }>) {
    if (event.seq === undefined || event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = (event.data?.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') ok = (event.data?.reason?.kind ?? '') === 'completed'
  }
  return { text, ok }
}
