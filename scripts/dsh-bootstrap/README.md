# dsh-bootstrap

Guided, idiot-proof, idempotent setup for DeepSeek Harness across many machines
(macOS / Linux / Windows — Windows is designed-for but not yet verified in DSH).

Solves the "after installing DSH I have to re-copy my model config and re-install
plugins on every machine" problem in one runnable command.

## Quick start

```sh
# from a clone of this repo
node scripts/dsh-bootstrap/bootstrap.mjs

# or a one-liner (pull a fresh copy into your cache)
curl -fsSL https://raw.githubusercontent.com/shiliai/dsh-plugins/main/scripts/dsh-bootstrap/setup.sh | sh
```

PowerShell (Windows):

```powershell
. .\scripts\dsh-bootstrap\setup.ps1
```

It is safe to run repeatedly — every step detects what is already done and skips it.

## What it does

1. **ensure-dsh** — installs the DSH CLI (`@deepseek-ai/dsh` via npm) only if `dsh` is missing.
2. **settings** — symlinks a portable `settings.yaml` into `$DSH_HOME`, so your custom model
   config stays single-source and syncs automatically on the next `git pull`. Your curated
   part lives under `llm-pi-ai.providers`: `contextWindow` (context size),
   `input: [text, image]` (multimodal), and `reasoningEfforts` (thinking effort).
3. **credentials** — detects every `apiKeyEnv:` referenced by `settings.yaml`, prompts once
   per machine for the key (or reads it from an environment variable / `env:VAR`), and writes
   `$DSH_HOME/.credentials.yaml` with mode `600`. This file is **never committed**.
4. **plugins** — shows required plugins (auto-installed, e.g. `dsh-better-sidebar`) and lets
   you multi-select optional ones (Obsidian, remote, WeCom, file-attachment), installing via
   `dsh plugin` with the needed GitHub build-trust.
5. **update** (`sync` offers it; `update` runs it directly) — updates DSH itself, the
   repo-sourced plugins (via the repository updater) and npm-sourced plugins.

## Commands / options

```
node bootstrap.mjs [command] [options]

commands:
  sync        (default) guided setup & optional update
  check       dry-run — print the plan, change nothing
  update      update DSH, repo plugins and npm plugins

options:
  --profile <name>     target profile (default: config "profile", usually "web")
  --config <path>      plugin/manifest config JSON (default: ./bootstrap.config.json)
  --settings <path>    portable settings.yaml to symlink (default: ./settings.yaml)
  --plugins <ids>      comma-separated plugin ids to install (others stay unselected)
  --rekey              force re-prompt for credential values
  --yes                non-interactive: accept each prompt's default; install all optionals
  --skip-dsh           skip DSH install check
  --skip-settings      skip settings symlink
  --skip-credentials   skip credentials
  --skip-plugins       skip plugins
  -h, --help           show help
```

## Making it yours

- **Model config**: edit `settings.yaml` here (or point `--settings` at your real file).
  Add/replace `llm-pi-ai.providers` with your custom models. The `bootstrap.config.json`
  `settingsSource` controls the default path.
- **Plugins**: edit `bootstrap.config.json` → `plugins[]`. Each entry has:
  - `id` (unique), `name` (label),
  - `sourceType`: `github` (from `shiliai/dsh-plugins`) or `npm`,
  - `spec`: the install spec (`github:shiliai/dsh-plugins#path:/plugins/<name>` or a npm spec),
  - `package`: the resolved package name (used to detect already-installed),
  - `required`: `true` = always install, `false` = optional choice.

## What is intentionally NOT synced

- `$DSH_HOME/.credentials.yaml` — secrets, written per machine.
- `$DSH_HOME/profiles/<name>/cordis.patch.yml` — machine-local per-profile config (vault
  paths, bot secrets via env, allowed paths), by DSH design.

## Notes

- `DSH_HOME` defaults to `~/.dsh` on every platform via `homedir()`; override with the
  `DSH_HOME` environment variable.
- Windows: the script is platform-agnostic and the PS launcher is provided, but DSH's own
  platform support is designed-for, not fully verified — review each step on Windows.
- Node `>=22` is required (matches DSH's engines).
