import { createServer } from 'node:http'
import { once } from 'node:events'
import { RemoteGateway, RemoteStateStore } from '../../lib/index.js'
import { WebSocketServer } from 'ws'

const gatewayPort = Number(process.env.DSH_E2E_GATEWAY_PORT ?? 29321)
const targetPort = Number(process.env.DSH_E2E_TARGET_PORT ?? 29322)
const remoteOrigin = process.env.DSH_REMOTE_ORIGIN
const stateFile = process.env.DSH_REMOTE_STATE_FILE
const agentSocketPath = process.env.DSH_REMOTE_AGENT_SOCKET_PATH
if (remoteOrigin === undefined || stateFile === undefined || agentSocketPath === undefined) {
  throw new Error('Host Gateway fixture environment is incomplete.')
}

const target = createServer(async (request, response) => {
  if (request.url === '/api/echo' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
    response.end(body)
    return
  }
  if (request.url === '/api/stream') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.write('first\n')
    setTimeout(() => { response.end('second\n') }, 150)
    return
  }
  const body = '<!doctype html><title>DSH E2E</title><main>DSH E2E fixture</main>'
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
})
const webSockets = new WebSocketServer({ noServer: true })
target.on('upgrade', (request, socket, head) => {
  webSockets.handleUpgrade(request, socket, head, connection => {
    connection.on('message', message => { connection.send(message) })
  })
})
target.listen(targetPort, '127.0.0.1')
await once(target, 'listening')

const state = await RemoteStateStore.open(stateFile)
const gateway = new RemoteGateway({ targetPort, remoteOrigin, state, host: '127.0.0.1', port: gatewayPort, agentSocketPath })
await gateway.listen()
process.stdout.write('gateway-ready\n')

async function close() {
  for (const connection of webSockets.clients) connection.terminate()
  await gateway.close()
  await new Promise(resolve => { target.close(() => { resolve() }) })
}
process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
