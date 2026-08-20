import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import httpProxy from 'http-proxy'
import { chromium, request as playwrightRequest } from '@playwright/test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('rc.8 E2E requires an immutable Git commit.')
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }) !== '') {
  throw new Error('rc.8 E2E requires a fixed tracked subject; unrelated untracked files are ignored.')
}

const temp = await mkdtemp(join(tmpdir(), 'dsh-remote-rc8-'))
const dshHome = join(temp, 'dsh-home')
const agentSocket = join(temp, 'agent.sock')
const [webPort, gatewayPort, remotePort] = await Promise.all([availablePort(), availablePort(), availablePort()])
const remoteOrigin = `https://127.0.0.1:${remotePort}`
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_REMOTE_MODE: 'host',
  DSH_REMOTE_ORIGIN: remoteOrigin,
  DSH_REMOTE_GATEWAY_PORT: String(gatewayPort),
  DSH_REMOTE_AGENT_SOCKET_PATH: agentSocket,
  DSH_REMOTE_STATE_FILE: join(temp, 'remote-state.json'),
}
const output = []
let dsh
let browser
let facade
let agent

try {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  execFileSync('pnpm', ['pack', '--pack-destination', temp], { cwd: root, stdio: 'inherit' })
  const archiveName = (await readdir(temp)).find(name => name.endsWith('.tgz'))
  if (archiveName === undefined) throw new Error('pnpm pack did not create an archive.')
  const archive = join(temp, archiveName)
  const archiveSha = createHash('sha256').update(await readFile(archive)).digest('hex')

  agent = await startAgent(agentSocket)
  const tls = await createCertificate(temp)
  facade = await startFacade(remotePort, gatewayPort, tls)
  runDsh(['plugin', '--profile', 'web', 'add', archive], temp, env)
  dsh = spawn('pnpm', ['--package=@deepseek-ai/dsh@0.1.0-rc.8', 'dlx', 'dsh', 'web', '--host', '127.0.0.1', '--port', String(webPort)], {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  collectOutput(dsh, output)
  await waitForReady(remoteOrigin, dsh, output)

  browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await page.goto(`${remoteOrigin}/#dsh-host-launch=${'t'.repeat(43)}`)
  await page.waitForURL(`${remoteOrigin}/`, { timeout: 30_000 })
  await settleFirstRun(page)

  const settingsButton = page.getByRole('button').filter({ hasText: /Settings|设置/u }).first()
  await settingsButton.waitFor({ state: 'visible', timeout: 20_000 })
  await settingsButton.click()
  const settingsDialog = page.getByRole('dialog', { name: /Settings|设置/u })
  await settingsDialog.waitFor({ state: 'visible' })
  await settingsDialog.getByRole('button', { name: /Models|模型目录/u }).click()
  await settingsDialog.getByLabel(/Models|模型目录/u).waitFor({ state: 'visible' })
  const unavailable = settingsDialog.getByText(/settings are unavailable|设置不可用/iu)
  if (await unavailable.count() !== 0) throw new Error('rc.8 Models screen reported unavailable settings.')

  const described = await rpc(page, 'settings.describe', {})
  const namespaces = described.result?.value?.namespaces
  if (!described.result?.ok || !Array.isArray(namespaces) || namespaces.length === 0) {
    throw new Error(`owner settings.describe failed: ${JSON.stringify(described)}`)
  }
  const namespace = namespaces[0]
  const updated = await rpc(page, 'settings.update', { ns: namespace.ns, patch: {}, expectedRevision: namespace.revision })
  if (!updated.result?.ok) throw new Error(`owner settings.update failed: ${JSON.stringify(updated)}`)
  const credentials = await rpc(page, 'credentials.describe', { refs: ['DSH_REMOTE_RC8_E2E_UNUSED'] })
  if (!credentials.result?.ok) throw new Error(`owner credentials.describe failed: ${JSON.stringify(credentials)}`)
  const providers = await rpc(page, 'llm.providers', {})
  const provider = providers.result?.value?.providers?.find(entry => typeof entry.settingsNs === 'string' && entry.settingsNs !== '')
  if (provider === undefined) throw new Error(`rc.8 provider directory was empty: ${JSON.stringify(providers)}`)
  const discovery = await rpc(page, 'llm.discoverModels', { settingsNs: provider.settingsNs, provider: provider.provider })
  if (discovery.result === undefined) throw new Error(`owner llm.discoverModels returned no RPC result: ${JSON.stringify(discovery)}`)

  await openAndCloseSocket(page, '/api/events.host')
  await page.reload()
  await settleFirstRun(page)
  const afterReload = await rpc(page, 'settings.describe', {})
  if (!afterReload.result?.ok) throw new Error(`owner settings.describe failed after reload: ${JSON.stringify(afterReload)}`)
  await openAndCloseSocket(page, '/api/events.host')

  const state = JSON.parse(await readFile(env.DSH_REMOTE_STATE_FILE, 'utf8'))
  const privateApi = await playwrightRequest.newContext({ baseURL: remoteOrigin, ignoreHTTPSErrors: true })
  try {
    const exchange = await privateApi.post('/__dsh_remote/session', {
      headers: { origin: remoteOrigin, 'content-type': 'application/json' },
      data: { token: state.token },
    })
    if (exchange.status() !== 204) throw new Error(`private session exchange returned ${exchange.status()}`)
    for (const method of ['settings.describe', 'credentials.describe', 'llm.discoverModels']) {
      const denied = await privateApi.post(`/api/${method}`, {
        headers: { origin: remoteOrigin, 'content-type': 'application/json' },
        data: envelope(method, {}),
      })
      if (denied.status() !== 403) throw new Error(`private ${method} expected 403, observed ${denied.status()}`)
    }
  } finally {
    await privateApi.dispose()
  }

  process.stdout.write(`rc.8 owner E2E passed commit=${commit} package_sha256=${archiveSha} owner_models=true settings_write=true credentials_metadata=true model_discovery=true reload=true reconnect=true private_denial=true origin=${remoteOrigin}\n`)
} finally {
  if (browser !== undefined) await browser.close()
  if (dsh !== undefined) await stop(dsh)
  if (facade !== undefined) await closeServer(facade)
  if (agent !== undefined) await closeServer(agent)
  await rm(temp, { recursive: true, force: true })
}

function runDsh(args, cwd, processEnv) {
  execFileSync('pnpm', ['--package=@deepseek-ai/dsh@0.1.0-rc.8', 'dlx', 'dsh', ...args], {
    cwd,
    env: processEnv,
    stdio: 'inherit',
  })
}

async function startAgent(socketPath) {
  const server = createNetServer(socket => {
    socket.setEncoding('utf8')
    socket.once('data', source => {
      try {
        const message = JSON.parse(source.toString())
        if (message.version !== '1.0' || message.operation !== 'launch.redeem' || message.payload?.ticket !== 't'.repeat(43)) {
          socket.end(`${JSON.stringify({ version: '1.0', ok: false, error: 'unauthorized' })}\n`)
          return
        }
        socket.end(`${JSON.stringify({ version: '1.0', ok: true, payload: { session_grant: 'g'.repeat(43), roles: ['owner'] } })}\n`)
      } catch {
        socket.end(`${JSON.stringify({ version: '1.0', ok: false, error: 'invalid' })}\n`)
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  return server
}

async function createCertificate(directory) {
  const key = join(directory, 'tls.key')
  const cert = join(directory, 'tls.crt')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' })
  return { key: await readFile(key), cert: await readFile(cert) }
}

async function startFacade(port, gatewayPortValue, tls) {
  const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${gatewayPortValue}`, ws: true })
  const server = createHttpsServer(tls, (incoming, response) => { proxy.web(incoming, response) })
  server.on('upgrade', (incoming, socket, head) => { proxy.ws(incoming, socket, head) })
  proxy.on('error', (_error, _request, response) => {
    if (typeof response.writeHead === 'function') {
      response.writeHead(502)
      response.end()
    } else {
      response.destroy()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  server.once('close', () => { proxy.close() })
  return server
}

async function waitForReady(origin, child, lines) {
  const api = await playwrightRequest.newContext({ ignoreHTTPSErrors: true })
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`rc.8 DSH exited early (${child.exitCode}):\n${lines.join('')}`)
      try {
        const response = await api.get(`${origin}/__dsh_remote/launch`)
        if (response.status() === 200) return
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally {
    await api.dispose()
  }
  throw new Error(`rc.8 gateway did not become ready:\n${lines.join('')}`)
}

async function settleFirstRun(page) {
  const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  if (await notice.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)) {
    await notice.getByRole('button', { name: 'Continue' }).click()
  }
  const configureLater = page.getByRole('button', { name: /configure later/i })
  if (await configureLater.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)) {
    await configureLater.click()
  }
}

async function rpc(page, method, payload) {
  return await page.evaluate(async ({ method: rpcMethod, payload: rpcPayload }) => {
    const response = await fetch(`/api/${rpcMethod}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: rpcMethod, payload: rpcPayload }),
    })
    if (response.status !== 200) throw new Error(`${rpcMethod} returned HTTP ${response.status}`)
    return await response.json()
  }, { method, payload })
}

function envelope(method, payload) {
  return { type: 'client-request', rpcId: crypto.randomUUID(), method, payload }
}

async function openAndCloseSocket(page, path) {
  await page.evaluate(async socketPath => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}${socketPath}`)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owner WebSocket open timed out')), 10_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('owner WebSocket failed')) }, { once: true })
    })
    socket.close()
    await new Promise(resolve => socket.addEventListener('close', resolve, { once: true }))
  }, path)
}

function collectOutput(child, lines) {
  child.stdout?.on('data', chunk => { lines.push(chunk.toString()) })
  child.stderr?.on('data', chunk => { lines.push(chunk.toString()) })
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function closeServer(server) {
  await new Promise(resolve => { server.close(() => resolve()) })
}

async function availablePort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an ephemeral TCP port.')
  const port = address.port
  await closeServer(server)
  return port
}
