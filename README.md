# DSH Remote

`@dsh-plugins/dsh-remote` exposes a currently running loopback DSH Web profile
through an SSH Unix-socket reverse tunnel. It stores its persistent private-link
secret locally, exchanges fragments for hardened cookies, and authenticates every
proxied HTTP request and WebSocket upgrade.

## Install

The package targets DSH `0.1.0-rc.6` exactly. Add the packed archive or published
package to the DSH Web profile, then use the supplied `cordis.patch.yml` entry.
The patch reads these nonsecret test and deployment overrides at runtime:

```sh
DSH_REMOTE_ORIGIN=https://zsh.onlyservice.io
DSH_REMOTE_SSH_TARGET=vps-tencent-tokyo
DSH_REMOTE_STATE_FILE=/absolute/local/path/state.json
```

The token is never configured through Cordis, environment variables, or DSH
dump-config. It is generated in the mode-0600 local state file. DSH and the
gateway must both bind to `127.0.0.1`; the plugin rejects any public bind.

The default reverse-forward target is
`/home/chriswang/.local/share/dsh-remote/tunnel.sock`, matching the edge socket
directory. The supervisor permits only a safe SSH alias or `user@host` target,
uses strict host-key checks, removes the dedicated stale socket before binding,
and keeps a new child in `starting` until a fixed remote `chmod 0660` succeeds.
If permission preparation fails, it terminates that tunnel before bounded retry.

## Private Link

The sidebar footer opens remote status, copies the persistent private URL, and
confirms rotation. The URL keeps its 256-bit bearer token in the fragment. The
gateway exchanges that fragment for a secure, HTTP-only session cookie, removes
the fragment from browser history, and verifies the cookie on every HTTP request
and WebSocket upgrade. Rotation atomically changes the persistent token and
closes earlier authenticated WebSockets before reporting success.

## Edge Operations

The packaged `dsh-remote-edge` command ships the setup assets and invokes only
the managed VPS edge operations:

```sh
dsh-remote-edge preflight
dsh-remote-edge apply
dsh-remote-edge status
dsh-remote-edge rollback --receipt <receipt-id>
```

`preflight` is read-only. `apply` is backup-first and stops before reload on a
failed validation. `status` distinguishes configured from ready, and `rollback`
restores the receipt's exact Nginx and Compose backups. See
[`docs/operations/vps-edge.md`](docs/operations/vps-edge.md) for the managed
scope, socket permissions, and recovery details.

## Recovery

For a local failure, remove the plugin from the DSH Web profile and restart DSH;
the state file can remain in place to preserve the current private link. For an
edge failure, use the matching rollback receipt. No operation changes unrelated
sites, containers, certificates, DNS records, firewall rules, or DSH data.
