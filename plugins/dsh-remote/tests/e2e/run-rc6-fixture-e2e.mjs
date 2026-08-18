import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const dshBin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('rc.6 E2E requires an immutable Git commit.')
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }) !== '') {
  throw new Error('rc.6 E2E requires a fixed tracked subject; unrelated untracked files are ignored.')
}

const temp = await mkdtemp(join(tmpdir(), 'dsh-remote-rc6-'))
const dshHome = join(temp, 'dsh-home')
const port = await availablePort()
const origin = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_REMOTE_ORIGIN: 'https://fixture.invalid',
  DSH_REMOTE_SSH_TARGET: 'invalid-rc6-fixture.invalid',
  DSH_REMOTE_STATE_FILE: join(temp, 'remote-state.json'),
}
let server
let installed = false

try {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  execFileSync('pnpm', ['pack', '--pack-destination', temp], { cwd: root, stdio: 'inherit' })
  const archiveName = (await readdir(temp)).find(name => name.endsWith('.tgz'))
  if (archiveName === undefined) throw new Error('pnpm pack did not create an archive.')
  const archive = join(temp, archiveName)
  const archiveSha = createHash('sha256').update(await readFile(archive)).digest('hex')

  runDsh(['plugin', '--profile', 'web', 'add', archive], temp, env)
  installed = true
  assertDirectoryPickerComposition(dumpDshConfig(temp, env))
  server = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = collectOutput(server)
  await waitForReady(origin, server, output)
  const status = await waitForRemoteStatus(origin, server, output)
  if (typeof status?.sessionVersion !== 'number' || typeof status?.tunnel?.phase !== 'string') {
    throw new Error('dsh-remote lifecycle did not return a valid status snapshot.')
  }
  const screenshots = await verifyRemotePanel(origin, status.sessionVersion, temp)

  await stop(server)
  server = undefined
  runDsh(['plugin', '--profile', 'web', 'remove', '@dsh-plugins/dsh-remote'], temp, env)
  installed = false
  process.stdout.write(`rc.6 E2E passed commit=${commit} package_sha256=${archiveSha} screenshots=${JSON.stringify(screenshots)} origin=${origin}\n`)
} finally {
  if (server !== undefined) await stop(server)
  if (installed) runDsh(['plugin', '--profile', 'web', 'remove', '@dsh-plugins/dsh-remote'], temp, env)
  await rm(temp, { recursive: true, force: true })
}

function runDsh(args, cwd, processEnv) {
  execFileSync(process.execPath, [dshBin, ...args], { cwd, env: processEnv, stdio: 'inherit' })
}

function dumpDshConfig(cwd, processEnv) {
  return execFileSync(process.execPath, [dshBin, '--profile', 'web', '--dump-config'], {
    cwd,
    env: processEnv,
    encoding: 'utf8',
  })
}

function assertDirectoryPickerComposition(config) {
  const lines = config.split('\n')
  const entry = id => {
    const matches = lines.flatMap((line, index) => line === `- id: ${id}` ? [index] : [])
    if (matches.length !== 1) throw new Error(`Cordis composition expected one ${id} entry, found ${matches.length}: ${config}`)
    const start = matches[0]
    const next = lines.findIndex((line, index) => index > start && line.startsWith('- id: '))
    return lines.slice(start, next === -1 ? undefined : next).join('\n')
  }
  const native = entry('directory-picker')
  if (!native.includes("name: '@deepseek-ai/dsh-host-directory-picker-auto'") || !native.includes('disabled: true')) {
    throw new Error(`Cordis composition did not disable the native directory picker: ${native}`)
  }
  const browse = entry('directory-picker-browse')
  const surface = entry('directory-picker-surface')
  if (!browse.includes("name: '@deepseek-ai/dsh-host-directory-picker-browse'") || browse.includes('disabled: true')) {
    throw new Error(`Cordis composition did not enable exactly one browse host picker: ${browse}`)
  }
  if (!surface.includes("name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'") || surface.includes('disabled: true')) {
    throw new Error(`Cordis composition did not enable exactly one browser browse surface: ${surface}`)
  }
}

