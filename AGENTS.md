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
- Preserve the late socket-error protections introduced by commit `d9022d1`
  in every `dsh-remote` release.

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
- Run the changed plugin's `release:check` before tagging it.
- Run `pnpm check && pnpm pack:check` when shared packaging or update behavior
  changes. Do not publish to npm unless a separate approved release plan says
  to do so.
