import { createConnection } from 'node:net'

const TOKEN = /^[A-Za-z0-9_-]{43}$/u
const MAX_RESPONSE_BYTES = 4096

export interface LaunchRedemptionResult {
  sessionGrant: string
  roles: string[]
}

export async function redeemLaunch(socketPath: string, ticket: string): Promise<LaunchRedemptionResult> {
  if (!TOKEN.test(ticket)) throw new Error('Invalid launch ticket.')
  const response = await request(socketPath, { version: '1.0', operation: 'launch.redeem', payload: { ticket } })
  if (!isLaunchResponse(response)) throw new Error('Launch redemption failed.')
  return { sessionGrant: response.payload.session_grant, roles: response.payload.roles }
}

async function request(socketPath: string, payload: object): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    let source = ''
    const timer = setTimeout(() => { socket.destroy(new Error('Agent IPC timed out.')) }, 10_000)
    socket.setEncoding('utf8')
    socket.once('connect', () => { socket.end(`${JSON.stringify(payload)}\n`) })
    socket.on('data', chunk => {
      source += chunk
      if (Buffer.byteLength(source) > MAX_RESPONSE_BYTES) socket.destroy(new Error('Agent IPC response is too large.'))
    })
    socket.once('end', () => {
      clearTimeout(timer)
      try { resolve(JSON.parse(source) as unknown) } catch { reject(new Error('Invalid Agent IPC response.')) }
    })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

function isLaunchResponse(value: unknown): value is { version: '1.0'; ok: true; payload: { session_grant: string; roles: string[] } } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!Object.keys(record).every(key => ['version', 'ok', 'payload'].includes(key)) || record.version !== '1.0' || record.ok !== true
    || typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) return false
  const payload = record.payload as Record<string, unknown>
  return Object.keys(payload).every(key => ['session_grant', 'roles'].includes(key))
    && typeof payload.session_grant === 'string' && TOKEN.test(payload.session_grant)
    && Array.isArray(payload.roles) && payload.roles.length === 1 && payload.roles[0] === 'owner'
}
