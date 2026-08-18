#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const execute = promisify(execFile)
const zshOrigin = process.env.DSH_REMOTE_ZSH_ORIGIN ?? 'https://zsh.onlyservice.io'
const x570Origin = process.env.DSH_REMOTE_X570_ORIGIN ?? 'https://x570.dsh.onlyservice.io'
const x570Host = process.env.DSH_REMOTE_X570_HOST ?? 'x570'
const zshState = process.env.DSH_REMOTE_ZSH_STATE ?? `${process.env.HOME}/.config/dsh-remote/state.json`
const x570State = process.env.DSH_REMOTE_X570_STATE ?? '$HOME/.config/dsh-remote/instances/x570.json'
const unit = 'dsh-remote-x570.service'
const results = {}

const zshToken = JSON.parse(await readFile(zshState, 'utf8')).token
let x570Token = await remoteToken()
const zshCookie = await exchange(zshOrigin, zshToken)
let x570Cookie = await exchange(x570Origin, x570Token)
const zshSocket = await openSocket(zshOrigin, zshCookie)
const x570Socket = await openSocket(x570Origin, x570Cookie)

try {
  results.initial = await healthyPair(zshSocket, zshCookie, x570Cookie)

  await ssh(['systemctl', '--user', 'stop', unit])
  results.x570Offline = await waitStatus(`${x570Origin}/`, 503)
  results.zshDuringOffline = await checkZsh(zshSocket, zshCookie)

  await ssh(['systemctl', '--user', 'start', unit])
  results.x570Recovered = await waitStatus(`${x570Origin}/`, 200, x570Cookie)
  results.zshAfterRecovery = await checkZsh(zshSocket, zshCookie)

  const oldX570Closed = waitClosed(x570Socket)
  const rotate = await fetch(`${x570Origin}/dsh-remote/api/rotate`, {
    method: 'POST',
    headers: { cookie: x570Cookie, origin: x570Origin },
  })
  if (rotate.status !== 200) throw new Error(`x570 rotation returned ${rotate.status}`)
  await rotate.arrayBuffer()
  results.x570OldWebSocket = await oldX570Closed
  results.x570OldCookie = await status(`${x570Origin}/after-rotation`, x570Cookie)
  if (results.x570OldCookie !== 401) throw new Error(`old x570 cookie returned ${results.x570OldCookie}`)
  results.zshDuringRotation = await checkZsh(zshSocket, zshCookie)

  x570Token = await remoteToken()
  x570Cookie = await exchange(x570Origin, x570Token)
  const newX570Socket = await openSocket(x570Origin, x570Cookie)
  try {
    results.x570NewSession = await status(`${x570Origin}/`, x570Cookie)
    results.x570NewWebSocket = await pingRoundTrip(newX570Socket)
    results.zshAfterRotation = await checkZsh(zshSocket, zshCookie)
  } finally {
    newX570Socket.close()
  }

  console.log(JSON.stringify(results, null, 2))
} finally {
  zshSocket.close()
  if (x570Socket.readyState === WebSocket.OPEN) x570Socket.close()
  await ssh(['systemctl', '--user', 'start', unit]).catch(() => undefined)
}

async function remoteToken() {
  const command = `set -eu; umask 077; jq -r .token ${x570State}`
  const { stdout } = await execute('ssh', ['-o', 'BatchMode=yes', x570Host, command], { encoding: 'utf8' })
  const token = stdout.trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('x570 state returned an invalid token')
  return token
}

async function ssh(command) {
  await execute('ssh', ['-o', 'BatchMode=yes', x570Host, command.map(shellWord).join(' ')], { encoding: 'utf8' })
}

function shellWord(value) {
  if (!/^[A-Za-z0-9._@/-]+$/.test(value)) throw new Error('unsafe SSH argument')
  return value
}

async function exchange(origin, token) {
  const response = await fetch(`${origin}/__dsh_remote/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token }),
  })
  if (response.status !== 204) throw new Error(`${origin} session exchange returned ${response.status}`)
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) throw new Error(`${origin} session exchange omitted its cookie`)
  return setCookie.split(';', 1)[0]
}

async function status(url, cookie) {
  const response = await fetch(url, { headers: cookie === undefined ? {} : { cookie }, redirect: 'manual' })
  await response.arrayBuffer()
  return response.status
}

async function waitStatus(url, expected, cookie) {
  let observed = 0
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { observed = await status(url, cookie) } catch { observed = 0 }
    if (observed === expected) return observed
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`${url} expected ${expected}, observed ${observed}`)
}

async function openSocket(origin, cookie) {
  const url = new URL('/api/events.mux', origin)
  url.protocol = 'wss:'
  const socket = new WebSocket(url, { headers: { cookie, origin } })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${origin} WebSocket open timed out`)), 10_000)
    socket.once('open', () => { clearTimeout(timer); resolve() })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
  return socket
}

async function pingRoundTrip(socket) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open')
  const payload = Buffer.from(`dsh-isolation-${Date.now()}`)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket pong timed out')), 5_000)
    const pong = data => {
      if (!Buffer.from(data).equals(payload)) return
      clearTimeout(timer)
      socket.off('pong', pong)
      socket.off('error', error)
      resolve()
    }
    const error = reason => { clearTimeout(timer); socket.off('pong', pong); reject(reason) }
    socket.on('pong', pong)
    socket.once('error', error)
    socket.ping(payload)
  })
  return 'pong'
}

async function waitClosed(socket) {
  if (socket.readyState === WebSocket.CLOSED) return 'closed'
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('old x570 WebSocket did not close after rotation')), 10_000)
    socket.once('close', () => { clearTimeout(timer); resolve('closed') })
  })
}

async function checkZsh(socket, cookie) {
  const http = await status(`${zshOrigin}/`, cookie)
  if (http !== 200) throw new Error(`zsh protected HTTP returned ${http}`)
  return { protectedHttp: http, sameWebSocketRoundTrip: await pingRoundTrip(socket) }
}

async function healthyPair(zshSocket, zshCookie, x570Cookie) {
  const zsh = await checkZsh(zshSocket, zshCookie)
  const x570 = await status(`${x570Origin}/`, x570Cookie)
  if (x570 !== 200) throw new Error(`x570 protected HTTP returned ${x570}`)
  return { zsh, x570ProtectedHttp: x570 }
}
