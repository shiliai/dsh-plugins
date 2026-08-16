# DSH Remote Access Design

Status: approved by the user on 2026-08-16.

Authority: `docs/authority/remote-v1.md`, SHA-256
`796042b59d575a599107b67581c53e1dc8d173eb42a1a5003336807446239b6b`.

## Goal

Expose the currently running loopback-only DSH Web profile at
`https://zsh.onlyservice.io` through `vps-tencent-tokyo`. A private, persistent,
high-entropy link grants access without a separate username or password. The
owner can see connection state, copy the link, and rotate it.

## Authoritative User Stories

Baseline revision: `remote-v1`.

### US-R1

As the DSH owner, I want to open one long-lived private link on any device without
entering account credentials, so that I can use the complete currently running
DSH, including realtime connections.

- Given local DSH and the tunnel are online
- When the owner opens `https://zsh.onlyservice.io/#/access/<token>`
- Then the browser establishes a secure session and enters DSH, with refresh,
  root-relative resources, APIs, and WebSocket traffic working normally

### US-R2

As the DSH owner, I want to inspect remote status, copy the private link, and
rotate it, so that I can manage access without editing server configuration.

- Given remote access has been configured
- When the owner rotates the link
- Then all old links and sessions become invalid immediately and one new
  persistent link is available to copy

### US-R3

As the DSH owner, I want a clear unavailable page when local DSH or its tunnel is
offline, so that I do not see an opaque proxy error or login prompt.

- Given the public site is configured but the tunnel cannot serve DSH
- When the owner opens the remote URL
- Then the VPS returns a minimal branded `503` page with a retry action and no
  infrastructure details

## Non-goals

- No account, password, OAuth, invitation, or multi-user authorization system.
- No DSH conversation or workspace persistence on the VPS.
- No public TCP listener for the reverse tunnel.
- No automatic DNS-provider mutation.
- No support for multiple simultaneous local DSH instances in the first release.

## Architecture

The browser connects to Dockerized Nginx on the VPS. Nginx terminates TLS and
proxies through a bind-mounted Unix socket. OpenSSH creates that remote Unix
socket and forwards it to a plugin-owned loopback gateway on the local machine.
The gateway authenticates the complete HTTP and WebSocket surface before proxying
to the DSH web server's loopback port.

```text
Browser -> HTTPS Nginx -> mounted Unix socket -> SSH reverse forwarding
        -> local auth gateway -> loopback DSH Web server
```

The local gateway is necessary because DSH plugins can register their own HTTP
and upgrade routes but cannot wrap all routes already owned by the host. The Unix
socket is necessary because Nginx runs in a container while OpenSSH remote
forwarding is constrained to the VPS host loopback network.

## Access And Session Flow

The copied URL is `https://zsh.onlyservice.io/#/access/<base64url-token>`, where
the token contains 256 random bits. URL fragments are not sent in HTTP requests,
Nginx logs, or Referer headers.

An unauthenticated request for `/` receives a small no-store bootstrap document.
Its script extracts the fragment and sends the token in a JSON POST to the local
gateway through `/__dsh_remote/session`. A valid exchange sets a
`__Host-dsh_remote` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, and
`Path=/`, clears the fragment with `history.replaceState`, and reloads `/`.

The cookie is a versioned HMAC-derived value, not the bearer token itself. The
gateway verifies it with constant-time comparison for every HTTP request and
WebSocket upgrade. Rotating the 256-bit token increments the version and changes
the derived verifier, invalidating all earlier links and cookies immediately.
The gateway also tracks every authenticated upgraded socket by session version;
rotation actively closes sockets authenticated under an earlier version before
the rotate operation reports success.

Invalid tokens receive a generic denial response. Gateway responses set
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and defensive content
headers. Mutating management endpoints require an allowed same-origin `Origin`.

## Local Plugin Components

- `RemoteStateStore` owns the mode-0600 state file and atomic token rotation.
- `RemoteGateway` owns bootstrap/session handling, HTTP proxying, upgrade
  proxying, origin checks, and authentication.
- `TunnelSupervisor` spawns `ssh` with argument arrays and no shell, verifies host
  keys, requests remote Unix socket forwarding, sends keepalives, and retries with
  bounded exponential backoff and jitter.
