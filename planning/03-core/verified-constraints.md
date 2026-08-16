# Verified Constraints

Source: `planning/02-working/environment-research.md`.

1. Keep DSH bound to loopback; public traffic enters only through HTTPS on the VPS.
2. Authenticate before proxying every HTTP request and WebSocket upgrade.
3. Do not depend on a URL path prefix because DSH uses root-relative resources.
4. Keep the bearer token off server URLs and logs by placing it in the URL fragment
   and exchanging it through a no-store POST.
5. Keep access secrets on the local machine in a mode-0600 state file.
6. Connect the Dockerized Nginx to the reverse tunnel through a mounted Unix
   socket with a dedicated group, not a public TCP port.
7. Treat DNS and certificate readiness as explicit setup gates.
8. Make every VPS config change backup-first, syntax-checked, idempotent, and
   reversible.

