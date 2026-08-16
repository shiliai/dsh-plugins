# DSH Remote Socket Permission Addendum

Subject: correction to the approved 2026-08-16 design after live VPS preflight.
Baseline: `remote-v1` (unchanged).

## Evidence

OpenSSH remote stream-local forwarding through `vps-tencent-tokyo` reached the
local DSH and returned HTTP 200. The created socket was mode `0600`, not the
designed `0660`. The VPS reports `streamlocalbindmask 0177` and
`streamlocalbindunlink no`. A second same-path forwarding attempt failed while
the stale socket existed. Both test sockets and SSH processes were removed.

## Correction

The plugin no longer relies on client `StreamLocalBindMask` or
`StreamLocalBindUnlink` for remote behavior. Before each bind it runs a fixed,
non-interactive SSH command to remove only the configured dedicated socket path.
After the forwarding child survives its stability window it runs a second fixed
SSH command to set that socket to mode `0660`. The parent directory remains
setgid and group-owned by the dedicated group, so the socket inherits the group
used by the Nginx container. Status changes to online only after chmod succeeds;
failure terminates the forwarding child before bounded retry.

The socket path and SSH target retain strict runtime validation, commands use
argument arrays with no local shell, and multiple simultaneous local DSH
instances remain outside the approved first-release scope. No sshd configuration
or public listener is changed.

## Alignment

This correction restores the transport required by `US-R1` and the reachable
edge/offline behavior required by `US-R3`. It does not change user roles, goals,
values, workflows, observable results, constraints, or non-goals. Drift score: 0.

