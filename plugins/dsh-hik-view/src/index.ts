/**
 * dsh-hik-view host half: relays one Hikvision NVR camera to the browser as
 * MJPEG. The NVR speaks RTSP/H.265, which browsers cannot play; ffmpeg on
 * this host pulls the stream over TCP and transcodes it to a JPEG sequence
 * wrapped as multipart/x-mixed-replace — a plain <img> can show it, no
 * client-side codec needed. The route lives on the same origin as the DSH
 * web GUI, so it traverses whatever relay the GUI uses (remote frp/VPS
 * included). Bandwidth is tuned down (fps / JPEG quality / max width) since
 * degraded quality is acceptable for monitoring.
 *
 * Routes (prefix /hik-view, same browser-trust fence as the /api gateway):
 *   GET /hik-view/api/info   → JSON channel list + live status
 *   GET /hik-view/stream?ch=N[&fps=&q=]  → MJPEG stream
 *
 * Every browser disconnect kills its ffmpeg child; a global cap bounds the
 * number of concurrent transcodes (ARM CPU + relay uplink protection).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import z from 'schemastery'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-hik-view'

/** Services required before mounting: webserver routes and the web runtime's trusted hosts. */
export const inject = ['webServer', 'webRuntime']

export interface NvrConfig {
  host: string
  port: number
  user: string
  password: string
}

export interface ChannelConfig {
  id: string
  label: string
  main: number
  sub: number
}

export interface StreamConfig {
  fps: number
  quality: number
  maxWidth: number
  maxStreams: number
}

export interface ResolvedConfig {
  nvr: NvrConfig
  channels: ChannelConfig[]
  stream: StreamConfig
}

/** Loader-validated plugin configuration. The assertion keeps the emitted
 *  d.ts portable — the inferred schemastery chain leaks a cosmokit store
 *  path that cannot be named from the package surface — and sidesteps the
 *  deep ObjectS/ObjectT generics under exactOptionalPropertyTypes. The
 *  schema carries defaults for every field, so a validated call always
 *  yields a complete ResolvedConfig. */
export const Config = z.object({
  nvr: z.object({
    host: z.string().default('10.18.7.191'),
    port: z.number().default(554),
    user: z.string().default('admin'),
    password: z.string().default(''),
  }),
  channels: z.array(z.object({
    id: z.string(),
    label: z.string(),
    main: z.number(),
    sub: z.number(),
  })).default([]),
  stream: z.object({
    fps: z.number().min(1).max(25).default(8),
    quality: z.number().min(2).max(31).default(12),
    maxWidth: z.number().min(160).max(2560).default(640),
    maxStreams: z.number().min(1).max(4).default(2),
  }),
}) as unknown as Schemastery<unknown, ResolvedConfig>

interface RelayLogger {
  info?(message: string): void
  warn?(message: string): void
}

interface WebRuntimeService {
  trustedHosts: string[]
}

interface WebServerService {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): unknown
}

export interface RelayContext {
  logger?: RelayLogger
  webRuntime: WebRuntimeService
  webServer: WebServerService
  effect(action: () => unknown, dispose?: () => void): void
}

interface RelaySession {
  channel: ChannelConfig
  fps: number
  quality: number
  startedAt: number
  lastBytesAt: number
  closing: boolean
  child: ChildProcessByStdio<null, Readable, Readable>
  res: ServerResponse
  watchdog?: ReturnType<typeof setInterval>
}

function resolveConfig(config: unknown): ResolvedConfig {
  return Config(config ?? {})
}

