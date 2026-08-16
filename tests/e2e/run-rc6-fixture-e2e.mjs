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
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) !== '') {
  throw new Error('rc.6 E2E requires a clean fixed subject.')
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
  await verifySidebar(origin)

  await stop(server)
  server = undefined
  runDsh(['plugin', '--profile', 'web', 'remove', '@dsh-plugins/dsh-remote'], temp, env)
  installed = false
  process.stdout.write(`rc.6 E2E passed commit=${commit} package_sha256=${archiveSha} origin=${origin}\n`)
} finally {
  if (server !== undefined) await stop(server)
  if (installed) runDsh(['plugin', '--profile', 'web', 'remove', '@dsh-plugins/dsh-remote'], temp, env)
  await rm(temp, { recursive: true, force: true })
}

function runDsh(args, cwd, processEnv) {
  execFileSync(process.execPath, [dshBin, ...args], { cwd, env: processEnv, stdio: 'inherit' })
}

async function verifySidebar(origin) {
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const page = await browser.newPage()
    await page.goto(origin)
    const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
    if (await notice.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      await notice.getByRole('button', { name: 'Continue' }).click()
    }
    const configureLater = page.getByRole('button', { name: /configure later/i })
    if (await configureLater.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      await configureLater.click()
    }
    await page.getByLabel('Remote access').first().click()
    await page.getByLabel('Remote access').last().waitFor({ state: 'visible' })
  } finally {
    await browser.close()
  }
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
