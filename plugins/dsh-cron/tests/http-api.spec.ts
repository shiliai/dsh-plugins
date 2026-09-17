import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerCronApi } from '../src/http-api.ts'
import { CronController } from '../src/controller.ts'
import { CronScheduler } from '../src/scheduler.ts'
import { CronStore } from '../src/store.ts'
import { normalizeCronConfig } from '../src/config.ts'

interface CapturedRoute {
  handler(request: IncomingMessage, response: ServerResponse): Promise<void> | void
}

function makeHarness() {
  let captured: CapturedRoute | undefined
  const webServer = {
    register: (route: CapturedRoute) => {
      captured = route
      return () => undefined
    },
  }
  const ctx = {
    tools: { register: () => () => undefined },
    agents: {},
    sessions: {},
    get(service: string) {
      return service === 'webServer' ? webServer : undefined
    },
    effect() {
      return () => undefined
    },
  }
  const store = CronStore.open(undefined, () => undefined)
  return {
    ctx: ctx as never,
    webServer: webServer as never,
    route: () => {
      if (captured === undefined) throw new Error('route not registered')
      return captured
    },
    controller: store.then(async st => {
      const scheduler = new CronScheduler({
        ctx: {} as never,
        store: st,
        config: normalizeCronConfig(undefined),
        warn: () => undefined,
        info: () => undefined,
      })
      return new CronController({ ctx: {} as never, store: st, scheduler, historyLimit: 50, info: () => undefined })
    }),
  }
}

function fakeRequest(method: string, url: string, headers: Record<string, string>): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage
}

function fakeResponse(): { response: ServerResponse; status(): number; body(): Record<string, unknown> } {
  let statusCode = 0
  let payload = ''
  const response = {
    writeHead(status: number, _headers?: unknown) {
      statusCode = status
      return response
    },
    end(body?: string) {
      if (body !== undefined) payload = body
    },
  }
  return {
    response: response as unknown as ServerResponse,
    status: () => statusCode,
    body: () => JSON.parse(payload || '{}') as Record<string, unknown>,
  }
}

const VALID_SPEC = {
  name: 'demo-job',
  trigger: { kind: 'oneshot', at: '2099-01-01T08:00:00+08:00' },
  task: { kind: 'command', argv: ['/bin/true'] },
}

describe('dsh-cron HTTP API', () => {
  it('registers the prefix route and serves state', async () => {
    const harness = makeHarness()
    registerCronApi(harness.ctx, harness.webServer, await harness.controller)

    const get = fakeResponse()
    await harness.route().handler(fakeRequest('GET', '/dsh-cron/api/state', {}), get.response)
    expect(get.status()).toBe(200)
    expect(get.body()).toMatchObject({ jobs: [] })
  })

  it('rejects mutations without the JSON content-type fence', async () => {
    const harness = makeHarness()
    registerCronApi(harness.ctx, harness.webServer, await harness.controller)

    const crossSite = fakeResponse()
    await harness.route().handler(
      fakeRequest('POST', '/dsh-cron/api/jobs', { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }),
      crossSite.response,
    )
    expect(crossSite.status()).toBe(403)

    const noType = fakeResponse()
    await harness.route().handler(fakeRequest('POST', '/dsh-cron/api/jobs', {}), noType.response)
    expect(noType.status()).toBe(403)
  })

  it('create -> duplicate name rejected -> enable/disable -> delete', async () => {
    const harness = makeHarness()
    const controller = await harness.controller

    const created = await controller.createManualJob(VALID_SPEC)
    expect(created.ok).toBe(true)
    const id = created.job!.job.id

    const duplicate = await controller.createManualJob(VALID_SPEC)
    expect(duplicate.ok).toBe(false)
    expect(duplicate.field).toBe('name')

    const disabled = await controller.setEnabled(id, false)
    expect(disabled.ok).toBe(true)
    expect(disabled.job!.job.enabled).toBe(false)

    const enabled = await controller.setEnabled(id, true)
    expect(enabled.job!.job.enabled).toBe(true)

    const removed = await controller.removeJob(id)
    expect(removed.ok).toBe(true)
    expect(controller.jobView(id)).toBeUndefined()
    expect((await controller.removeJob(id)).ok).toBe(false)
  })

  it('rejects invalid specs with the offending field name', async () => {
    const harness = makeHarness()
    const controller = await harness.controller
    const bad = await controller.createManualJob({
      name: 'bad-window',
      trigger: { kind: 'cron', expr: '0 8 * * *', timeZone: 'Asia/Shanghai' },
      task: { kind: 'agent', prompt: 'x' },
    })
    expect(bad.ok).toBe(false)
    expect(bad.field).toBe('window')
    expect(bad.error).toContain('有效期')
  })

  it('refuses to delete config-sourced jobs', async () => {
    const harness = makeHarness()
    const controller = await harness.controller
    const created = await controller.createManualJob(VALID_SPEC)
    const id = created.job!.job.id
    const view = controller.jobView(id)!
    void view
    // Re-source the job through the store to simulate a config declaration.
    const st = await CronStore.open(undefined, () => undefined)
    void st
    const job = (controller.state().jobs.find(entry => entry.job.id === id))!.job
    job.source = 'config'
    const removed = await controller.removeJob(id)
    expect(removed.ok).toBe(false)
    expect(removed.error).toContain('config')
  })
})
