import { EventEmitter } from 'node:events'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { installWebServerSocketCompatibility } from '../src/webserver-socket-compat.ts'

describe('webServer socket compatibility', () => {
  it('keeps a fallback error listener after an upgraded socket closes', () => {
    const server = new EventEmitter()
    const socket = new EventEmitter()
    const dispose = installWebServerSocketCompatibility({ server } as unknown as WebServer)

    server.emit('connection', socket)
    socket.emit('close')
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })

    expect(() => { socket.emit('error', reset) }).not.toThrow()
    dispose()
  })

  it('stops protecting new connections after disposal', () => {
    const server = new EventEmitter()
    const socket = new EventEmitter()
    const dispose = installWebServerSocketCompatibility({ server } as unknown as WebServer)

    dispose()
    server.emit('connection', socket)

    expect(socket.listenerCount('error')).toBe(0)
  })
})
