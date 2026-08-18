import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const pageHtml = execFileSync('python3', ['-c', [
  'import importlib.util',
  'import sys, types',
  "yaml = types.ModuleType('yaml')",
  'yaml.safe_load = lambda value: {}',
  "yaml.safe_dump = lambda value, sort_keys=False: 'fixture'",
  "sys.modules['yaml'] = yaml",
  "spec = importlib.util.spec_from_file_location('remote_hub', 'scripts/remote-hub.py')",
  'module = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'print(module.render_admin_page())',
].join('; ')], { cwd: root, encoding: 'utf8' })
const screenshots = await mkdtemp(join(tmpdir(), 'dsh-hub-admin-browser-'))
const browser = await chromium.launch({ channel: 'chrome' })

try {
  const verifyRefreshSingleFlight = async (html, label, requireSecondRequest = false) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const statusUrl = 'https://hub.test/private/status'
    let requestCount = 0
    let activeRequests = 0
    let maxActiveRequests = 0
    const resolvers = []
    let firstRequest
    let secondRequest
    const firstRequestSeen = new Promise(resolve => { firstRequest = resolve })
    const secondRequestSeen = new Promise(resolve => { secondRequest = resolve })
    await page.route('https://hub.test/private', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
    await page.route(statusUrl, async route => {
      requestCount += 1
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      if (requestCount === 1) firstRequest()
      if (requestCount === 2) secondRequest()
      await new Promise(resolve => resolvers.push(resolve))
      try {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ instances: [] }) })
      } finally {
        activeRequests -= 1
      }
    })
    try {
      await page.goto('https://hub.test/private')
      await firstRequestSeen
      await page.locator('#refresh').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      if (requireSecondRequest) {
        await Promise.race([
          secondRequestSeen,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: second request was not observed`)), 1_000)),
        ])
      } else {
        await page.waitForTimeout(150)
      }
      if (requestCount !== 1 || maxActiveRequests !== 1) {
        throw new Error(`${label}: expected one in-flight request, got count=${requestCount} max=${maxActiveRequests}`)
      }
    } finally {
      for (const resolve of resolvers.splice(0)) resolve()
      await context.close()
    }
  }

  await verifyRefreshSingleFlight(pageHtml, 'production single-flight guard')
  const unguardedPageHtml = pageHtml.replace('if (inFlight !== null) return inFlight;', '')
  if (unguardedPageHtml === pageHtml) throw new Error('Mutation setup failed: single-flight guard was not removed.')
  let mutationWasCaught = false
  try {
    await verifyRefreshSingleFlight(unguardedPageHtml, 'single-flight guard mutation', true)
  } catch (error) {
    if (!String(error.message).includes('got count=2 max=2')) throw error
    mutationWasCaught = true
  }
  if (!mutationWasCaught) throw new Error('Mutation check failed: removing the single-flight guard did not fail the production assertion.')

  const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 360, height: 800 } })
  const page = await context.newPage()
  const statusUrl = 'https://hub.test/private/status'
  let requestCount = 0
  let activeRequests = 0
  let maxActiveRequests = 0
  let resolveFirst
  const firstResponse = new Promise(resolve => { resolveFirst = resolve })
  const responses = [
    firstResponse,
    { instances: [] },
    { instances: [{ id: 'x570', state: 'online' }, { id: 'bad', state: 'offline', future: 'not allowed' }] },
    { instances: [{ id: 'x570', state: 'online' }] },
  ]
  await page.route('https://hub.test/private', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml }))
  await page.route(statusUrl, async route => {
    requestCount += 1
    activeRequests += 1
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
    try {
      const payload = await responses.shift()
      const resolved = await payload
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(resolved) })
    } finally {
      activeRequests -= 1
    }
  })
  const waitForIdle = () => page.waitForFunction(() => !document.getElementById('refresh').disabled, undefined, { timeout: 3_000 })
  const refresh = async () => {
    await waitForIdle()
    await page.getByRole('button', { name: 'Refresh' }).click()
  }

  await page.goto('https://hub.test/private')
  await page.getByText('Loading instances', { exact: true }).waitFor()
  resolveFirst({ instances: [{ id: '<img src=x onerror=alert(1)>', state: '<script>alert(1)</script>' }] })
  await page.locator('.instance-id').waitFor()
  await waitForIdle()
  await page.screenshot({ path: join(screenshots, 'dark-mobile-success.png'), animations: 'disabled' })
  const contrast = await page.locator('.state').evaluate(element => {
    const parse = value => value.match(/\d+/g).map(Number).slice(0, 3).map(channel => channel / 255)
    const luminance = rgb => rgb.map(channel => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((total, channel, index) => total + channel * [.2126, .7152, .0722][index], 0)
    const foreground = luminance(parse(getComputedStyle(element).color))
    const background = luminance(parse(getComputedStyle(element.closest('.instances')).backgroundColor))
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
  })
  if (contrast < 4.5) throw new Error(`Dark state contrast is ${contrast}, below 4.5:1.`)
  const mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (mobile.width !== 360 || mobile.scrollWidth !== 360) throw new Error(`Mobile console overflow: ${JSON.stringify(mobile)}`)
  if (await page.locator('#instances img, #instances script').count() !== 0) throw new Error('Instance data created an HTML node instead of text.')
  if (await page.locator('.instance-id').textContent() !== '<img src=x onerror=alert(1)>') throw new Error('Unsafe id was not rendered as text.')

  await refresh()
  await page.getByText('No instances are registered.', { exact: true }).waitFor()
  await waitForIdle()
  await refresh()
  await page.getByText('Unable to refresh instance status. Try again.', { exact: true }).waitFor()
  await waitForIdle()

  await refresh()
  await page.getByText('x570', { exact: true }).waitFor()
  if (requestCount !== 4 || maxActiveRequests !== 1) throw new Error(`Unexpected refresh concurrency: count=${requestCount} max=${maxActiveRequests}`)
  process.stdout.write(`Hub admin browser test passed screenshots=${screenshots}\n`)
  await context.close()
} finally {
  await browser.close()
  await rm(screenshots, { recursive: true, force: true })
}
