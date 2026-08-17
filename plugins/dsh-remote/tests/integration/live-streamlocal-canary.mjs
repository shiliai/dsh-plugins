import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TunnelSupervisor } from '../../lib/index.js'

const execute = promisify(execFile)
const sshTarget = process.env.DSH_REMOTE_CANARY_SSH_TARGET ?? 'vps-tencent-tokyo'
const localPort = Number(process.env.DSH_REMOTE_CANARY_LOCAL_PORT ?? '3180')
const remoteSocketPath = `/tmp/dsh-remote-live-canary-${process.pid}.sock`
if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('Invalid canary local port.')

const supervisor = new TunnelSupervisor({
  sshTarget,
  remoteSocketPath,
  localPort,
  reconnectBaseMs: 250,
  reconnectMaxMs: 1000,
  reconnectMaxRetries: 1,
  stabilityDelayMs: 750,
})

try {
  supervisor.start()
  const deadline = Date.now() + 20_000
  while (supervisor.status().phase !== 'online' && Date.now() < deadline) {
    const status = supervisor.status()
    if (status.phase === 'failed') throw new Error(`Tunnel failed: ${status.reason ?? 'unknown'}`)
    await delay(100)
  }
  if (supervisor.status().phase !== 'online') throw new Error(`Tunnel did not become online: ${JSON.stringify(supervisor.status())}`)

  const mode = (await execute('ssh', ['-o', 'BatchMode=yes', sshTarget, 'stat', '-c', '%a', '--', remoteSocketPath])).stdout.trim()
  if (mode !== '660') throw new Error(`Expected remote socket mode 660, got ${mode}.`)
  const response = await execute('ssh', [
    '-o', 'BatchMode=yes', sshTarget,
    'curl', '--silent', '--show-error', '--max-time', '10',
    '--unix-socket', remoteSocketPath,
    'http://localhost/', '-o', '/dev/null', '-w', '%{http_code}',
  ])
  if (response.stdout.trim() !== '200') throw new Error(`Expected HTTP 200 through tunnel, got ${response.stdout.trim()}.`)
  process.stdout.write(JSON.stringify({ status: 'passed', mode, httpStatus: 200, socketPath: remoteSocketPath }) + '\n')
} finally {
  supervisor.stop()
  await delay(250)
  await execute('ssh', ['-o', 'BatchMode=yes', sshTarget, 'rm', '-f', '--', remoteSocketPath]).catch(() => {})
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

