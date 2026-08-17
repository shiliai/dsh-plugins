import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 4317)
const clients = new Set()

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
])

function sendFile(requestPath, response) {
  const decoded = decodeURIComponent(requestPath.split('?', 1)[0])
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = resolve(root, normalize(relative))
  if (!candidate.startsWith(`${root}/`) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(candidate)) ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  createReadStream(candidate).pipe(response)
}

const server = createServer((request, response) => {
  if (request.url === '/__live') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    response.write(': connected\n\n')
    clients.add(response)
    request.on('close', () => clients.delete(response))
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }
  sendFile(request.url ?? '/', response)
})

let refreshTimer
watch(root, { recursive: true }, (_event, filename) => {
  if (!filename || filename === 'server.mjs') return
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    for (const client of clients) client.write('event: reload\ndata: changed\n\n')
  }, 80)
})

server.listen(port, host, () => {
  process.stdout.write(`DSH explainer: http://${host}:${port}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
