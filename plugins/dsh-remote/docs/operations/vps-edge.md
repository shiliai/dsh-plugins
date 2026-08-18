# VPS Edge Operations

The edge command targets `vps-tencent-tokyo` and `zsh.onlyservice.io` by default.
It copies versioned helper assets into a mode-0700 temporary directory, invokes
the remote helper through passwordless sudo, and removes the staging directory.

For multiple DSH hosts, Hub mode manages `*.dsh.onlyservice.io` with one DNS-01
wildcard certificate, one mounted generated-route directory, and one mode-0600
instance registry. Each registered ID maps to
`/run/dsh-remote/instances/<id>.sock`; unknown hosts return `404`, while a
registered host whose tunnel is offline reaches the branded `503` fallback.
Adding or removing an instance performs `nginx -t` before reload and restores
both the registry and generated routes if validation fails.

Run `dsh-remote-install-node <package.tgz> <instance-id>` on each
DSH node before Hub registration. It installs the bundle into the fixed Web
profile and manages a persistent `dsh-remote-<instance-id>.service`; profile and
unit pre-state is retained under `~/.local/state/dsh-remote/instance-installs/`.
The command fails unless `loginctl show-user "$USER" -p Linger --value` is
`yes`. Pass `--enable-linger` as the final argument only after authorizing that
host-level change. Verify both `systemctl --user is-enabled` and `is-active`,
then disconnect the provisioning SSH session and verify the protected endpoint.
After an authorized reboot, repeat the unit, tunnel, protected HTTP, and
WebSocket checks before registration is considered durable.

Before the first service start, an operator may place
`DSH_REMOTE_INITIAL_TOKEN=<43-character-base64url-token>` in the mode-0600 file
`~/.config/dsh-remote/<instance-id>.env`. The installer wires that per-instance
file through systemd `EnvironmentFile`. The plugin consumes it only when its
state file is absent; an existing state file and all later rotations take
precedence. Do not place this bearer value in Cordis YAML, shell history, logs,
or deployment receipts.

```sh
node scripts/dsh-remote-edge.mjs preflight
node scripts/dsh-remote-edge.mjs apply
node scripts/dsh-remote-edge.mjs status
node scripts/dsh-remote-edge.mjs renewal-check
node scripts/dsh-remote-edge.mjs rollback --receipt <receipt-id>
```

Those commands are the legacy single-site edge. Hub operations use the explicit
namespace and must not be substituted with the legacy renewal or rollback path:

```sh
dsh-remote-edge hub preflight
dsh-remote-edge hub apply
dsh-remote-edge hub status
dsh-remote-edge hub acknowledge-alert
dsh-remote-edge hub admin-init
dsh-remote-edge hub admin-rotate
dsh-remote-edge hub renewal-check
dsh-remote-edge instance add x570
dsh-remote-edge instance status x570
dsh-remote-edge instance remove x570
dsh-remote-edge instance rollback --receipt <transaction-id>
dsh-remote-edge hub rollback --receipt <deployment-receipt-id>
```

`preflight` is read-only. It requires the domain A record to resolve to
`43.167.173.46`, validates the existing Compose model and live Nginx config, and
reports pre-state hashes.

`apply` creates a receipt and exact Nginx/Compose backups before mutation. It
creates the dedicated socket group and mode-2770 host directory, adds only the
managed socket/offline mounts and supplementary group to the Nginx service,
installs the marked HTTP ACME site, recreates and validates Nginx, obtains the
certificate through the existing Certbot volumes, then installs and activates
the marked HTTPS site and managed certificate-renewal schedule. Any failed step
invokes automatic restoration from the same receipt.

The HTTPS proxy disables request and response buffering, so large DSH uploads and
streaming responses are not staged by Nginx. A reachable DSH response, including
an application `502`, `503`, or `504`, passes through unchanged. Only a connection
error, timeout, or invalid upstream header retries to a container-loopback backup
that serves the branded retryable `503` page; the backup has no public listener.
Ordinary HTTP requests keep the Unix-socket upstream connection alive so repeated
requests reuse the existing SSH forwarding channel. WebSocket requests still set
the explicit Upgrade and Connection headers required for protocol switching.

The Nginx config is a single-file Docker bind mount. Atomic replacement changes
the host inode, so both the HTTP staging write and final HTTPS write recreate the
Nginx container before validation. A reload alone would keep the stale mounted
inode and is intentionally not used.

Legacy receipts remain under `/home/chriswang/.local/state/dsh-remote/backups/`.
Hub v2 deployment receipts are stored under
`/home/chriswang/.local/state/dsh-remote-hub/backups/<receipt-id>/receipt.json`
with mode 0600. They contain pre/post identities and metadata-preserving backups
for Nginx, Compose, the complete wildcard certificate lineage, renewal and
monitoring units, managed files/directories, and group pre-state, but no plaintext
access credential. Bind the receipt SHA-256 shown by `hub apply` to deployment evidence.
`hub rollback` is chain guarded: stop every registered tunnel, roll back the
newest instance transactions first, then the newest Hub deployment receipt. It
restores the exact pre-state, validates Compose and Nginx, records a verified
rollback result in the receipt, and removes only a group or empty directory that
the reverted apply created.
A live or stale socket blocks every manual rollback before any restore write;
stop the local DSH tunnel and remove only its dedicated stale socket first.
Instance transactions are serialized under the Hub lock and stored at
`/home/chriswang/.local/state/dsh-remote-hub/transactions/<transaction-id>/`.
Registry and routes carry the same generation ID. An interrupted prepared
transaction is restored before the next operation. Removal atomically renames a
socket into that receipt's quarantine before activation; any failure renames the
same inode back. `--force` permits quarantining a live socket but never discards
its rollback copy. Reverse completed add/remove receipts newest-first with
`instance rollback`; a generation mismatch is rejected. Retain transaction
directories while rollback is required. Repeating a completed rollback is a
no-op.