async function verifyRemotePanel(origin, initialSessionVersion, evidenceDir) {
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    await page.goto(origin)
    const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
    if (await notice.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      await notice.getByRole('button', { name: 'Continue' }).click()
    }
    const configureLater = page.getByRole('button', { name: /configure later/i })
    if (await configureLater.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      await configureLater.click()
    }
    const screenshots = await verifyResponsiveShell(page, evidenceDir)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Remote access', exact: true }).click()
    const panel = page.locator('section[aria-label="Remote access"]')
    await panel.waitFor({ state: 'visible' }).catch(async error => {
      const labels = await page.locator('[aria-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
      const buttons = await page.getByRole('button').allTextContents()
      throw new Error(`Remote panel did not open; labels=${JSON.stringify(labels)} buttons=${JSON.stringify(buttons)}`, { cause: error })
    })
    await panel.getByText(/starting|online|reconnecting|failed|stopped/iu).waitFor({ state: 'visible' })
    await assertInsideViewport(page, panel, 'Remote access panel')
    screenshots.push(await captureScreenshot(page, join(evidenceDir, 'mobile-390-remote-panel.png')))

    const copy = panel.getByRole('button', { name: 'Copy private link' })
    await copy.click()
    const firstUrl = await page.evaluate(() => navigator.clipboard.readText())
    assertPrivateUrl(firstUrl)

    await panel.getByRole('button', { name: 'Rotate', exact: true }).click()
    const confirmation = panel.getByRole('alertdialog', { name: 'Rotate remote link confirmation' })
    await confirmation.waitFor({ state: 'visible' })
    await confirmation.getByRole('button', { name: 'Rotate', exact: true }).click()
    await confirmation.waitFor({ state: 'hidden' })
    await waitForSessionVersion(origin, initialSessionVersion + 1)

    await copy.click()
    const replacementUrl = await page.evaluate(() => navigator.clipboard.readText())
    assertPrivateUrl(replacementUrl)
    if (replacementUrl === firstUrl) throw new Error('Visible rotation did not replace the copied private URL.')
    return screenshots
  } finally {
    await browser.close()
  }
}

async function verifyResponsiveShell(page, evidenceDir) {
  const screenshots = []
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport)
    const card = page.locator('[data-dsh-remote-mobile-composer-card]')
    const row = page.locator('[data-dsh-remote-mobile-composer-row]')
    await card.waitFor({ state: 'visible' })
    const geometry = await page.evaluate(() => {
      const frame = document.querySelector('[data-dsh-remote-mobile-frame]')
      const center = document.querySelector('[data-dsh-remote-mobile-center]')
      const card = document.querySelector('[data-dsh-remote-mobile-composer-card]')
      const row = document.querySelector('[data-dsh-remote-mobile-composer-row]')
      if (frame === null || center === null || card === null || row === null) return null
      const rect = element => {
        const value = element.getBoundingClientRect()
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width }
      }
      return {
        innerWidth,
        innerHeight,
        htmlScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        frame: rect(frame),
        center: rect(center),
        card: rect(card),
        rowDisplay: getComputedStyle(row).display,
        buttons: [...card.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0).map(rect),
      }
    })
    if (geometry === null) throw new Error(`Mobile compatibility markers were incomplete at ${viewport.width}x${viewport.height}.`)
    if (geometry.htmlScrollWidth !== viewport.width || geometry.bodyScrollWidth !== viewport.width) {
      throw new Error(`Unexpected page overflow at ${viewport.width}x${viewport.height}: html=${geometry.htmlScrollWidth} body=${geometry.bodyScrollWidth}.`)
    }
    if (geometry.rowDisplay !== 'grid') throw new Error(`Composer did not reflow at ${viewport.width}px.`)
    assertRectInside(geometry.frame, viewport, 'shell frame')
    assertRectInside(geometry.center, viewport, 'conversation column')
    assertRectInside(geometry.card, viewport, 'composer card')
    for (const [index, button] of geometry.buttons.entries()) assertRectInside(button, viewport, `composer button ${index + 1}`)

    const openSidebar = page.getByRole('button', { name: /open sidebar|打开侧边栏/iu })
    if (await openSidebar.count() === 1) {
      await openSidebar.click()
      const expanded = await page.locator('[data-dsh-remote-mobile-frame]:not([data-sidebar-collapsed])').evaluate(frame => {
        const sidebar = frame.querySelector('[data-dsh-remote-mobile-sidebar]')
        const center = frame.querySelector('[data-dsh-remote-mobile-center]')
        if (sidebar === null || center === null) return null
        return {
          frameWidth: frame.getBoundingClientRect().width,
          sessionActive: frame.hasAttribute('data-dsh-remote-mobile-session-active'),
          sidebarPosition: getComputedStyle(sidebar).position,
          sidebarWidth: sidebar.getBoundingClientRect().width,
          centerWidth: center.getBoundingClientRect().width,
        }
      })
      if (expanded === null || expanded.sidebarPosition !== 'absolute') throw new Error('Expanded mobile sidebar is not an overlay.')
      const expectedCenterWidth = expanded.frameWidth - (expanded.sessionActive ? 0 : 56)
      if (Math.abs(expanded.centerWidth - expectedCenterWidth) > 1) throw new Error('Expanded mobile sidebar squeezed the conversation column.')
      if (expanded.sidebarWidth > Math.min(320, viewport.width - 24) + 1) throw new Error('Expanded mobile sidebar exceeds its viewport allowance.')
      await page.getByRole('button', { name: /collapse sidebar|收起侧边栏/iu }).click()
    }

    screenshots.push(await captureScreenshot(page, join(evidenceDir, `mobile-${viewport.width}x${viewport.height}.png`)))
  }

  await page.setViewportSize({ width: 390, height: 520 })
  await assertInsideViewport(page, page.locator('[data-dsh-remote-mobile-composer-card]'), 'Composer after visual viewport height change')
  screenshots.push(await captureScreenshot(page, join(evidenceDir, 'mobile-390x520-keyboard-simulation.png')))

  await page.setViewportSize({ width: 1280, height: 900 })
  const desktopDisplay = await page.locator('[data-dsh-remote-mobile-composer-row]').evaluate(row => getComputedStyle(row).display)
  if (desktopDisplay !== 'flex') throw new Error(`Desktop composer changed from flex to ${desktopDisplay}.`)
  screenshots.push(await captureScreenshot(page, join(evidenceDir, 'desktop-1280x900.png')))
  return screenshots
}

