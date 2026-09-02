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
2. **settings** — provisions `$DSH_HOME/settings.yaml` from the portable template. By
   default it symlinks the template so your custom model config stays single-source and
   syncs on the next `git pull`. When a provider still carries a placeholder `baseURL`
   (`https://your-llm-gateway.example.com/v1`), the bootstrap resolves a real per-machine
   endpoint from a `<KEY>_BASE_URL` environment variable (or an interactive prompt) and
   materializes a **local** `settings.yaml` — real endpoints stay machine-local and are
   never committed. Your curated model fields live under `llm-pi-ai.providers`:
   `contextWindow` (context size), `input: [text, image]` (multimodal),
   `maxTokens`, and `reasoningEfforts` (thinking effort).
3. **credentials** — detects every `apiKeyEnv:` referenced by `settings.yaml`, prompts once
   per machine for the key (or reads it from an environment variable / `env:VAR`), and writes
   the rc.8 flat credential mapping at `$DSH_HOME/.credentials.yaml` with mode `600`. Legacy
   bootstrap files using a `version`/`refs` wrapper are read and migrated on the next write.
   This file is **never committed**.
4. **plugins** — shows required plugins (auto-installed, e.g. `dsh-better-sidebar`) and lets
   you pick optional ones (Obsidian, remote, WeCom, file-attachment) with an interactive
   **checkbox** (↑/↓ to move, Space to toggle, Enter to confirm; plain number input works
   on non-TTY / piped runs), installing via `dsh plugin` with the needed GitHub build-trust.
   A plugin whose install fails (e.g. its path is not yet in the repo) is **skipped with a
   warning for optional plugins**; a required plugin failure still aborts so you know the
   base setup is incomplete.
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
  --settings <path>    portable settings.yaml to use (default: ./settings.yaml)
  --plugins <ids>      comma-separated plugin ids to install (others stay unselected)
  --rekey              force re-prompt for credential values
  --yes                non-interactive: accept each prompt's default; install all optionals
  --skip-dsh           skip DSH install check
  --skip-settings      skip provisioning the settings.yaml
  --skip-baseurl       skip resolving per-machine base URL placeholders
  --skip-credentials   skip credentials
  --skip-plugins       skip plugins
  -h, --help           show help
```

## Per-machine base URLs (via environment variables)

DSH reads `apiKeyEnv` through its credentials seam at request time, but `baseURL` is a
plain config value that DSH does **not** expand against the environment on its own. So
dsh-bootstrap resolves a provider's real endpoint at setup time from an env var whose name
is derived from that provider's `apiKeyEnv` — strip a trailing `_API_KEY` / `_KEY` /
`_TOKEN` and append `_BASE_URL`:

| `apiKeyEnv`           | base URL env var        |
| --------------------- | ----------------------- |
| `GB10_CLUSTER_API_KEY`| `GB10_CLUSTER_BASE_URL` |
| `KIMI_API_KEY`        | `KIMI_BASE_URL`         |
| `GLM_API_KEY`         | `GLM_BASE_URL`          |
| `GPT_API_KEY`         | `GPT_BASE_URL`          |
| `ZAI_CODING_CN_API_KEY`| `ZAI_CODING_CN_BASE_URL`|
| `DS_HAITIAN_API_KEY`  | `DS_HAITIAN_BASE_URL`   |
| `MINIMAX_RELAY_API_KEY`| `MINIMAX_RELAY_BASE_URL`|
| `DSH_TOKYO_API_KEY`   | `DSH_TOKYO_BASE_URL`    |

When at least one such env var is set (or you're on an interactive terminal), the bootstrap
materializes a **local** `$DSH_HOME/settings.yaml` from the template and fills each
placeholder `baseURL` from its env var (prompting interactively otherwise). Providers whose
env var is unset keep the placeholder and warn. This makes the real endpoint machine-local
and never committed — the trade-off is that once materialized, the file is no longer a
symlink, so re-run the bootstrap after `git pull` to fold in template model changes while
your env vars keep supplying the real endpoints.

Unset all `*_BASE_URL` env vars and run non-interactively (e.g. `--yes`) and the bootstrap
keeps the portable **symlink** so model config syncs on `git pull`.

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
- Real per-machine `baseURL` values — resolved from `*_BASE_URL` env vars and written into a
  local `settings.yaml` (not the committed template).
- `$DSH_HOME/profiles/<name>/cordis.patch.yml` — machine-local per-profile config (vault
  paths, bot secrets via env, allowed paths), by DSH design.

## Notes

- `DSH_HOME` defaults to `~/.dsh` on every platform via `homedir()`; override with the
  `DSH_HOME` environment variable.
- Windows: the script is platform-agnostic and the PS launcher is provided, but DSH's own
  platform support is designed-for, not fully verified — review each step on Windows.
- Node `>=22` is required (matches DSH's engines).
