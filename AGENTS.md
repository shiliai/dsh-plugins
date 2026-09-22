# DSH Plugins Repository Instructions

## DSH restart safety

- Never kill, restart, or replace a DSH host process from a tool call running
  inside that same process. The Harness records `tool/call` before execution,
  so terminating the host prevents the matching `tool/result` from being
  persisted and causes `TOOL_OUTCOME_UNKNOWN` during session recovery.
- Perform DSH restarts through an external supervisor or a separate terminal
  that is not hosted by the process being replaced.
- Split deployment into two phases: finish the deployment command and durably
  record its result, then restart DSH externally. Verify health and session
  recovery in a new request after the replacement process is listening.
- A racing flush from a replaced host can corrupt the session journal beyond
  any repair. In the Sep 12 `DSH_READING_*` incident (session `844215ba`), the
  old process flushed buffered turn-11 events after the replacement host had
  already written its interrupted-turn closer and started turn 12, interleaving
  records with duplicate and decreasing `seq` values mid-file. The loader then
  rejects the whole session (`corrupt session log: seq gap in committed
  region`), and built-in recovery only synthesizes closers for an open tail
  turn — it cannot reorder a committed region. The conversation became
  permanently unresumable after DSH itself was fixed and restarted.
- Treat the session journal as single-writer append-only. Before starting a
  replacement host against the same `$DSH_HOME`, confirm the old process and
  its listening port are fully gone; two live writers guarantee the
  corruption above.
- Never hand-edit a journal
  (`$DSH_HOME/sessions/<encoded-cwd>/session-*/session.jsonl.zstd`) to "fix"
  corruption by renumbering `seq` fields. Loadability requires each decoded
  event's seq to equal its position from 0, packed `*-chunks` rows to keep
  their `seq0` bases, and turn/step records to stay ordered — the renumber
  attempts on `844215ba` (`.bad-repair`, `.tmp-invalid`, `.pre-attempt`,
  `.bad2`) all failed while destroying evidence. Instead: stop, copy the file
  aside with a timestamp, inspect it read-only (`zstdcat`), salvage needed
  content into a fresh session, and preserve the original.
- Preserve the late socket-error protections introduced by commit `d9022d1`
  in every `dsh-remote` release.
- Sep 20 incident: the same committed-region corruption recurred (sessions
  `96660b98`, `d072a228`) with nobody performing a "restart". This machine
  was running TWO web hosts (a `:3080` GUI host and the `:3280` service) on
  ONE `$DSH_HOME` — a topology a session had explicitly cleared as "normal,
  no double-write risk" hours earlier. It is not: ports differ, the journal
  directory is shared, so both hosts are live writers; when the user
  re-submitted one message, both hosts ran the same turn and interleaved
  `seq`s. A concurrent dsh-cron crash loop (`RangeError: Invalid time value`
  from a `-Infinity` cron cursor; fixed in `aa96568`) plus the launchd
  `KeepAlive` respawn widened the overlap. Lessons: **two DSH hosts on one
  `$DSH_HOME` are two writers no matter how many ports they listen on** —
  the only safe multi-host setup is one `$DSH_HOME` per host; a plugin must
  never be able to take the host down from a scheduler tick (dsh-cron now
  contains per-job errors); after such a fix lands on disk, the running
  host still executes the old module until restarted — verify fatals have
  stopped in the host's stderr log.

## Local environments

- Both the production environment and the test environment live on this
  machine: all DSH hosts are reached at `127.0.0.1`, distinguished only by
  port and `$DSH_HOME`. Never treat a port/host pair on this machine as a
  remote target, and never run a second web host against an in-use
  `$DSH_HOME` (see the Sep 20 incident above).
- Production: port `3280`, `$DSH_HOME=~/.local/dsh_home`, launchd service
  `io.shiliai.dsh-remote-mac` (KeepAlive). Restarted only via
  `scripts/prod-restart.sh` (from the test side or an external terminal) or
  the request channel below.
- Test: port `5280`, `$DSH_HOME=~/.local/dsh-home-dev`, launchd service
  `io.shiliai.dsh-dev-5280` (installed by `scripts/dev-service.sh install`).
  The test environment stays resident at all times; it must be available to
  accept dispatch from production at any moment. If it is down, bring it
  back immediately (`scripts/dev-service.sh status` / `restart`).
