# VPS Edge Operations

The edge command targets `vps-tencent-tokyo` and `zsh.onlyservice.io` by default.
It copies versioned helper assets into a mode-0700 temporary directory, invokes
the remote helper through passwordless sudo, and removes the staging directory.

```sh
node scripts/dsh-remote-edge.mjs preflight
node scripts/dsh-remote-edge.mjs apply
node scripts/dsh-remote-edge.mjs status
node scripts/dsh-remote-edge.mjs rollback --receipt <receipt-id>
```

`preflight` is read-only. It requires the domain A record to resolve to
`43.167.173.46`, validates the existing Compose model and live Nginx config, and
reports pre-state hashes.

`apply` creates a receipt and exact Nginx/Compose backups before mutation. It
creates the dedicated socket group and mode-2770 host directory, adds only the
managed socket/offline mounts and supplementary group to the Nginx service,
installs the marked HTTP ACME site, recreates and validates Nginx, obtains the
certificate through the existing Certbot volumes, then installs and activates
the marked HTTPS site. Any failed step invokes automatic restoration from the
same receipt.

The Nginx config is a single-file Docker bind mount. Atomic replacement changes
the host inode, so both the HTTP staging write and final HTTPS write recreate the
Nginx container before validation. A reload alone would keep the stale mounted
inode and is intentionally not used.

Receipts are stored under
`/home/chriswang/.local/state/dsh-remote/backups/<receipt-id>/receipt.json` with
mode 0600. They contain pre/post file hashes and no access credential. `rollback`
restores the exact files, validates Compose, recreates Nginx, validates the live
configuration, and removes a group created by the failed or reverted apply only
when its socket directory is empty. A live or stale socket blocks rollback before
any restore write; stop the local DSH tunnel first. Repeating rollback is a no-op.

`status` distinguishes `configured` from `ready`. Configured means DNS-independent
edge files, certificate, mounts, directory, Nginx validation, and verified
membership of the Nginx user in the socket GID are present. Ready additionally
requires the reverse-tunnel socket to exist.

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
