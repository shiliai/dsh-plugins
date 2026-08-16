# DSH Remote Access Implementation Plan

Design authority:
`docs/superpowers/specs/2026-08-16-dsh-remote-design.md` (`remote-v1`).
Story authority: `docs/authority/remote-v1.md`, SHA-256
`796042b59d575a599107b67581c53e1dc8d173eb42a1a5003336807446239b6b`.

## Outcome Unit 1: Local Remote-Access Plugin

Create a publishable DSH plugin following the sibling `dsh-obsidian` conventions.
Implement secret storage, the authenticated HTTP/WebSocket gateway, SSH tunnel
supervision, management API, and sidebar panel. Add focused unit/integration
tests, package verification, and a local browser fixture.

Acceptance binds `US-R1` and `US-R2`: a clean browser exchanges the fragment,
uses complete proxied HTTP/WebSocket behavior, persists across reload, and loses
access immediately after rotation, including closure of existing upgraded
sockets, while a newly copied link succeeds. Build, install, lifecycle, client
slot, HTTP, and WebSocket behavior are verified against exactly DSH `0.1.0-rc.6`.

## Outcome Unit 2: Reversible VPS Edge

Implement an idempotent setup/status/rollback CLI and versioned templates for the
existing Docker Nginx deployment. Preflight DNS and certificate prerequisites,
apply only syntax-checked backup-first changes, mount the remote Unix socket, and
serve the offline page.

Acceptance binds `US-R1` and `US-R3`: HTTPS reaches the socket-backed tunnel with
no public tunnel port or request logging; tunnel absence returns the designed
`503`; the remote socket is group-owned mode `0660` and reachable by the live
Nginx worker; rollback metadata can restore the pre-state.

## Convergence

Build and package the plugin, install it into the active DSH Web profile, run the
VPS preflight and reversible deployment, and execute end-to-end browser checks on
`zsh.onlyservice.io`. Because the work handles bearer credentials and mutates a
shared production edge, freeze one stable subject for independent business,
security/data-integrity, and deploy/rollback review before final E2E.

## Recovery

Local recovery removes the plugin from the Web profile and restarts DSH with the
previous configuration. VPS recovery runs the generated rollback receipt to
restore the exact Nginx/Compose pre-state, validates it, and reloads or recreates
only the affected container. DNS and issued certificates are non-destructive and
may remain.
