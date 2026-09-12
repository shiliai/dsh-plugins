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
