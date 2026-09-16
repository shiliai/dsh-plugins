/**
 * Minimal leveled logger with the dsh-wecom shape, so cron diagnostics appear
 * beside the rest of the plugin fleet.
 * @module @dsh-plugins/dsh-cron/log
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export interface Logger {
  error(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  debug(message: string, details?: unknown): void
}

export function isLogLevel(value: unknown): value is LogLevel {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug'
}

export function makeLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVELS[level]
  const write = (name: LogLevel, message: string, details?: unknown): void => {
    if (LEVELS[name] > threshold) return
    const line = details === undefined ? `[dsh-cron] ${message}` : `[dsh-cron] ${message} ${JSON.stringify(details)}`
    if (name === 'error') console.error(line)
    else if (name === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    error: (message, details) => write('error', message, details),
    warn: (message, details) => write('warn', message, details),
    info: (message, details) => write('info', message, details),
    debug: (message, details) => write('debug', message, details),
  }
}