- `RemoteService` exposes a stable status snapshot and coordinates lifecycle.
- `/dsh-remote/api` returns status and handles rotate/reconnect operations.
- The client contributes a sidebar-footer action and compact panel for state,
  link copy, rotation confirmation, and retry.

The state file defaults under the user's configuration directory. The normal DSH
configuration contains only non-secret settings such as remote origin, SSH alias,
socket path, and reconnect bounds.

The compatibility target is exactly DSH `0.1.0-rc.6`. Package peer dependencies,
Cordis injection names, web-server route and upgrade contracts, `webServer.port`
discovery, effect disposal, and client slot injection are pinned to and verified
against that release. Supporting another DSH release requires a separately tested
compatibility change.

## VPS Setup

The package includes an idempotent setup command. It checks SSH connectivity,
DNS resolution to `43.167.173.46`, Docker/Nginx state, socket/group permissions,
and existing managed markers. It then:

1. creates a timestamped backup of the host Nginx config and Compose file;
2. creates a setgid socket directory and dedicated group shared by the SSH user
   and Nginx container;
3. adds a read-only socket-directory mount and supplementary group to Compose;
4. adds an HTTP-only ACME/redirect site, validates Nginx, and reloads;
5. reuses the existing Certbot data volumes to issue the certificate;
6. installs the HTTPS proxy and offline error page, validates, and reloads;
7. records hashes of the pre-state and applied managed block for rollback.

The Nginx site disables access logging, supports HTTP/1.1 Upgrade, disables proxy
buffering, applies appropriate timeouts, and intercepts `502`, `503`, and `504`
to an internal static `503` response. It never stores the access token.

The socket directory is owned by the dedicated group and has setgid mode `2770`.
The SSH user belongs to that group, the Nginx container receives the same GID via
Compose `group_add`, and SSH is invoked with `StreamLocalBindMask=0117` so the
remote socket is created as `0660` and inherits the directory group. Setup proves
the running Nginx worker can connect through the mounted socket before declaring
the edge healthy.

The setup command stops without reload when a preflight, ACME, Compose, or
`nginx -t` step fails. Rollback restores the exact recorded files, validates the
restored Nginx configuration, recreates the container only when Compose changed,
and reloads Nginx. Certificates are retained by default.

## Failure States

- Tunnel start failure: status becomes `reconnecting` with a redacted reason;
  retries are bounded and do not block DSH startup.
- Stale remote socket: OpenSSH is invoked with stream-local unlink behavior;
  setup never removes a socket owned by an unverified live SSH process.
- Local DSH stops: plugin effects stop the gateway and SSH child; Nginx serves the
  offline page.
- Invalid or missing link: bootstrap shows a concise invalid-link state without
  revealing whether a token was previously valid.
- Rotation persistence failure: no in-memory token change is published; the old
  link remains valid and the API reports the failure.
- DNS/certificate unavailable: setup remains incomplete and does not install an
  invalid HTTPS server block.

## Verification

- Unit tests cover state permissions/atomicity, HMAC verification, rotation,
  bootstrap exchange, origin enforcement, redaction, and retry state transitions.
- Integration tests proxy HTTP and WebSocket traffic through the local gateway.
- Rotation tests keep a WebSocket open, rotate, and prove that the existing
  socket closes before the operation succeeds.
- Packaging checks verify only intended runtime files ship.
- A disposable SSH/socket fixture verifies command arguments and lifecycle.
- VPS checks verify managed config syntax, socket mount/permissions, TLS, no
  access logging, offline `503`, and rollback metadata.
- An rc.6 fixture builds and installs the package into DSH `0.1.0-rc.6`, verifies
  plugin lifecycle, sidebar rendering, status API, HTTP proxying, and WebSocket
  proxying, and fails on peer/API drift.
- Final Playwright E2E opens the private URL in a clean browser context, reaches
  DSH, reloads, exercises a realtime connection, rotates the link, proves the old
  context and its established realtime socket are terminated, and proves the new
  link works.

## Alignment Playback

`US-R1`, `US-R2`, and `US-R3` are covered by the access flow, management surface,
and VPS offline behavior respectively. No approved role, goal, value, boundary,
or observable result is changed. Design drift score: 0 (`DESIGN_ALIGNED`).

## Research Inputs

- `docs/authority/remote-v1.md`
- `planning/02-working/environment-research.md`
- `planning/03-core/verified-constraints.md`