async function assertInsideViewport(page, locator, label) {
  const rect = await locator.boundingBox()
  const viewport = page.viewportSize()
  if (rect === null || viewport === null) throw new Error(`${label} has no measurable viewport rectangle.`)
  assertRectInside({ left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height }, viewport, label)
}

function assertRectInside(rect, viewport, label) {
  const epsilon = 1
  if (rect.left < -epsilon || rect.top < -epsilon || rect.right > viewport.width + epsilon || rect.bottom > viewport.height + epsilon) {
    throw new Error(`${label} is outside ${viewport.width}x${viewport.height}: ${JSON.stringify(rect)}.`)
  }
}

async function captureScreenshot(page, path) {
  const bytes = await page.screenshot({ path, animations: 'disabled' })
  if (bytes.length < 5_000) throw new Error(`Screenshot is unexpectedly blank: ${path}`)
  return { name: path.split('/').at(-1), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

function assertPrivateUrl(value) {
  const url = new URL(value)
  if (url.origin !== 'https://fixture.invalid' || !/^#\/access\/[A-Za-z0-9_-]{43}$/u.test(url.hash)) {
    throw new Error('Copied private URL does not match the configured origin and fragment shape.')
  }
}

async function waitForSessionVersion(origin, expected) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/dsh-remote/api/status`)
    if (response.ok && (await response.json()).sessionVersion === expected) return
    await delay(100)
  }
  throw new Error(`Remote session version did not reach ${expected}.`)
}

async function waitForRemoteStatus(origin, child, output) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH exited before remote status (${child.exitCode})\n${output()}`)
    try {
      const response = await fetch(`${origin}/dsh-remote/api/status`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return await response.json()
    } catch {
      // Plugin routes become available after the Web profile is ready.
    }
    await delay(250)
  }
  throw new Error(`dsh-remote status route did not become ready\n${output()}`)
}

async function waitForReady(origin, child, output) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH exited before readiness (${child.exitCode})\n${output()}`)
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(1_000) })).ok) return
    } catch {
      // The profile is still booting.
    }
    await delay(250)
  }
  throw new Error(`DSH did not become ready at ${origin}\n${output()}`)
}

function collectOutput(child) {
  let text = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', chunk => { text = `${text}${chunk.toString()}`.slice(-16_384) })
  }
  return () => text
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      if (address === null || typeof address === 'string') return reject(new Error('Could not allocate an E2E port.'))
      socket.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  await Promise.race([exited, delay(5_000)])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
