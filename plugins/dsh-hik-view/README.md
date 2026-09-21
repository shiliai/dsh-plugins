# dsh-hik-view

Live view of Hikvision NVR cameras inside the DSH web GUI. The host half
relays the NVR's RTSP (H.265) streams to browser-friendly MJPEG through
ffmpeg; the client half registers a single-instance bottom-panel tab
(「实时视频」) with channel switching, fps presets, and auto-reconnect.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /hik-view/api/info` | JSON channel list, stream limits, active sessions |
| `GET /hik-view/stream?ch=<id>&fps=&q=` | MJPEG stream (`multipart/x-mixed-replace`) |
| `POST /hik-view/api/client-log` | client-side lifecycle diagnostics → host journal |

All routes sit behind the same browser-trust fence as the `/api` gateway
(loopback or configured trusted hosts, same-site), so the stream traverses
the same relays the GUI uses — remote frp/VPS included.

## Relay safety

- One ffmpeg child per channel; a new viewer **replaces** a stale session so
  a leaked viewer can never block the channel, and a global cap
  (`stream.maxStreams`) bounds concurrent transcodes.
- Client disconnects SIGTERM ffmpeg (proper RTSP TEARDOWN so the NVR frees
  its per-channel slot) with a 2s SIGKILL fallback, and an idle watchdog
  releases stalled pipelines after 15s without frames.
- 0.1.1 fixes a process-fatal abort race: frames landing on an already-ended
  response after a viewer disconnected previously surfaced as an unhandled
  `ERR_STREAM_WRITE_AFTER_END` and **exited the whole DSH web process**. The
  relay now detaches (`unpipe`) on teardown and carries a response `error`
  listener, so a viewer disconnect can never take the host down.

## Configuration

Config comes from the package's `cordis.patch.yml` insert. **The NVR
password is intentionally not committed** — override it on the target host
with a profile-level patch entry (applied after bundle layers):

```yaml
# <DSH_HOME>/profiles/web/cordis.patch.yml
- id: hik-view
  config:
    nvr:
      password: <secret>
```

| Key | Default | Notes |
| --- | --- | --- |
| `nvr.host` / `port` / `user` | `10.18.7.191:554` / `admin` | NVR RTSP endpoint |
| `channels[]` | cam1–cam4, sub streams 102/202/302/402 | Hikvision `Streaming/Channels/<sub>` ids |
| `stream.fps` | `8` | 1–25, per-viewer override via `?fps=` |
| `stream.quality` | `12` | ffmpeg `-q:v`, 2 (best) – 31 |
| `stream.maxWidth` | `640` | downscale cap (ARM CPU + uplink protection) |
| `stream.maxStreams` | `4` | concurrent ffmpeg children |

Requires `ffmpeg` on the host `PATH` (openEuler: `dnf install ffmpeg`).
