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
2. **credentials** — detects every `apiKeyEnv:` and `baseURL: credential:NAME` reference,
   prompts once per machine for each value (or reads it from an environment variable /
   `env:VAR`), and writes the rc.8 flat mapping at `$DSH_HOME/.credentials.yaml` with mode
   `600`. Legacy bootstrap files using a `version`/`refs` wrapper are migrated immediately,
   with a protected `.legacy-<timestamp>.bak` rollback copy. Writes use rc.8-compatible YAML
   parsing, its shared writer-lock convention, and atomic mode-`600` replacement. This file
   is **never committed**.
3. **settings** — provisions `$DSH_HOME/settings.yaml` from the portable template. A provider
   endpoint is declared as `baseURL: credential:NAME`; bootstrap resolves that reference from
   `.credentials.yaml` (with the same-named process environment variable taking precedence)
   and materializes the literal URL currently required by DSH into a local settings document.
   Real endpoints therefore stay out of the repository. Templates without credential-backed
   base URLs can still be symlinked. Curated model fields live under `llm-pi-ai.providers`:
   `contextWindow`, `input`, `maxTokens`, and `reasoningEfforts`.
4. **plugins** — shows required plugins (auto-installed, e.g. `dsh-better-sidebar`) and lets
   you pick optional ones (Obsidian, remote, WeCom, file-attachment) with an interactive
   **checkbox** (↑/↓ to move, Space to toggle, Enter to confirm; plain number input works
   on non-TTY / piped runs), installing via `dsh plugin` with the needed GitHub build-trust.
   A plugin whose install fails (e.g. its path is not yet in the repo) is **skipped with a
   warning for optional plugins**; a required plugin failure still aborts so you know the
   base setup is incomplete.
5. **update** (`sync` offers it; `update` runs it directly) — resolves and updates DSH
   first, verifies the requested version plus `web --dump-config`, and only then updates
   repo-sourced plugins (via the repository updater) and npm-sourced plugins. Managed
   `~/.local/share/dsh-cli/current` installs are never overwritten with global npm; when
   they are behind, bootstrap stops before touching plugins and asks you to use the managed
   installer. It also refuses mixed npm/pnpm profiles or profile-local DSH core packages,
   which can otherwise create incompatible private scope instances at runtime.

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
  --skip-baseurl       skip resolving credential-backed base URLs
  --skip-credentials   skip credentials
  --skip-plugins       skip plugins
  -h, --help           show help
```

## Per-machine base URLs

DSH reads `apiKeyEnv` through its credentials seam at request time, but currently requires
`baseURL` to be a literal settings value. The portable bootstrap template therefore uses an
explicit credential reference:

```yaml
gpt:
  apiKeyEnv: GPT_API_KEY
  baseURL: credential:GPT_BASE_URL
```

Bootstrap stores both `GPT_API_KEY` and `GPT_BASE_URL` in `.credentials.yaml`, then renders
the local DSH settings file with the resolved URL. Each base URL reference is explicit; it
is not derived from the API-key name. In non-interactive `--yes` mode, same-named environment
variables are imported into the credential file. An unresolved reference remains visible in
the generated settings with a warning rather than silently falling back to a shared endpoint.

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

- `$DSH_HOME/.credentials.yaml` — API keys and provider base URLs, written per machine.
- Resolved per-machine `baseURL` values in the generated local `settings.yaml`; the portable
  template contains credential references only.
- `$DSH_HOME/profiles/<name>/cordis.patch.yml` — machine-local per-profile config (vault
  paths, bot secrets via env, allowed paths), by DSH design.

## Notes

- `DSH_HOME` defaults to `~/.dsh` on every platform via `homedir()`; override with the
  `DSH_HOME` environment variable.
- The launcher refreshes its sparse cache on every run and installs the bootstrap's small
  runtime dependency set before starting it. From a full repository clone, run `pnpm install`
  once before invoking `node scripts/dsh-bootstrap/bootstrap.mjs` directly.
- Windows: the script is platform-agnostic and the PS launcher is provided, but DSH's own
  platform support is designed-for, not fully verified — review each step on Windows.
- Node `>=22` is required (matches DSH's engines).
