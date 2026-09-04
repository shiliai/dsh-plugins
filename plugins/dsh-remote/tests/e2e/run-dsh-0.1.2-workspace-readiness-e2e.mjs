import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const DSH_VERSION = '0.1.2-rc.1'
const root = fileURLToPath(new URL('../..', import.meta.url))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('DSH 0.1.2 E2E requires an immutable Git commit.')
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }) !== '') {
  throw new Error('DSH 0.1.2 E2E requires a fixed tracked subject; unrelated untracked files are ignored.')
}

const temp = await mkdtemp(join(tmpdir(), 'dsh-remote-0.1.2-'))
const dshHome = join(temp, 'dsh-home')
const workspacePath = join(temp, 'workspace')
const port = await availablePort()
const origin = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_REMOTE_ORIGIN: 'https://fixture.invalid',
  DSH_REMOTE_SSH_TARGET: 'invalid-dsh-0-1-2-fixture.invalid',
  DSH_REMOTE_STATE_FILE: join(temp, 'remote-state.json'),
}
const output = []
let dsh
let browser

try {
  await mkdir(workspacePath)
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  execFileSync('pnpm', ['pack', '--pack-destination', temp], { cwd: root, stdio: 'inherit' })
  const remoteArchiveName = (await readdir(temp)).find(name => name.startsWith('dsh-plugins-dsh-remote-') && name.endsWith('.tgz'))
  if (remoteArchiveName === undefined) throw new Error('pnpm pack did not create the dsh-remote archive.')
  const remoteArchive = join(temp, remoteArchiveName)
  const archiveSha = createHash('sha256').update(await readFile(remoteArchive)).digest('hex')
  const fixtureArchive = await createFixturePackage(temp)

  runDsh(['plugin', '--profile', 'web', 'add', remoteArchive], temp, env)
  runDsh(['plugin', '--profile', 'web', 'add', fixtureArchive], temp, env)
  dsh = spawn('pnpm', [`--package=@deepseek-ai/dsh@${DSH_VERSION}`, 'dlx', 'dsh', 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  collectOutput(dsh, output)
  await waitForReady(origin, dsh, output)

  browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage()
  await page.goto(origin)
  await page.waitForFunction(() => window.__DSH_REMOTE_RC12_E2E__ !== undefined)
  await page.evaluate(path => window.__DSH_REMOTE_RC12_E2E__.start(path), workspacePath)
  await page.waitForFunction(() => window.__DSH_REMOTE_RC12_E2E__.snapshot().modelLoadEntered)

  const blocked = await page.evaluate(() => window.__DSH_REMOTE_RC12_E2E__.snapshot())
  if (blocked.resolved || blocked.sessionId === undefined || blocked.current === blocked.sessionId) {
    throw new Error(`workspace navigation was not held before model readiness: ${JSON.stringify(blocked)}`)
  }

  await page.evaluate(() => window.__DSH_REMOTE_RC12_E2E__.release())
  const completed = await page.evaluate(() => window.__DSH_REMOTE_RC12_E2E__.finish())
  if (!completed.resolved || completed.current !== completed.sessionId || completed.error !== undefined) {
    throw new Error(`workspace navigation did not complete after readiness: ${JSON.stringify(completed)}`)
  }

  process.stdout.write(`DSH ${DSH_VERSION} workspace readiness E2E passed commit=${commit} package_sha256=${archiveSha} blocked_before_model_ready=true opened_after_release=true workspace=${completed.workspaceId} session=${completed.sessionId}\n`)
} finally {
  if (browser !== undefined) await browser.close()
  if (dsh !== undefined) await stop(dsh)
  await rm(temp, { recursive: true, force: true })
}

async function createFixturePackage(directory) {
  const fixture = join(directory, 'fixture-package')
  await mkdir(fixture)
  await writeFile(join(fixture, 'package.json'), `${JSON.stringify({
    name: '@dsh-plugins/dsh-remote-rc12-fixture',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    exports: { '.': './index.js', './client': './client.js', './cordis.patch.yml': './cordis.patch.yml' },
    files: ['index.js', 'client.js', 'cordis.patch.yml'],
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: [
          '@dsh-plugins/dsh-remote',
          '@deepseek-ai/dsh-client-ui-workspace',
          '@deepseek-ai/dsh-client-ui-model-selection',
        ],
      },
    },
  }, null, 2)}\n`)
  await writeFile(join(fixture, 'index.js'), 'export function apply() {}\n')
  await writeFile(join(fixture, 'cordis.patch.yml'), "- insert:\n    - id: dsh-remote-rc12-fixture\n      name: '@dsh-plugins/dsh-remote-rc12-fixture'\n")
  await writeFile(join(fixture, 'client.js'), String.raw`window.__ModuleLoader__.load({
  id: '@dsh-plugins/dsh-remote-rc12-fixture',
  factory: () => {
    const module = { exports: {} }
    const inject = ['workspaces', 'sessions', 'uiWorkspace', 'modelDirectories']
    function apply(ctx) {
      let run
      window.__DSH_REMOTE_RC12_E2E__ = {
        async start(path) {
          if (run !== undefined) throw new Error('fixture navigation already started')
          const workspace = await ctx.workspaces.create({ path })
          let releaseGate
          const gate = new Promise(resolve => { releaseGate = resolve })
          const state = {
            workspaceId: workspace.workspaceId,
            sessionId: undefined,
            modelLoadEntered: false,
            resolved: false,
            error: undefined,
          }
          const resolver = ctx.modelDirectories
          const originalDirectoryFor = resolver.directoryFor
          const gatedDirectoryFor = function (id) {
            const directory = originalDirectoryFor.call(this, id)
            const originalLoad = directory.load.bind(directory)
            return {
              load: async () => {
                state.sessionId = id
                state.modelLoadEntered = true
                await gate
                return await originalLoad()
              },
            }
          }
          resolver.directoryFor = gatedDirectoryFor
          const navigation = ctx.uiWorkspace.connectWorkspace(workspace.workspaceId).then(id => {
            state.sessionId = id
            state.resolved = true
            ctx.sessions.open(id)
            return id
          }).catch(error => {
            state.error = String(error)
            throw error
          })
          run = {
            state,
            release: releaseGate,
            navigation,
            restore() {
              if (resolver.directoryFor === gatedDirectoryFor) resolver.directoryFor = originalDirectoryFor
            },
          }
        },
        snapshot() {
          if (run === undefined) return { started: false }
          return { ...run.state, current: ctx.sessions.list.getSnapshot().current }
        },
        release() {
          if (run === undefined) throw new Error('fixture navigation has not started')
          run.release()
        },
        async finish() {
          if (run === undefined) throw new Error('fixture navigation has not started')
          try {
            await run.navigation
            return this.snapshot()
          } finally {
            run.restore()
          }
        },
      }
      return () => {
        run?.restore()
        delete window.__DSH_REMOTE_RC12_E2E__
      }
    }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
`)
  execFileSync('pnpm', ['pack', '--pack-destination', directory], { cwd: fixture, stdio: 'inherit' })
  const archive = (await readdir(directory)).find(name => name.startsWith('dsh-plugins-dsh-remote-rc12-fixture-') && name.endsWith('.tgz'))
  if (archive === undefined) throw new Error('pnpm pack did not create the E2E fixture archive.')
  return join(directory, archive)
}

function runDsh(args, cwd, processEnv) {
  execFileSync('pnpm', [`--package=@deepseek-ai/dsh@${DSH_VERSION}`, 'dlx', 'dsh', ...args], {
    cwd,
    env: processEnv,
    stdio: 'inherit',
  })
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not allocate an E2E port.')
  await new Promise((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)) })
  return address.port
}

function collectOutput(child, lines) {
  child.stdout.on('data', chunk => { lines.push(chunk.toString()) })
  child.stderr.on('data', chunk => { lines.push(chunk.toString()) })
}

async function waitForReady(baseUrl, child, lines) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`DSH ${DSH_VERSION} exited early (${child.exitCode}):\n${lines.join('')}`)
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`DSH ${DSH_VERSION} did not become ready:\n${lines.join('')}`)
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
