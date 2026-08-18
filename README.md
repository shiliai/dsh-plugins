# DSH Plugins

Monorepo for independently versioned DeepSeek Harness plugins.

## Layout

```text
plugins/
  dsh-obsidian/
  dsh-remote/
tools/
  dsh-explainer/
```

Each directory under `plugins/` is an independently packaged plugin with its
own package name, version, tests, documentation, and release checks. Dependency
installation and routine verification run from the repository root.

## Commands

```sh
pnpm install
pnpm check
pnpm pack:check
pnpm versions:check
```

Run one plugin command with a workspace filter:

```sh
pnpm --filter @dsh-plugins/dsh-remote check
pnpm --filter @dsh-plugins/dsh-obsidian pack:check
```

The static architecture explainer is development material, not a DSH plugin.
Run it with `node tools/dsh-explainer/server.mjs`.

## Install from GitHub

Install from the public GitHub monorepo so dsh can track the remote source. Git
dependencies run each plugin's `prepare` script, so first trust this repository
for the two package identities. This stable repository rule continues to match
new commits. If the profile already has `allowBuilds` entries, include them in
the JSON instead of replacing them.

```sh
dsh plugin --profile web config set --location=project --json allowBuilds \
  '{"@dsh-plugins/dsh-obsidian@git+https://github.com/shiliai/dsh-plugins.git":true,"@dsh-plugins/dsh-obsidian@git+ssh://git@github.com/shiliai/dsh-plugins.git":true,"@dsh-plugins/dsh-remote@git+https://github.com/shiliai/dsh-plugins.git":true,"@dsh-plugins/dsh-remote@git+ssh://git@github.com/shiliai/dsh-plugins.git":true}'
dsh plugin --profile web add \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-obsidian'
dsh plugin --profile web add \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-remote'
```

The same commands migrate an existing local path, `link:`, or tarball
installation to its GitHub source. dsh resolves the package's real name and
keeps the existing bundle entry during reconciliation.

The updater is fetched directly from the same public repository. Run it through
dsh to check installed SemVer values and update all installed supported plugins:

```sh
dsh plugin --profile web --config.dlx-cache-max-age=0 dlx \
  'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' check
dsh plugin --profile web --config.dlx-cache-max-age=0 dlx \
  'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' update
```

Append one or both package names to limit the operation. The update command
also performs the one-time migration for an installed local path, `link:`, or
tarball source, and merges repository build trust with existing `allowBuilds`.

Restart the affected DSH profile after an update.

## History

The monorepo was assembled from the original `dsh-remote` and `dsh-obsidian`
repositories using non-squashed subtree imports. Their original tips are tagged
as `archive/dsh-remote-main` and `archive/dsh-obsidian-main`.
