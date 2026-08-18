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
DSH_REMOTE_INITIAL_TOKEN=<43-character-base64url-token>
```

For a registered multi-instance Hub node, set the instance identity and SSH
target. The plugin derives an isolated origin, socket, and state path while the
legacy single-instance defaults remain unchanged:

```sh
DSH_REMOTE_INSTANCE_ID=x570
DSH_REMOTE_BASE_DOMAIN=dsh.onlyservice.io
DSH_REMOTE_SSH_TARGET=vps-tencent-tokyo
```

`DSH_REMOTE_INITIAL_TOKEN` is optional and is read only when the mode-0600 state
file does not exist. It must be exactly 32 random bytes encoded as unpadded
base64url (43 characters). Existing state always wins, so changing or removing
the environment value cannot replace a live token or undo a rotation. Keep the
value out of Cordis configuration and DSH `dump-config` output. DSH and the
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
and WebSocket upgrade. Authenticated browser requests and upgrades must carry the
exact configured public Origin; state-changing requests without Origin are denied.
Rotation is serialized and the atomic state-file rename is its commit point. A
failure before rename preserves the old link; a failure after rename reports the
already committed replacement. Successful rotation closes earlier authenticated
WebSockets before reporting success.

## Edge Operations

The packaged `dsh-remote-edge` command ships the setup assets and invokes only
the managed VPS edge operations:

```sh
dsh-remote-edge preflight
dsh-remote-edge apply
dsh-remote-edge status
dsh-remote-edge renewal-check
dsh-remote-edge rollback --receipt <receipt-id>
```

The optional multi-instance Hub is initialized once and then changed through an
allowlisted registry. Registration rewrites only the generated route file,
validates Nginx, and reloads atomically; it does not add another Compose mount or
certificate:

```sh
dsh-remote-edge hub preflight
dsh-remote-edge hub apply
dsh-remote-edge hub status
dsh-remote-edge hub acknowledge-alert
dsh-remote-edge instance add x570
dsh-remote-edge instance status x570
dsh-remote-edge instance remove x570
dsh-remote-edge instance rollback --receipt <transaction-id>
dsh-remote-edge hub renewal-check
dsh-remote-edge hub rollback --receipt <deployment-receipt-id>
```

After DSH is installed on a node, install the packed bundle and its persistent
user service with the same node-side command used by x570:

```sh
dsh-remote-install-node ./dsh-plugins-dsh-remote-0.1.0.tgz x570
```

The installer keeps the tarball by SHA-256, backs up the Web profile and any
existing instance unit, and writes `dsh-remote-<instance>.service`. It requires
the user's systemd manager to have lingering enabled; use the explicit
`--enable-linger` final argument only when authorizing that host lifecycle
change. The service derives the independent origin, socket, token state, and
local state file from the instance ID. Register the same ID on the Hub only
after the node service is ready.

Each installed instance unit optionally reads a private host file at
`~/.config/dsh-remote/<instance-id>.env`. To choose the first private link
without inspecting the state over an SSH tunnel, create it with mode `0600`
before the first service start:

```sh
DSH_REMOTE_INITIAL_TOKEN=<43-character-base64url-token>
```

The file is not modified by installation or token rotation. Once state exists,
the configured initial value is ignored.

`install-dsh-node.sh` manages DSH itself with immutable `releases/` and
`configs/` generations. A validated install atomically switches `current`
links and prints its receipt ID. Reverse the newest install with
`install-dsh-node.sh --rollback <receipt-id>`; this restores the prior launcher,
configuration files/pointer, modes, and hashes without touching sessions, workspaces,
or legacy `~/.dsh`.

`preflight` is read-only. `apply` is backup-first and stops before activation on a
failed validation. Nginx streams request and response bodies without proxy
buffering. Hub `status` verifies one registry/routes generation and reports each
node as `online`, `offline`, `insecure`, or `missing`; `online` requires a real
protected-route response, not just a connectable socket. Certificate automation
uses the digest-pinned `certbot/dns-cloudflare` image. `renewal-check` exercises
Certbot's dry run and certificate checks, and `rollback` restores the v2
receipt's exact managed files and metadata. An unacknowledged health alarm keeps
the Hub out of `ready`; `hub acknowledge-alert` succeeds only after every
registered node is healthy. See
[`docs/operations/vps-edge.md`](docs/operations/vps-edge.md) for the managed
scope, socket permissions, and recovery details.

## Recovery

For a local failure, remove the plugin from the DSH Web profile and restart DSH;
the state file can remain in place to preserve the current private link. For an
edge failure, use the matching rollback receipt. No operation changes unrelated
sites, containers, certificates, DNS records, firewall rules, or DSH data.