- Mutual cover — each environment may restart the other, never itself:
  - test → prod, interactive: from a 5280 session or an external terminal,
    `DSH_WEB_SERVICE_LABEL=io.shiliai.dsh-remote-mac scripts/prod-restart.sh`.
  - test → prod, unattended (the only restart a PRODUCTION session may
    initiate): `scripts/prod-restart-request.sh "reason"` files a durable
    request and returns; the test-side watcher
    (`io.shiliai.dsh-dev-restart-watch`, 60s poll) executes prod-restart.sh
    with full guards. After production is back, read
    `~/.local/state/dsh-dev-workflow/last-result.json`. Requests older than
    10 minutes are dropped, never replayed.
  - prod → test: from a production session, `scripts/dev-service.sh restart`
    (kickstart of `io.shiliai.dsh-dev-5280`; the tool result persists on the
    surviving production host). The test env is disposable; its sessions and
    cron jobs do not survive a `dev-sandbox.sh` reassembly.
- Waking a session after a restart (test → prod, verified 2026-09-22): a
  restart interrupts the in-flight turn and the GUI session waits for someone
  to re-issue it. The resident test host can resume it unattended:
  1. BEFORE the restart, mint a browser-session cookie on the target host:
     `curl -s -c <jar> -o /dev/null "http://127.0.0.1:3280/?token=<launch-token>"`
     (the launch token is in the host's stdout log). The signed cookie stays
     valid across restarts — its HMAC secret is durable in
     `.credentials.yaml`, and only the per-process launch token rotates.
  2. On the test host, arm a dsh-cron oneshot command job that runs
     `scripts/wake-session.sh --base http://127.0.0.1:3280 --cookie-jar <jar>
     --session-id session-… --message "…"` — it polls until the port is back,
     then POSTs `/api/session/prompt` with `{args: {request: {…, mode:
     'queue'}}}`; the RPC itself resumes the session and queues the message
     as the next turn. Wire format notes: the endpoint lives in the URL path
     (`/api/session/prompt`), the envelope is `{type:'client-request',
     rpcId, method, payload}`, and typert wants the payload wrapped as
     `{args: {<method-args>}}` with the call's single parameter named
     (`request` for session/prompt).
  The interrupted turn is never replayed — put the continuation context in
  the wake message.

## Local development workflow: dev sandbox (5280) + launchd production (3280)

The standard local loop (issue #112; design approved 2026-09-20). Production
runs under launchd on :3280 and is never restarted from inside a session it
hosts; all development and e2e validation happens on a disposable dev sandbox
on :5280. This is the operational answer to the restart-safety rules above —
the sandbox absorbs every cold boot.

- Boot the sandbox with `scripts/dev-sandbox.sh --plugin <name> [--plugin ...]`.
  It clones the production profile (APFS copy-on-write) into an isolated
  `$DSH_DEV_HOME` (default `~/.local/dsh-home-dev`, never the production
  `DSH_HOME`), trims the bundle list to base + web + the target plugins, and
  injects the dev overlay (hmr root -> worktree `lib`, installed copy disabled,
  worktree build inserted with `config: {}`). It resolves the dsh binary from
  the *running production host* so dev/prod run the same dsh version (if the
  production host is unreachable it falls back to the newest dsh-cli release
  and says so — version parity is then not guaranteed). The home/port guards
  are normalized-path strict: attempts to point the sandbox at the production
  home (trailing-slash or `/.` spellings included), an empty home, `/`, `$HOME`
  itself, or the production port are refused before anything is deleted — while
  an ordinary path under `$HOME` (the default) is accepted (over-broad
  `$HOME/*` rejection was a shipped regression, fixed in #114).
- Make the sandbox resident with `scripts/dev-service.sh install` (launchd
  `io.shiliai.dsh-dev-5280`, KeepAlive): it takes the port over from the ad-hoc
  boot and also installs the restart watcher
  (`io.shiliai.dsh-dev-restart-watch`, see "Local environments"). While the
  service exists, re-running `dev-sandbox.sh` bootouts the service before
  reassembling the home and re-bootstraps it afterwards — the home is never
  deleted out from under a live KeepAlive process.
- Inner loop: edit src -> `DSH_DEV_HOT_LOOP=1 pnpm build` -> the sandbox
  hot-reloads in ~1–2s (same PID); refresh the browser. Re-run `dev-sandbox.sh`
  only when the overlay ingredients change (adding a plugin, changing config).
  Note the sandbox home is rebuilt from scratch each run; credentials and the
  root `.env` are NOT copied.
- Validate with `scripts/e2e-probe.sh --base http://127.0.0.1:5280` plus the
  plugin's own `release:check`. Both must be green before shipping.
- Ship: merge -> updater install
  (`dsh plugin --profile web --config.dlx-cache-max-age=0 dlx 'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' update <pkg>`)
  -> restart production from a session that is NOT hosted by the production
  host (a sandbox session or an external terminal):
  `DSH_WEB_SERVICE_LABEL=<label> scripts/prod-restart.sh`. The label must be
  the service that already owns :3280 (`launchctl list | grep -i dsh`; on the
  reference machine it is `io.shiliai.dsh-remote-mac`). The script verifies
  before the restart that the port listener IS the service pid (and refuses
  otherwise), runs `launchctl kickstart -k` (launchd stops the old process and
  releases :3280 before starting the replacement — the single-writer guarantee
  manual restarts have failed to provide), health-checks the port, re-verifies
  the listener is the new service pid, and optionally posts a WeCom notice with
  the new token URL. Install/migrate the service with
  `scripts/dsh-web.plist.template` (header documents the migration from an
  existing label; never bootstrap a second service onto the same port).
- After a clean restart, production sessions resume from the disk journal; any
  turn that was in flight on the old host is interrupted and must be re-issued.
  Never run two hosts against one `DSH_HOME`. The prod-restart preflight and
  post-check enforce port ownership; for any manual intervention,
  `lsof -iTCP:3280 -sTCP:LISTEN` before and after is the ground truth.

## Local plugin hot-iteration workflow (no host restart)

The mechanism that powers the 5280 sandbox above, spelled out. Verified
end-to-end on DSH 0.1.3-alpha.1 (see issue #110 for the full recipe, evidence,
and pitfalls); the sandbox flow was re-verified on 0.1.2-rc.1 (issue #112).
The host process never exits during the inner loop, so the restart-safety
rules above are not triggered and the session journal keeps its single writer.

- Load the dev copy through a patch overlay instead of installing it. In
  `$DSH_HOME/cordis.patch.yml` (watched live by the web profile's default
  `patchReload: "live"`): enable the bundle's `hmr` entry
  (`- id: hmr, disabled: false, config: { root: [<workspace>/lib] }`), disable
  the installed copy (`- id: <short-name>, disabled: true`), and insert the
  workspace build (`- insert: [{ name: <relative path to lib/index.js> }]` —
  relative names resolve against the patch file's directory). Do not symlink
  or link the workspace into `node_modules`.
- Build with the hot loop: `DSH_DEV_HOT_LOOP=1 pnpm build`. The build MUST NOT
  delete the output directory (`clean: false`): tsdown's default `clean: true`
  replaces the `lib` directory inode, which silently kills the host's file
  watcher — manual writes then reload fine but builds never do. The flag is
  implemented in dsh-reading's `tsdown.config.ts`; copy the pattern to other
  plugins before relying on it there.
- After a rebuild the server-side plugin remounts with the new code in ~1–2s
  (cordis-plugin-hmr clears the ESM + CJS module caches); the client bundle is
  re-hashed by `dsh-client-hmr` (500ms poll) and the new rev is injected into
  the served index. Refresh the browser page to pick up client changes.
- Know the boundaries:
  - Editing the overlay itself (adding/removing the dev insert, changing its
    config) has a known defect: the entry remounts but with the stale composed
    config. On 0.1.2-rc.1 a live structural edit (insert/disable) was observed
    to fail transactionally and roll back entirely — never count on applying
    an overlay to a running host. Restart the dev instance (an isolated
    sandbox on another port — cheap, and never the real host) after overlay
    changes; `dev-sandbox.sh` does exactly that.
  - A dev overlay is development-only. Production installs must always go
    through `dsh plugin dlx` into `DSH_HOME`; remove the overlay and verify
    the installed copy serves before releasing.
  - Diagnostics are silent: cordis logger output and PENDING fibers produce
    nothing on stdout without a console exporter. To observe reloads, insert a
    temporary diagnostic plugin that writes to a file, and check behavior over
    HTTP rather than logs.
  - Do not put the dev sandbox home under `/private/tmp` on macOS: FSEvents
    does not report sandboxed writes there and every watch appears dead.
    Real paths under the home directory work.
- Restarting a dev sandbox is not restarting DSH: it is a separate process on
  its own `$DSH_HOME` and port, safe to start and stop from inside a session.

## Config changes must not break the next boot

Past incidents share one shape: edit a DSH config surface, restart DSH, and the
host fails to boot. Boot validation is fail-loud and only runs at process
start, so treat every config edit as something that can block the restart.

- Never write `DSH_`-prefixed variables into any `.env` file.
  `@deepseek-ai/dsh-app-boot` rejects names starting with `DSH_`, `XDG_`,
  `DYLD_`, or `BASH_FUNC_`, plus bootstrap-only names (`HTTP_PROXY`,
  `NODE_TLS_REJECT_UNAUTHORIZED`, `DEEPSEEK_BASE_URL`, `EDITOR`, ...). Both the
  invoking directory's `.env` and `$DSH_HOME/.env` are checked, and a violation
  throws before the profile loads, so the host cannot start at all. Plugin
  deployment config uses a plugin-owned prefix (`READING_*`, `WECOM_*`);
  secrets go to `$DSH_HOME/.credentials.yaml` `refs:`, never `.env`.
  Resolution order: process env > credentials refs > `$DSH_HOME/.env`.
  (Incident: dsh-reading first shipped `DSH_READING_*` names; fixed in
  `978411f`.)
- Keep renamed config keys backward compatible during migration: readers take
  the new name with the old name as fallback
  (`READING_DATA_DIR ?? DSH_READING_DATA_DIR` from `978411f`) so an existing
  profile still boots while its env file is migrated. Migrate the live file
  and the reading code in the same change window.
- Know what each pre-flight actually validates. `dsh web --dump-config`
  composes and validates the config tree but never loads the `.env` layers, so
  it cannot catch reserved-name or malformed `.env` entries — a green dump does
  not prove the next boot succeeds. To pre-flight env changes, boot a sandbox:
  copy the config to a temp `DSH_HOME` and run the real entry
  (`node .../@deepseek-ai/dsh/lib/bin.js web`) on a free port. The local
  launcher shim hard-exports `DSH_HOME`, so `DSH_HOME=<tmp> dsh ...` silently
  targets the real home — bypass the shim when sandboxing.
- Back up every live config file before touching it, timestamped beside it:
  `$DSH_HOME/.env.bak-<YYYYMMDD-HHMMSS>`, `.credentials.yaml.bak-*`, and
  `settings.yaml.bak-*` are the established convention. A bootable rollback
  copy is the fastest recovery when a restart fails. On failure the boot error
  names the offending file and variable — read it before editing further.
- Credential and config file formats are coupled to the installed DSH version.
  Write the format the running DSH expects (the rc.8 credential mapping),
  atomically, mode `600`, honoring the shared writer lock; migrate legacy
  wrappers immediately with a `.bak` instead of leaving mixed state across a
  restart (`c804ac7`, `ba009a7`).
- Never stack unverified changes across one restart. Apply config edits,
  verify the new state boots, then restart externally as described above. The
  bootstrap updater resolves and verifies DSH first and only then touches
  plugins (`784682f`); keep that ordering for manual config surgery too.

## Plugin versions

- Every directory under `plugins/` is an independently versioned package. Its
  `package.json` version is the authoritative plugin version and must be strict
  SemVer.
- Bump only plugins whose shipped behavior or packaging changed. Use patch for
  compatible fixes, minor for compatible features, and major for incompatible
  changes. Never reuse a released version.
- Keep `repository.url` set to `git+https://github.com/shiliai/dsh-plugins.git`
  and `repository.directory` set to the package's monorepo directory.
- GitHub-source packages must keep a `prepare` script that produces all files
  declared by `main`, `types`, `exports`, and `bin`.
- Release tags are plugin-scoped: `dsh-obsidian-v<version>`,
  `dsh-remote-v<version>`, and `dsh-wecom-v<version>`. Create a tag only after
  the package release check and root version check pass.

## Install and update contract

- Public installs use pnpm's GitHub monorepo subdirectory source:
  `github:shiliai/dsh-plugins#path:/plugins/<plugin>`.
- Build trust must cover both pnpm Git source normalizations for this shorthand:
  `git+https://github.com/shiliai/dsh-plugins.git` and
  `git+ssh://git@github.com/shiliai/dsh-plugins.git`.
- Run the repository updater through
  `dsh plugin --profile <profile> --config.dlx-cache-max-age=0 dlx` for both
  update checks and automatic updates. The zero cache age makes pnpm resolve
  the updater's current Git revision on every run. Plain pnpm `outdated` does
  not detect a newer commit for a Git dependency.
- Plain pnpm cannot discover GitHub updates for a local path, `link:`, or
  tarball installation. The repository updater must compare its installed
  SemVer and perform the one-time GitHub source migration.
- Do not edit a user's DSH profile manifest or lockfile directly. Installation
  and update operations must go through `dsh plugin` so bundle reconciliation
  remains authoritative.

## Verification

- Run `pnpm versions:check` after changing package versions, source metadata,
  release instructions, or update commands.
- Run `pnpm update:smoke` after changing updater behavior.
- After changing any DSH config surface (`.env` contracts, credentials format,
  settings layers), pre-flight the boot path in a sandbox home — including the
  `.env` layers, which `dsh web --dump-config` does not check — before
  restarting DSH.
- Run the changed plugin's `release:check` before tagging it.
- Run `pnpm check && pnpm pack:check` when shared packaging or update behavior
  changes. Do not publish to npm unless a separate approved release plan says
  to do so.
