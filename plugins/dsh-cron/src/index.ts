/**
 * dsh-cron — host-side unattended scheduler for DeepSeek Harness.
 *
 * Jobs are trigger (cron / interval / one-shot) + task (one-shot agent or
 * command subprocess) + reliability policy (overlap / misfire / at-most-once)
 * + optional command delivery. Manual jobs are created at runtime from the
 * Web overlay or the cron_* tools and persist in the `cron` storage domain;
 * they never belong to an interactive session. Design: docs/plans/dsh-cron-v1.md.
 *
 * @module @dsh-plugins/dsh-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { normalizeCronConfig } from './config.ts'
import { CronController } from './controller.ts'
import { registerCronApi } from './http-api.ts'
import { isLogLevel, makeLogger, type Logger, type LogLevel } from './log.ts'
import { registerCronSkill } from './skill.ts'
import { CronScheduler } from './scheduler.ts'
import { CronStore, type StorageLike } from './store.ts'
import { registerCronTools } from './tools.ts'
import type { CronConfig } from './types.ts'

export const name = 'dsh-cron'
export const inject = ['tools', 'agents', 'sessions', 'storage']

export type { CronConfig } from './types.ts'
export { normalizeCronConfig } from './config.ts'
export { CronController } from './controller.ts'
export { CronScheduler } from './scheduler.ts'
export { CronStore } from './store.ts'
export { normalizeJobSpec, ValidationError, NAME_PATTERN, MIN_INTERVAL_SECONDS, MAX_WINDOW_SECONDS } from './validate.ts'

export interface ApplyOptions {
  logLevel?: LogLevel
}

export async function apply(ctx: Context, config: CronConfig = {}, options: ApplyOptions = {}): Promise<void> {
  const normalized = normalizeCronConfig(config)
  const logLevel = isLogLevel((config as { logLevel?: unknown }).logLevel) ? (config as { logLevel: LogLevel }).logLevel : options.logLevel ?? 'info'
  const log: Logger = makeLogger(logLevel)
  log.info('apply boot', normalized)

  const store = await CronStore.open((ctx as unknown as { storage?: StorageLike }).storage, message => log.warn(message))
  const repaired = await store.repairInterrupted()
  if (repaired > 0) log.info(`crash repair: ${repaired} interrupted run(s) marked aborted`)

  const scheduler = new CronScheduler({
    ctx,
    store,
    config: normalized,
    warn: message => log.warn(message),
    info: message => log.info(message),
  })
  const controller = new CronController({ ctx, store, scheduler, historyLimit: normalized.historyLimit, info: message => log.info(message) })

  const toolDisposers = registerCronTools(ctx, controller)
  const skillDisposer = registerCronSkill(ctx)

  // The web overlay is optional: headless profiles mount without a webServer.
  const webServer = ctx.get('webServer') as WebServer | undefined
  let apiDisposer: (() => void) | undefined
  if (webServer !== undefined && typeof webServer.register === 'function') {
    apiDisposer = registerCronApi(ctx, webServer, controller)
    log.info('web api registered', { prefix: '/dsh-cron/api' })
  } else {
    log.info('no webServer service; web api skipped (headless profile)')
  }

  scheduler.start()

  ctx.effect(() => async () => {
    log.info('shutdown')
    scheduler.dispose().catch(() => undefined)
    apiDisposer?.()
    skillDisposer?.()
    for (const dispose of toolDisposers) dispose()
  }, 'dsh-cron.dispose')
}

export default { name, inject, apply }
