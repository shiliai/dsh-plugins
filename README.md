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
```

Run one plugin command with a workspace filter:

```sh
pnpm --filter @dsh-plugins/dsh-remote check
pnpm --filter @dsh-plugins/dsh-obsidian pack:check
```

The static architecture explainer is development material, not a DSH plugin.
Run it with `node tools/dsh-explainer/server.mjs`.

## History

The monorepo was assembled from the original `dsh-remote` and `dsh-obsidian`
repositories using non-squashed subtree imports. Their original tips are tagged
as `archive/dsh-remote-main` and `archive/dsh-obsidian-main`.
