#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const command = process.argv[2]
const args = process.argv.slice(3)

if (command !== undefined) {
  if (command === 'summary') await writeSummary(args[0])
  else if (command === 'assert-isolated') assertIsolated(...args.map(Number))
  else if (command === 'port-free') await assertPortFree(Number(args[0]))
  else if (command === 'snapshot') await snapshot(Number(args[0]), Number(args[1]), args[2])
  else if (command === 'compare-snapshots') await compareSnapshots(args[0], args[1])
  else if (command === 'validate-version') validateVersion(args[0])
  else if (command === 'validate-commit') validateCommit(args[0])
  else if (command === 'init-runtime') await initRuntime(args[0], args[1], args[2])
  else if (command === 'peers') await checkPeers(args[0], args[1], args[2])
  else if (command === 'wait-ready') await waitReady(Number(args[0]), Number(args[1]), Number(args[2]))
  else if (command === 'runtime') await runtimeProbe(args[0], Number(args[1]), Number(args[2]), Number(args[3]), args[4], args[5])
  else throw new Error(`unknown command: ${command}`)
}

async function writeSummary(path) {
  const value = {
    schema: 'dsh-compat-summary-v1',
    runId: process.env.DSH_COMPAT_RUN_ID,
    result: process.env.DSH_COMPAT_RESULT,
    stage: process.env.DSH_COMPAT_STAGE,
    dshVersion: process.env.DSH_COMPAT_DSH_VERSION || null,
    dshRemoteVersion: process.env.DSH_COMPAT_REMOTE_VERSION || null,
    dshRemoteCommit: process.env.DSH_COMPAT_REMOTE_COMMIT || null,
    webPort: Number(process.env.DSH_COMPAT_WEB_PORT),
    gatewayPort: Number(process.env.DSH_COMPAT_GATEWAY_PORT),
    log: process.env.DSH_COMPAT_LOG,
    updatedAt: new Date().toISOString(),
  }
  await writeJson(path, value)
}

function assertIsolated(webPort, gatewayPort) {
  for (const [name, value] of [['web', webPort], ['gateway', gatewayPort]]) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} port is invalid`)
  }
  if (webPort === gatewayPort || [3280, 29321].includes(webPort) || [3280, 29321].includes(gatewayPort)) {
    throw new Error('compatibility ports overlap the production x570 instance')
  }
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`127.0.0.1:${port} is already in use`)) })
    socket.once('error', error => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolve()
      else reject(error)
    })
  })
}

async function snapshot(webPort, gatewayPort, output) {
  const value = {
    collectedAt: new Date().toISOString(),
    web: await httpStatus(`http://127.0.0.1:${webPort}/`),
    gateway: await httpStatus(`http://127.0.0.1:${gatewayPort}/`),
  }
  await writeJson(output, value)
}

async function compareSnapshots(beforePath, afterPath) {
  const before = JSON.parse(await readFile(beforePath, 'utf8'))
  const after = JSON.parse(await readFile(afterPath, 'utf8'))
  for (const key of ['web', 'gateway']) {
    if (before[key] !== after[key]) throw new Error(`production ${key} status changed from ${before[key]} to ${after[key]}`)
  }
}

function validateVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value ?? '')) throw new Error(`invalid DSH version: ${value ?? ''}`)
}

function validateCommit(value) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? '')) throw new Error(`invalid dsh-remote commit: ${value ?? ''}`)
}

async function initRuntime(runtime, dshVersion, pnpmVersion) {
  validateVersion(dshVersion)
  validateVersion(pnpmVersion)
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  await writeJson(join(runtime, 'package.json'), {
    name: 'dsh-compat-runtime',
    private: true,
    packageManager: `pnpm@${pnpmVersion}`,
    dependencies: {
      '@deepseek-ai/dsh': dshVersion,
      semver: '^7.7.2',
      ws: '^8.18.3',
    },
  })
  await writeFile(join(runtime, 'pnpm-workspace.yaml'), `packages: []

# Mirrors the reviewed lifecycle-script policy in deepseek-harness.
allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': false
  protobufjs: false
  node-addon-require-builtin: false
  koffi: true
  node-pty: true
`, { mode: 0o600 })
}

async function checkPeers(runtime, manifestPath, output) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const requireFromRuntime = createRequire(join(runtime, 'package.json'))
  const semver = requireFromRuntime('semver')
  const checks = []
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const versions = await installedVersions(runtime, name)
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true
    checks.push({
      name,
      range,
      versions,
      optional,
      compatible: versions.length === 0
        ? optional
        : versions.length === 1 && semver.satisfies(versions[0], range, { includePrerelease: true }),
    })
  }
  const value = { compatible: checks.every(item => item.compatible), checks }
  await writeJson(output, value)
  if (!value.compatible) {
    const failed = checks.filter(item => !item.compatible).map(item => `${item.name}@${item.versions.join(',') || 'missing'} requires ${item.range}`)
    throw new Error(`dsh-remote peer contract rejected latest DSH: ${failed.join('; ')}`)
  }
}

