import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

interface WebServerInternals {
  server: Server
}

const absorbLateSocketError = (): void => {}

export function installWebServerSocketCompatibility(webServer: WebServer): () => void {
  const server = (webServer as unknown as WebServerInternals).server
  if (server === undefined || typeof server.on !== 'function') {
    throw new Error('dsh-remote: unsupported webServer socket lifecycle.')
  }

  // DSH rc.6-rc.8 removes its upgrade error handler on close, before Node can
  // deliver a late transport error from a browser reload.
  const protect = (socket: Socket): void => {
    socket.on('error', absorbLateSocketError)
  }
  server.on('connection', protect)

  return () => {
    server.off('connection', protect)
  }
}
