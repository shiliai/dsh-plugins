/**
 * Sandbox boot E2E for dsh-cron: pack the plugin, install it into a temp DSH
 * home/profile, boot the real `dsh web` on a free port, then drive the
 * plugin's HTTP API end to end — state, catalog, create a one-shot command
 * job due within seconds, watch it fire, verify the run record and window
 * archiving, and check the cross-site fence. No LLM key is exercised (agent
 * paths are covered by unit tests and the local-deploy GUI pass).
 *
 * Run: pnpm --dir plugins/dsh-cron run smoke:boot
 */

import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dshBin = process.env.DSH_CRON_DSH_BIN ?? join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')

const temp = await mkdtemp(join(tmpdir(), 'dsh-cron-boot-'))
const port = await availablePort()
const origin = `http://127.0.0.1:${port}`
const dshHome = join(temp, 'home')
const workdir = join(temp, 'work')
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DEEPSEEK_API_KEY: 'dsh-cron-smoke-invalid-key',
}
let server

try {
  process.stdout.write('[1/6] build + pack\n')
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  execFileSync('pnpm', ['pack', '--pack-destination', temp], { cwd: root, stdio: 'inherit' })
  const archiveName = (await readdir(temp)).find(name => name.endsWith('.tgz'))
  if (archiveName === undefined) throw new Error('pnpm pack did not create an archive')
  const archive = join(temp, archiveName)
  const archiveSha = createHash('sha256').update(await readFile(archive)).digest('hex')

  process.stdout.write('[2/6] install plugin into temp profile\n')
  execFileSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', archive], { cwd: workdirToCreate(workdir), env, stdio: 'inherit' })

  process.stdout.write(`[3/6] boot dsh web on ${origin}\n`)
  server = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = collectOutput(server)
  const access = await waitForReady(origin, server, output)

  process.stdout.write('[4/6] plugin API surface\n')
  const state0 = await pluginApi(access, '/state')
  if (!Array.isArray(state0.jobs)) throw new Error(`/state returned no jobs array: ${JSON.stringify(state0).slice(0, 200)}`)
  process.stdout.write(`      state ok (jobs=${state0.jobs.length})\n`)

  const catalog = await pluginApi(access, '/catalog')
  process.stdout.write(`      catalog ok (models=${catalog.models.length}, presets=${catalog.agentPresets.length}, permissions=${catalog.permissionPresets.length})\n`)

  // One-shot command job due in ~3s (interval tick default 15s… speed it up via a
  // fresh job whose beat lands within two ticks).
  const at = new Date(Date.now() + 3_000).toISOString()
  const createResponse = await fetch(`${access.url}/dsh-cron/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(access.cookie !== undefined ? { cookie: access.cookie } : {}) },
    body: JSON.stringify({
      name: `smoke-oneshot-${Date.now()}`,
      trigger: { kind: 'oneshot', at },
      task: { kind: 'command', argv: [process.execPath, '-e', 'console.log("smoke ok"); process.exit(0)'] },
      overlap: 'skip',
      misfire: 'skip',
    }),
  })
  if (!createResponse.ok) throw new Error(`create job failed: HTTP ${createResponse.status} ${await createResponse.text()}`)
  const created = await createResponse.json()
  const jobId = created.job.id
  process.stdout.write(`[5/6] created one-shot job ${jobId} at ${at}\n`)

  // Wait for the fire (beat + up to two ticks + command execution).
  const deadline = Date.now() + 60_000
  let run = null
  let archived = false
  while (Date.now() < deadline) {
    const state = await pluginApi(access, '/state')
    const view = state.jobs.find(entry => entry.job.id === jobId)
    if (view !== undefined) {
      run = view.runs.find(candidate => candidate.seq === 1) ?? run
      archived = view.job.archivedAt !== undefined
      if (run?.status === 'ok' && archived) break
    }
    await sleep(1_000)
  }
  if (run?.status !== 'ok') throw new Error(`one-shot did not complete ok: ${JSON.stringify(run)}`)
  if (run.outputTail === undefined || !run.outputTail.includes('smoke ok')) throw new Error(`output tail missing: ${JSON.stringify(run)}`)
  if (!archived) throw new Error('one-shot did not self-archive after firing')
  process.stdout.write(`      run #1 ok, exit 0, output captured, self-archived\n`)

  // Restart resilience: the fired beat must stay consumed after a reboot of the
  // host is not exercised here; instead verify persistence across the API and
  // that the JSON fence rejects cross-site mutations.
  const fence = await fetch(`${access.url}/dsh-cron/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
    body: 'name=x',
  })
  if (fence.status !== 403) throw new Error(`cross-site fence not enforced: HTTP ${fence.status}`)

  process.stdout.write('[6/6] teardown\n')
  await stop(server)
  server = undefined
  execFileSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'remove', '@dsh-plugins/dsh-cron'], { cwd: workdir, env, stdio: 'inherit' })
  process.stdout.write(`smoke-boot PASSED commit-safe sha256=${archiveSha} origin=${origin}\n`)
} catch (error) {
  process.stderr.write(`smoke-boot FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  if (server !== undefined) {
    await stop(server).catch(() => undefined)
  }
  process.exitCode = 1
} finally {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined)
}

function workdirToCreate(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

async function pluginApi(access, path) {
  const response = await fetch(`${access.url}/dsh-cron/api${path}`, {
    headers: access.cookie !== undefined ? { cookie: access.cookie } : {},
  })
  if (!response.ok) throw new Error(`GET /dsh-cron/api${path} → HTTP ${response.status}`)
  return response.json()
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      if (address === null || typeof address === 'string') return reject(new Error('Could not allocate a smoke port'))
      socket.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

function collectOutput(child) {
  let buffer = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', chunk => {
      const text = chunk.toString()
      buffer = `${buffer}${text}`.slice(-16_384)
      process.stderr.write(text)
    })
  }
  return () => buffer
}

async function waitForReady(origin, child, output) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH exited before readiness (${child.exitCode})\n${output()}`)
    try {
      const accessUrl = output().match(/dsh web:\s+(https?:\/\/\S+)/)?.[1] ?? origin
      const response = await fetch(accessUrl, { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
      if (response.ok) return { url: accessUrl, cookie: undefined }
      if (response.status === 303) {
        const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
        if (setCookie !== undefined) return { url: accessUrl, cookie: setCookie.split(';', 1)[0] }
      }
    } catch {
      // Still booting.
    }
    await sleep(250)
  }
  throw new Error(`DSH did not become ready at ${origin}\n${output()}`)
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  await Promise.race([exited, sleep(5_000)])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
