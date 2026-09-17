/**
 * Command task execution and command delivery: spawn the argv, capture a
 * bounded output tail, enforce the timeout with SIGTERM then SIGKILL.
 * @module @dsh-plugins/dsh-cron/command-runner
 */

import { spawn } from 'node:child_process'
import type { CommandDelivery } from './types.ts'

export interface CommandOutcome {
  ok: boolean
  exitCode: number | null
  outputTail: string
  error?: string
  timedOut?: boolean
  aborted?: boolean
}

/** Keep at most the last `maxBytes` of combined output, on line boundaries. */
export function tailOutput(chunks: Buffer[], maxBytes = 8 * 1024): string {
  const combined = Buffer.concat(chunks)
  const clipped = combined.byteLength > maxBytes ? combined.subarray(combined.byteLength - maxBytes) : combined
  const text = clipped.toString('utf8')
  const lines = text.split('\n')
  return lines.length > 200 ? lines.slice(-200).join('\n') : text
}

export function runCommand(argv: string[], options: { cwd?: string; timeoutMs: number; signal: AbortSignal }): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, exitCode: null, outputTail: '', error: `spawn 失败: ${error instanceof Error ? error.message : String(error)}` })
      return
    }

    const chunks: Buffer[] = []
    let settled = false
    let timedOut = false
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk))

    const finish = (outcome: CommandOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => {
      if (settled) return
      kill('SIGTERM')
      finish({ ok: false, exitCode: null, outputTail: tailOutput(chunks), error: '运行被停止', aborted: true })
    }
    const kill = (signalName: NodeJS.Signals): void => {
      try {
        child.kill(signalName)
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 5_000).unref?.()
    }, options.timeoutMs)
    timer.unref?.()

    options.signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      finish({ ok: false, exitCode: null, outputTail: tailOutput(chunks), error: `子进程错误: ${error.message}`, ...(timedOut ? { timedOut: true } : {}) })
    })
    child.on('close', (code, signalReceived) => {
      const tail = tailOutput(chunks)
      if (timedOut) {
        finish({ ok: false, exitCode: code, outputTail: tail, error: `任务超时(${Math.round(options.timeoutMs / 1000)}s),已终止`, timedOut: true })
        return
      }
      if (options.signal.aborted && code === null) {
        finish({ ok: false, exitCode: null, outputTail: tail, error: '运行被停止', aborted: true })
        return
      }
      if (code === null) {
        finish({ ok: false, exitCode: null, outputTail: tail, error: `子进程被信号终止: ${signalReceived ?? 'unknown'}` })
        return
      }
      finish({
        ok: code === 0,
        exitCode: code,
        outputTail: tail,
        ...(code !== 0 ? { error: `退出码 ${code}` } : {}),
      })
    })
  })
}

export interface DeliveryOutcome {
  exitCode: number
  outputTail?: string
}

/** Feed the run record to the delivery argv's stdin (design §4, command delivery). */
export async function runDelivery(delivery: CommandDelivery, recordJson: string, cwd: string | undefined): Promise<DeliveryOutcome> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(delivery.argv[0]!, delivery.argv.slice(1), { cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ exitCode: -1, outputTail: `spawn 失败: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const chunks: Buffer[] = []
    let settled = false
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk))
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, outputTail: tailOutput(chunks, 4 * 1024) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, 3_000).unref?.()
    }, (delivery.timeoutSeconds ?? 60) * 1000)
    timer.unref?.()
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(recordJson)
  })
}