// ── Browser-trust fence (copied from dsh-better-sidebar/src/trust-fence.ts,
//    behaviorally identical to the /api gateway fence in
//    @deepseek-ai/dsh-client-connection) ──────────────────────────────────
function parseAuthority(authority: string): URL | undefined {
  try { return new URL(`http://${authority}`) } catch { return undefined }
}
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}
function isTrustedAuthority(hostUrl: URL, trustedHosts: string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}
function isTrustedApiRequest(request: IncomingMessage, trustedHosts: string[]): boolean {
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (typeof origin !== 'string') return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Build the ffmpeg argument list for one relay session.
 * - `-rtsp_transport tcp`: NVR pulls are TCP-only in this deployment (no UDP packet loss stalls).
 * - `fps` filter + `-q:v`: the quality-degradation knobs.
 * - `-f mpjpeg -boundary_tag dsh`: multipart JPEG streamed verbatim to the HTTP response.
 */
export function ffmpegArgs(url: string, { fps, quality, maxWidth }: Pick<StreamConfig, 'fps' | 'quality' | 'maxWidth'>): string[] {
  return [
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', url,
    '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale='min(${maxWidth},iw)':-2`,
    '-c:v', 'mjpeg',
    '-q:v', String(quality),
    '-f', 'mpjpeg',
    '-boundary_tag', 'dsh',
    'pipe:1',
  ]
}

export function apply(ctx: RelayContext, config: unknown): void {
  const resolved = resolveConfig(config)
  const fence = (req: IncomingMessage) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)
  /** channel id or 1-based index → channel record */
  const channelOf = (key?: string): ChannelConfig | undefined => {
    if (key === undefined || key === '') return resolved.channels[0]
    return resolved.channels.find(ch => ch.id === key)
      ?? resolved.channels[Number(key) - 1]
  }
  /** active ffmpeg children keyed by an internal session id */
  const active = new Map<number, RelaySession>()
  let nextSession = 1

  const status = () => [...active.values()].map(s => ({
    channel: s.channel.id, startedAt: s.startedAt, fps: s.fps,
  }))

  /**
   * Graceful teardown of one relay session: SIGTERM first (ffmpeg sends the
   * RTSP TEARDOWN so the NVR frees its per-channel slot right away), with a
   * 2s SIGKILL fallback. Idempotent — `closing` guards double kills fired by
   * the res/req event handlers.
   */
  const stopSession = (sessionId: number, reason: string): void => {
    const session = active.get(sessionId)
    if (session === undefined || session.closing) return
    session.closing = true
    if (session.watchdog !== undefined) clearInterval(session.watchdog)
    // Detach the relay from the response right away: SIGTERM latency means
    // ffmpeg can still emit frames while the browser socket is already gone,
    // and frames landing after `res.end()` would error the response.
    try { session.child.stdout.unpipe(session.res) } catch { /* stream already gone */ }
    const child = session.child
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM')
      const killer = setTimeout(() => {
        if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
      }, 2000)
      killer.unref?.()
    }
    ctx.logger?.info?.(`[dsh-hik-view] relay stop ch=${session.channel.id} reason=${reason} (active=${active.size})`)
  }

  const startStream = (req: IncomingMessage, res: ServerResponse, ch: ChannelConfig, overrides: { fps?: number | undefined; q?: number | undefined }): void => {
    // One session per channel: a new viewer on the same channel REPLACES the
    // previous one, so a leaked/stale viewer can never block the channel (the
    // observed failure mode: browser aborts mid-stream, the old ffmpeg
    // lingered, the cap filled up and every later request got 503).
    for (const [id, existing] of active) {
      if (existing.channel.id === ch.id) {
        ctx.logger?.info?.(`[dsh-hik-view] replacing stale session ch=${ch.id}`)
        stopSession(id, 'replaced')
      }
    }
    if (active.size >= resolved.stream.maxStreams) {
      writeJson(res, 503, { ok: false, error: { code: 'busy', message: `并发路数已达上限 (${resolved.stream.maxStreams})` } })
      return
    }
    const fps = clamp(overrides.fps ?? resolved.stream.fps, 1, 25)
    const quality = clamp(overrides.q ?? resolved.stream.quality, 2, 31)
    const url = `rtsp://${encodeURIComponent(resolved.nvr.user)}:${encodeURIComponent(resolved.nvr.password)}@${resolved.nvr.host}:${resolved.nvr.port}/Streaming/Channels/${ch.sub}`
    const session: RelaySession = {
      channel: ch,
      fps,
      quality,
      startedAt: Date.now(),
      lastBytesAt: Date.now(),
      closing: false,
      res,
      child: spawn('ffmpeg', ffmpegArgs(url, { fps, quality, maxWidth: resolved.stream.maxWidth }), {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
    const sessionId = nextSession++
    active.set(sessionId, session)
    ctx.logger?.info?.(`[dsh-hik-view] relay start ch=${ch.id} fps=${fps} q=${quality} (active=${active.size})`)
    session.child.stderr.on('data', (chunk: Buffer) => {
      ctx.logger?.warn?.(`[dsh-hik-view] ffmpeg ch=${ch.id}: ${String(chunk).trim()}`)
    })
    session.child.on('exit', () => {
      if (session.watchdog !== undefined) clearInterval(session.watchdog)
      active.delete(sessionId)
      // Unpipe before end(): in-flight stdout frames must not land after the
      // response ended — ERR_STREAM_WRITE_AFTER_END on a ServerResponse with
      // no 'error' listener escapes as an unhandled 'error' event and exits
      // the whole DSH web process (every stream-viewer disconnect took the
      // host down for everyone before this guard).
      try { session.child.stdout.unpipe(res) } catch { /* already detached */ }
      if (!res.writableEnded) res.end()
    })
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=dsh',
      'cache-control': 'no-store, no-cache',
      'x-accel-buffering': 'no',
      connection: 'close',
    })
    const close = () => stopSession(sessionId, 'client-closed')
    // Belt: any late write error on the response must never surface as an
    // unhandled 'error' event; route it into the same teardown path.
    res.on('error', close)
    // Track liveness for the idle watchdog.
    session.child.stdout.on('data', () => { session.lastBytesAt = Date.now() })
    session.child.stdout.pipe(res)
    // Idle watchdog: no JPEG bytes for 15s means the pipeline is stalled
    // (dead NVR connection, stuck ffmpeg) — release the slot and the NVR
    // session instead of leaking it.
    session.watchdog = setInterval(() => {
      if (Date.now() - session.lastBytesAt > 15000) stopSession(sessionId, 'idle')
    }, 3000)
    // SIGTERM lets ffmpeg close the RTSP session with a proper TEARDOWN so
    // the NVR releases its per-channel connection slot immediately; the
    // SIGKILL fallback (2s) only covers a hung ffmpeg.
    res.on('close', close)
    req.on('aborted', close)
    req.on('error', close)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/hik-view',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (url.pathname === '/hik-view/api/info') {
        writeJson(res, 200, {
          ok: true,
          channels: resolved.channels.map((ch, i) => ({ index: i + 1, id: ch.id, label: ch.label })),
          limits: resolved.stream,
          active: status(),
        })
        return
      }
      if (url.pathname === '/hik-view/api/client-log') {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > 65536) break
          chunks.push(chunk)
        }
        let payload: unknown
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { payload = { raw: 'unparsable' } }
        ctx.logger?.warn?.(`[dsh-hik-view] client: ${JSON.stringify(payload)}`)
        writeJson(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/hik-view/stream') {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const ch = channelOf(url.searchParams.get('ch') ?? undefined)
        if (ch === undefined) {
          writeJson(res, 404, { ok: false, error: { code: 'no-channel', message: '未知通道' } })
          return
        }
        startStream(req, res, ch, {
          fps: numOr(url.searchParams.get('fps')),
          q: numOr(url.searchParams.get('q')),
        })
        return
      }
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
    },
  }), () => {
    for (const sessionId of [...active.keys()]) {
      try { stopSession(sessionId, 'plugin-dispose') } catch { /* already gone */ }
    }
    active.clear()
  })
}

function numOr(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
