#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const execute = promisify(execFile)
const origin = process.env.DSH_REMOTE_CANARY_ORIGIN ?? 'https://remote-node-e2e.dsh.onlyservice.io'
const compatibilityOrigin = process.env.DSH_REMOTE_COMPATIBILITY_ORIGIN ?? 'https://x570.dsh.onlyservice.io'
const host = process.env.DSH_REMOTE_CANARY_HOST ?? 'x570'
const vps = process.env.DSH_REMOTE_CANARY_VPS ?? 'vps-tencent-tokyo'
const state = process.env.DSH_REMOTE_CANARY_STATE ?? '$HOME/.config/dsh-remote/instances/x570.json'
const agentUnit = 'dsh-remote-agent.service'
const results = {}

let cookie = await exchange(await remoteToken())
let socket = await openSocket(cookie)

try {
  results.initialHttp = await expectStatus(`${origin}/`, 200, cookie)
  results.initialWebSocket = await pingRoundTrip(socket)
  results.largeBody = await largeBodyProbe(cookie)
  results.compatibilityBefore = await expectStatus(`${compatibilityOrigin}/`, 200)

  await ssh(['systemctl', '--user', 'stop', agentUnit])
  results.agentOffline = await waitStatus(`${origin}/`, 503)
  results.compatibilityDuringAgentOutage = await expectStatus(`${compatibilityOrigin}/`, 200)

  await ssh(['systemctl', '--user', 'start', agentUnit])
  results.agentRecovered = await waitStatus(`${origin}/`, 200, cookie)
  results.compatibilityAfterRecovery = await expectStatus(`${compatibilityOrigin}/`, 200)

  await vpsSsh(['docker', 'stop', 'dsh-remote-host-e2e-host-1'])
  results.compatibilityDuringHostRestart = await expectStatus(`${compatibilityOrigin}/`, 200)
  await vpsSsh(['docker', 'start', 'dsh-remote-host-e2e-host-1'])
  results.hostRecovered = await waitStatus(`${origin}/`, 200, cookie)

  await vpsSsh(['docker', 'stop', 'dsh-remote-host-e2e-frps-1'])
  results.frpsOffline = await waitStatus(`${origin}/`, 503)
  results.compatibilityDuringFrpsOutage = await expectStatus(`${compatibilityOrigin}/`, 200)
  await vpsSsh(['docker', 'start', 'dsh-remote-host-e2e-frps-1'])
  results.frpsRecovered = await waitStatus(`${origin}/`, 200, cookie)

  socket = await openSocket(cookie)
  results.recoveredWebSocket = await pingRoundTrip(socket)

  const closed = waitClosed(socket)
  const rotate = await fetch(`${origin}/dsh-remote/api/rotate`, {
    method: 'POST',
    headers: { cookie, origin },
  })
  if (rotate.status !== 200) throw new Error(`private-link rotation returned ${rotate.status}`)
  await rotate.arrayBuffer()
  results.rotatedWebSocket = await closed
  results.oldCookie = await expectStatus(`${origin}/after-rotation`, 401, cookie)

  cookie = await exchange(await remoteToken())
  const replacement = await openSocket(cookie)
  try {
    results.replacementHttp = await expectStatus(`${origin}/`, 200, cookie)
    results.replacementWebSocket = await pingRoundTrip(replacement)
  } finally {
    replacement.close()
  }
  results.compatibilityFinal = await expectStatus(`${compatibilityOrigin}/`, 200)
  console.log(JSON.stringify(results, null, 2))
} finally {
  if (socket.readyState === WebSocket.OPEN) socket.close()
  await ssh(['systemctl', '--user', 'start', agentUnit]).catch(() => undefined)
  await vpsSsh(['docker', 'start', 'dsh-remote-host-e2e-host-1']).catch(() => undefined)
  await vpsSsh(['docker', 'start', 'dsh-remote-host-e2e-frps-1']).catch(() => undefined)
}

async function remoteToken() {
  const command = `set -eu; jq -r .token ${state}`
  const { stdout } = await execute('ssh', ['-o', 'BatchMode=yes', host, command], { encoding: 'utf8' })
  const token = stdout.trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('canary state returned an invalid token')
  return token
}

async function ssh(command) {
  await execute('ssh', ['-o', 'BatchMode=yes', host, command.map(shellWord).join(' ')], { encoding: 'utf8' })
}

async function vpsSsh(command) {
  await execute('ssh', ['-o', 'BatchMode=yes', vps, command.map(shellWord).join(' ')], { encoding: 'utf8' })
}

function shellWord(value) {
  if (!/^[A-Za-z0-9._@/-]+$/.test(value)) throw new Error('unsafe SSH argument')
  return value
}

async function exchange(token) {
  const response = await fetch(`${origin}/__dsh_remote/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token }),
  })
  if (response.status !== 204) throw new Error(`session exchange returned ${response.status}`)
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) throw new Error('session exchange omitted its cookie')
  return setCookie.split(';', 1)[0]
}

async function largeBodyProbe(cookieValue) {
  const response = await fetch(`${origin}/__dsh_canary_large_body_probe`, {
    method: 'POST',
    headers: { cookie: cookieValue, origin, 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(2 * 1024 * 1024, 0x61),
  })
  await response.arrayBuffer()
  if ([413, 502, 503].includes(response.status)) throw new Error(`large body probe returned ${response.status}`)
  return response.status
}

async function expectStatus(url, expected, cookieValue) {
  const observed = await status(url, cookieValue)
  if (observed !== expected) throw new Error(`${url} expected ${expected}, observed ${observed}`)
  return observed
}

async function status(url, cookieValue) {
  const response = await fetch(url, {
    headers: cookieValue === undefined ? {} : { cookie: cookieValue },
    redirect: 'manual',
  })
  await response.arrayBuffer()
  return response.status
}

async function waitStatus(url, expected, cookieValue) {
  let observed = 0
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { observed = await status(url, cookieValue) } catch { observed = 0 }
    if (observed === expected) return observed
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`${url} expected ${expected}, observed ${observed}`)
}

async function openSocket(cookieValue) {
  const url = new URL('/api/events.mux', origin)
  url.protocol = 'wss:'
  const socket = new WebSocket(url, { headers: { cookie: cookieValue, origin } })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 10_000)
    socket.once('open', () => { clearTimeout(timer); resolve() })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
  return socket
}

async function pingRoundTrip(socket) {
  const payload = Buffer.from(`dsh-host-canary-${Date.now()}`)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket pong timed out')), 5_000)
    const pong = data => {
      if (!Buffer.from(data).equals(payload)) return
      clearTimeout(timer)
      socket.off('pong', pong)
      resolve()
    }
    socket.on('pong', pong)
    socket.once('error', reject)
    socket.ping(payload)
  })
  return 'pong'
}

async function waitClosed(socket) {
  if (socket.readyState === WebSocket.CLOSED) return 'closed'
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('old WebSocket did not close')), 10_000)
    socket.once('close', () => { clearTimeout(timer); resolve('closed') })
  })
}
