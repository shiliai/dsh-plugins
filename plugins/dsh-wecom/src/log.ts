/**
 * Minimal leveled logger for dsh-wecom.
 *
 * The review deliberately silenced the SDK's noisy DEBUG logs (they serialize
 * full inbound message bodies) and stripped most plugin `console.log`s, which
 * made live debugging hard. This restores *diagnostic* visibility while still
 * honoring the privacy rule: no log helper here ever writes a message body,
 * token, or raw frame — callers pass only identity + counters, and anything
 * sensitive is the caller's job to redact before passing as `extra`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Numeric severity, higher = more verbose. */
const SEVERITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in SEVERITY
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
}

/** A no-op logger (used by the SDK passthrough when debug is disabled). */
export const SILENT_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function safeExtra(extra: Record<string, unknown> | undefined): string {
  if (!extra || Object.keys(extra).length === 0) return ''
  try {
    return ` ${JSON.stringify(extra)}`
  } catch {
    return ' { [unserializable] }'
  }
}

const toConsole: Record<Exclude<LogLevel, 'debug'>, (msg: string) => void> = {
  info: (m) => console.log(`[dsh-wecom] ${m}`),
  warn: (m) => console.warn(`[dsh-wecom] ${m}`),
  error: (m) => console.error(`[dsh-wecom] ${m}`),
}

export function makeLogger(level: LogLevel, tag = 'dsh-wecom'): Logger {
  const threshold = SEVERITY[level] ?? SEVERITY.info
  const at = (lvl: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    if (SEVERITY[lvl] > threshold) return
    const line = `${msg}${safeExtra(extra)}`
    if (lvl === 'debug') {
      // eslint-disable-next-line no-console
      console.debug(`[${tag}] ${line}`)
    } else {
      toConsole[lvl](line)
    }
  }
  return {
    debug: (m, e) => at('debug', m, e),
    info: (m, e) => at('info', m, e),
    warn: (m, e) => at('warn', m, e),
    error: (m, e) => at('error', m, e),
  }
}

/**
 * Adapt a {@link Logger} to the shape the WeCom SDK expects. We forward only
 * info/warn/error (SDK "Authentication successful", connect, disconnect) and
 * DROP debug entirely — the SDK logs full frame bodies at debug, which we
 * must never write. Callers can still get our own debug lines via {@link Logger.debug}.
 */
export function sdkLogger(log: Logger): { debug: () => void; info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } {
  const strip = (m: string): string => String(m).replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*\[[^]]*\]\s*/i, '')
  return {
    debug: () => {},
    info: (m) => log.info(`sdk: ${strip(m)}`),
    warn: (m) => log.warn(`sdk: ${strip(m)}`),
    error: (m) => log.error(`sdk: ${strip(m)}`),
  }
}
