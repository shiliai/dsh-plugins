import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dshBin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const playwrightBin = join(root, 'node_modules/@playwright/test/cli.js')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const worktree = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
if (worktree !== '') throw new Error('rc.6 E2E requires a clean fixed subject')

const temp = await mkdtemp(join(tmpdir(), 'dsh-obsidian-rc6-'))
const port = await availablePort()
const origin = `http://127.0.0.1:${port}`
const vault = join(temp, 'vault')
const dshHome = join(temp, 'home')
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_OBSIDIAN_ORIGIN: origin,
  DEEPSEEK_API_KEY: 'dsh-obsidian-rc6-invalid-key',
}
let server

try {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  execFileSync('pnpm', ['pack', '--pack-destination', temp], { cwd: root, stdio: 'inherit' })
  const archiveName = (await readdir(temp)).find(name => name.endsWith('.tgz'))
  if (archiveName === undefined) throw new Error('pnpm pack did not create an archive')
  const archive = join(temp, archiveName)
  const archiveSha = createHash('sha256').update(await readFile(archive)).digest('hex')

  await cp(join(root, 'tests/fixtures/vault'), vault, { recursive: true })
  runDsh(['plugin', '--profile', 'web', 'add', archive], vault, env)
  server = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: vault,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverOutput = collectOutput(server)
  await waitForReady(origin, server, serverOutput)
  const workspace = await rpc(origin, 'workspace.create', { path: vault })
  const session = await rpc(origin, 'session.create', { workspaceId: workspace.workspace.workspaceId })

  const result = spawn(process.execPath, [playwrightBin, 'test'], {
    cwd: root,
    env: {
      ...env,
      PLAYWRIGHT_BASE_URL: origin,
      DSH_OBSIDIAN_E2E_COMMIT: commit,
      DSH_OBSIDIAN_E2E_PACKAGE_SHA: archiveSha,
      DSH_OBSIDIAN_E2E_SESSION_ID: session.sessionId,
    },
    stdio: 'inherit',
  })
  const exitCode = await new Promise(resolveExit => result.once('exit', resolveExit))
  if (exitCode !== 0) throw new Error(`rc.6 E2E failed with exit code ${exitCode}`)

  await stop(server)
  server = undefined
  runDsh(['plugin', '--profile', 'web', 'remove', '@dsh-plugins/dsh-obsidian'], vault, env)
  process.stdout.write(`rc.6 E2E passed commit=${commit} package_sha256=${archiveSha} origin=${origin}\n`)
} finally {
  if (server !== undefined) await stop(server)
  await rm(temp, { recursive: true, force: true })
}

function runDsh(args, cwd, processEnv) {
  execFileSync(process.execPath, [dshBin, ...args], { cwd, env: processEnv, stdio: 'inherit' })
}

async function rpc(origin, method, payload) {
  const rpcId = `dsh-obsidian-e2e-${randomUUID()}`
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!response.ok) throw new Error(`${method} transport failed with HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(envelope)}`)
  }
  return envelope.result.value
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      if (address === null || typeof address === 'string') return reject(new Error('Could not allocate an E2E port'))
      socket.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

function collectOutput(child) {
  let output = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', chunk => {
      const text = chunk.toString()
      output = `${output}${text}`.slice(-16_384)
      process.stderr.write(text)
    })
  }
  return () => output
}

async function waitForReady(origin, child, output) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH exited before readiness (${child.exitCode})\n${output()}`)
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // The profile is still booting.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`DSH did not become ready at ${origin}\n${output()}`)
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  await Promise.race([exited, new Promise(resolveDelay => setTimeout(resolveDelay, 5_000))])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}