async function installedVersions(runtime, name) {
  const versions = new Set()
  const candidates = [join(runtime, 'node_modules', ...name.split('/'), 'package.json')]
  const virtualStore = join(runtime, 'node_modules/.pnpm')
  try {
    for (const entry of await readdir(virtualStore, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(virtualStore, entry.name, 'node_modules', ...name.split('/'), 'package.json'))
    }
  } catch {}
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await readFile(candidate, 'utf8'))
      if (manifest.name === name && typeof manifest.version === 'string') versions.add(manifest.version)
    } catch {}
  }
  return [...versions].sort()
}

async function waitReady(webPort, gatewayPort, pid) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    assertAlive(pid)
    const [web, gateway] = await Promise.all([
      httpStatus(`http://127.0.0.1:${webPort}/`),
      httpStatus(`http://127.0.0.1:${gatewayPort}/`),
    ])
    if (web === 200 && gateway === 200) return
    await delay(500)
  }
  throw new Error('isolated DSH runtime did not become ready')
}

async function runtimeProbe(runtime, webPort, gatewayPort, pid, stateFile, output) {
  const requireFromRuntime = createRequire(join(runtime, 'package.json'))
  const WebSocket = requireFromRuntime('ws')
  const remoteOrigin = 'https://compat.invalid'
  const webOrigin = `http://127.0.0.1:${webPort}`
  assertAlive(pid)

  const root = await fetch(`${webOrigin}/`)
  const html = await root.text()
  if (root.status !== 200 || !html.toLowerCase().includes('<html')) throw new Error('DSH workspace shell did not load')

  const statusResponse = await fetch(`${webOrigin}/dsh-remote/api/status`)
  const remoteStatus = await statusResponse.json()
  if (statusResponse.status !== 200 || remoteStatus.gatewayPort !== gatewayPort || remoteStatus.sessionVersion !== 1) {
    throw new Error(`dsh-remote status is invalid: ${JSON.stringify(remoteStatus)}`)
  }

  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state.token ?? '')) throw new Error('dsh-remote state token is invalid')
  const session = await fetch(`http://127.0.0.1:${gatewayPort}/__dsh_remote/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: remoteOrigin },
    body: JSON.stringify({ token: state.token }),
  })
  if (session.status !== 204) throw new Error(`gateway session exchange returned ${session.status}`)
  const cookie = session.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('gateway session exchange omitted its cookie')

  const gatewayRoot = await fetch(`http://127.0.0.1:${gatewayPort}/`, { headers: { cookie, origin: remoteOrigin } })
  if (gatewayRoot.status !== 200) throw new Error(`authenticated gateway returned ${gatewayRoot.status}`)
  await gatewayRoot.arrayBuffer()

  await websocketPing(WebSocket, `ws://127.0.0.1:${webPort}/api/events.mux`, webOrigin)
  await websocketPing(WebSocket, `ws://127.0.0.1:${gatewayPort}/api/events.mux`, remoteOrigin, cookie)
  await resetUpgrade(webPort, webOrigin)
  await resetUpgrade(gatewayPort, remoteOrigin, cookie)
  await delay(750)
  assertAlive(pid)
  if (await httpStatus(`${webOrigin}/`) !== 200) throw new Error('DSH stopped serving after late reset probes')
  if (await httpStatus(`http://127.0.0.1:${gatewayPort}/`) !== 200) throw new Error('gateway stopped serving after late reset probes')

  await writeJson(output, {
    passed: true,
    workspaceShell: 200,
    pluginStatus: 200,
    gatewaySession: 204,
    gatewayHttp: 200,
    webSocket: 'pong',
    gatewayWebSocket: 'pong',
    webLateResetSurvived: true,
    gatewayLateResetSurvived: true,
  })
}

async function websocketPing(WebSocket, url, origin, cookie) {
  const headers = cookie === undefined ? { origin } : { origin, cookie }
  const socket = new WebSocket(url, { headers })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket open timed out: ${url}`)), 10_000)
    socket.once('open', () => { clearTimeout(timer); resolve() })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
  const payload = randomBytes(16)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket pong timed out: ${url}`)), 5_000)
    socket.once('pong', data => {
      clearTimeout(timer)
      if (!Buffer.from(data).equals(payload)) reject(new Error(`WebSocket pong mismatch: ${url}`))
      else resolve()
    })
    socket.ping(payload)
  })
  socket.close()
}

async function resetUpgrade(port, origin, cookie) {
  const key = randomBytes(16).toString('base64')
  const headers = [
    'GET /api/events.mux HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Origin: ${origin}`,
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
    '',
    '',
  ].join('\r\n')
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let response = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`reset upgrade timed out on ${port}`)) }, 10_000)
    socket.once('connect', () => socket.write(headers))
    socket.on('data', chunk => {
      response += chunk.toString('latin1')
      if (!response.includes('\r\n\r\n')) return
      clearTimeout(timer)
      if (!response.startsWith('HTTP/1.1 101')) {
        socket.destroy()
        reject(new Error(`reset upgrade on ${port} returned ${response.split('\r\n', 1)[0]}`))
        return
      }
      socket.resetAndDestroy()
      resolve()
    })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

async function httpStatus(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
    await response.arrayBuffer()
    return response.status
  } catch {
    return 0
  }
}

function assertAlive(pid) {
  try { process.kill(pid, 0) } catch { throw new Error(`isolated DSH process ${pid} exited`) }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { assertIsolated, validateCommit, validateVersion }
