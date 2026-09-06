# x570 DSH compatibility check

This manually triggered runner tests the latest published DSH against the
current `dsh-remote` `main` commit without using the VPS, public DNS, or the
production DSH instance. Install `check-latest.sh` and `probe.mjs` under a
private directory on x570, then expose the runner as `dsh-compat-check`.

Run the default latest-version check with:

```sh
~/.local/bin/dsh-compat-check
```

The runner uses only `127.0.0.1:3380` and `127.0.0.1:30321` and refuses to
overlap the production ports. Declared peer ranges are recorded as diagnostic
evidence but never block installation or runtime tests. Compatibility is based
on the observed install, startup, HTTP, WebSocket, late-reset, and
production-isolation results under
`~/.local/state/dsh-compat/runs/`.

Set `DSH_COMPAT_DSH_SPEC=<version>` only to reproduce a historical result. The
default is the latest npm release. Temporary runtimes are removed at exit; the
versioned reports and logs remain available through the `latest` symlink.