Hub `status` distinguishes `configured` from `ready`. Configured means registry
and routes have the same exact generation, the registry and managed files have
the required metadata, all four Compose mounts and `group_add` are present, the
socket directories have exact owner/group/mode, the digest-pinned certificate
and renewal/health schedules are valid, Nginx validates, and its worker belongs
to the socket GID. Each registered node is `online`, `offline`, `insecure`, or
`missing`. Online additionally requires a mode-0660 listening socket with exact
owner/group and a bounded HTTPS request through that node's Nginx route to
return the gateway's expected unauthenticated `401` on `/api/events.mux`. A
listening but nonresponsive socket is offline; a regular file is insecure.

## Hidden Hub administration

Run `dsh-remote-edge hub admin-init` after Hub apply. It reads a new management
password from the controlling TTY and prints one randomly generated 256-bit
path. For automation, pipe exactly one password line and pass
`--password-stdin`; passwords are never command arguments. The Hub writes only
an `openssl passwd -6` SHA-512 crypt hash to the mode-0640
`dsh-remote-hub/admin/users.htpasswd` file, while the random path is held in the
mode-0600 state configuration. Rotate the password with `hub admin-rotate`;
the random path remains stable and the authentication file is atomically
replaced. Apply receipts include their exact pre-state; each initialization or
rotation also creates a mode-0700 local transaction snapshot containing only
the prior hash and generated files, so failed Nginx validation or reload
restores the prior configuration, route, status, and hash without recording a
plaintext password.

The generated routes expose only exact matches for the random page path and
its `/status` JSON endpoint. Both use the same Basic-authentication file and a
five-request-per-minute per-client Nginx limit. The base host, common admin
paths, unknown paths, and unknown hosts continue through the unauthenticated
generic `404` server and do not send an authentication challenge. The status
projection is read-only and contains only IDs with `online`, `offline`,
`insecure`, or `missing`; it excludes origins, socket paths, tokens, hostnames,
and probe details. `hub status` refreshes it from the same protected-route
`401` check; the installed health timer does so at least every five minutes.

The legacy edge cron runs at `03:17` with webroot renewal. The Hub cron is
`/etc/cron.d/dsh-remote-hub-cert-renew`, runs daily at `03:23` VPS time, and uses
DNS-01 with the single `certbot/dns-cloudflare@sha256:...` image identity shown
by `hub status`. The mode-0600 Cloudflare file is mounted read-only and its value
must never appear in output. Run `hub renewal-check` after deployment and after
an approved image digest update; it performs a dry run, validates SANs and
remaining validity, then validates and reloads Nginx.

`dsh-remote-hub-health.timer` runs every five minutes. Its service verifies
Nginx, certificate validity, every registered socket, and the protected-route
`401`. `OnFailure` invokes `dsh-remote-hub-alert.service`, which writes the
mode-0600 persistent alarm at
`/home/chriswang/.local/state/dsh-remote-hub/health-alarm`, records a journal
error, and delivers an immediate `wall` message to logged-in operator terminals.
Operators who were offline check `systemctl --failed`, the alarm file metadata,
and `journalctl -u dsh-remote-hub-health.service`; no Tencent account-side alarm
is claimed until one is separately configured. During acceptance, keep an SSH
TTY open, inject one synthetic failure, observe the wall message, clear the
condition, and confirm the next run succeeds, then run
`dsh-remote-edge hub acknowledge-alert`. Acknowledgement is rejected unless the
Hub and every registered instance are currently healthy; while an alarm remains,
`hub status` reports configured rather than ready. `/etc/logrotate.d/dsh-remote-hub`
caps the health and renewal logs at 14 compressed daily files with a 1 MiB
rotation threshold; do not redirect these checks to an unbounded plaintext log.

The VPS sshd applies its server-side stream-local mask (`0177`) to remote socket
creation, so client `StreamLocalBindMask` does not produce the required group
mode. The plugin therefore removes only its dedicated stale socket before bind,
starts forwarding, then runs a fixed `chmod 0660` over a second strict SSH
command. Tunnel status becomes online only after that command succeeds. The
setgid socket directory supplies the managed group inherited by the socket.

Docker Compose `group_add` applies to the container entry process, but Nginx
workers call `initgroups` when dropping from root to the `nginx` user. The
managed executable in `/docker-entrypoint.d` therefore resolves the mounted
socket directory GID inside the container and adds `nginx` to that group before
Nginx starts. Deployment fails and rolls back if this membership is not
observable after container recreation.

The scripts never change unrelated server blocks, containers, certificate names,
DNS records, or firewall rules. DNS creation and local DSH profile installation
are separate, independently reversible delivery actions.
