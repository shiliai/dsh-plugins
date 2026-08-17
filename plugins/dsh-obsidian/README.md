# DSH Obsidian

English | [中文](README.zh.md)

`@dsh-plugins/dsh-obsidian` adds an Obsidian Vault browser, Markdown editor and Vault-scoped model tools to the DeepSeek Harness Web profile. It works directly on the files in a local directory; Obsidian does not need to be running.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- pnpm
- DSH `0.1.0-rc.6` with the Web profile
- A directory that the DSH process can read and, for editing, write

The directory does not have to contain `.obsidian`, although a normal Obsidian Vault usually does.

## Install

From this plugin directory:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add "$(pwd)"
```

Check that the plugin row is present:

```sh
dsh --profile web --dump-config
```

Search the output for `id: dsh-obsidian` and confirm its `config.vaultRoot` value.

## Quick start

Without an override, `vaultRoot` is the directory from which DSH starts. The simplest setup is therefore:

```sh
cd /absolute/path/to/my-vault
dsh web
```

Open **Obsidian notes** from the sidebar footer. The note browser replaces the session browser until its back button is pressed. Opening a note shows the editor or preview in the conversation area for a blank session, or in the details panel for an active session.

## Configure `vaultRoot`

`vaultRoot` selects the initial Vault directory. It is resolved and validated when DSH starts.

- Prefer an absolute path.
- The path must already exist and must be a directory.
- The DSH process must have permission to read it.
- Write permission is required to create, edit, move or delete notes.
- A relative path is resolved against the directory from which DSH was started.
- `~` is not expanded inside a plain YAML string. Use an absolute path or a `!!js` expression.
- The configured root may itself resolve through a symlink, but symlinks inside the Vault are not followed.

### Option 1: use the startup directory

This is the default supplied by the plugin:

```yaml
vaultRoot: !!js process.cwd()
```

Start DSH from the Vault directory whenever you want that directory to be the initial Vault.

### Option 2: persist a fixed directory

Edit the Web profile user patch:

```text
$DSH_HOME/profiles/web/cordis.patch.yml
```

`$DSH_HOME` defaults to `~/.dsh`, so the usual file is `~/.dsh/profiles/web/cordis.patch.yml`. Keep the top-level YAML value as an array and add:

```yaml
- id: dsh-obsidian
  config:
    vaultRoot: '/Users/alice/Documents/Obsidian/My Vault'
    mutationOrigin: 'http://127.0.0.1:3080'
    maxNoteBytes: 2097152
    searchResultLimit: 100
```

Linux example:

```yaml
    vaultRoot: '/home/alice/notes/my-vault'
```

Windows example:

```yaml
    vaultRoot: 'C:\Users\Alice\Documents\Obsidian\My Vault'
```

Important: a DSH row override replaces the row's entire `config`; it does not merge individual keys. Always repeat `vaultRoot`, `mutationOrigin`, `maxNoteBytes` and `searchResultLimit` in this override.

Restart DSH after editing the profile patch, then verify the effective value:

```sh
dsh --profile web --dump-config
```

### Option 3: read the directory from an environment variable

The profile patch may use a user-defined environment variable:

```yaml
- id: dsh-obsidian
  config:
    vaultRoot: !!js process.env.DSH_OBSIDIAN_VAULT ?? process.cwd()
    mutationOrigin: !!js process.env.DSH_OBSIDIAN_ORIGIN ?? 'http://127.0.0.1:3080'
    maxNoteBytes: 2097152
    searchResultLimit: 100
```

Then start DSH with:

```sh
export DSH_OBSIDIAN_VAULT='/absolute/path/to/my-vault'
dsh web
```

PowerShell:

```powershell
$env:DSH_OBSIDIAN_VAULT = 'C:\Users\Alice\Documents\Obsidian\My Vault'
dsh web
```

The environment variable is evaluated when the DSH process starts.

### Option 4: apply a one-time patch

Create `obsidian-vault.patch.yml` with the complete row override shown above, then run:

```sh
dsh --profile web --patch ./obsidian-vault.patch.yml
```

The `--patch` overlay applies only to that invocation and takes precedence over the profile patch.

### Change the Vault from the UI

Use the folder settings button beside the Vault name to browse directories on the machine running DSH. Choose a directory and press **Use this folder**.

- The note browser and all `obsidian_*` model tools switch together.
- Save or discard the active note before switching.
- The selected directory lasts only for the current DSH process.
- Restarting DSH restores the configured `vaultRoot`.
- When the browser accesses a remote DSH server, the chooser shows the server's directories, not directories on the browser device.

## Configuration reference

| Key | Default | Description |
|---|---:|---|
| `vaultRoot` | `process.cwd()` | Initial Vault directory. |
| `mutationOrigin` | `DSH_OBSIDIAN_ORIGIN` or `http://127.0.0.1:3080` | Exact browser origin allowed to create, edit, move, delete or select a Vault. Include scheme and port, with no path. |
| `maxNoteBytes` | `2097152` | Maximum UTF-8 size of one note. Must be a positive safe integer. |
| `searchResultLimit` | `100` | Maximum results returned by one search. Must be a positive safe integer. |

If DSH is opened at another origin, set `mutationOrigin` to that exact origin. For example:

```yaml
    mutationOrigin: 'https://dsh.example.com'
```

Do not add a trailing path. A mismatched origin allows read requests but rejects mutation and Vault-selection requests with `ORIGIN_DENIED`.

## Note workflow

- Browse nested `.md` files and search note paths or contents.
- Create a note by entering a Vault-relative path such as `Projects/Plan.md`.
- Edit and save with stale-write conflict detection.
- Preview Markdown, GFM tables, task lists, Wiki links, frontmatter and local images.
- Rename, move or permanently delete the active note from its action menu.
- Add the active note reference to the current DSH chat draft.
- Observe external changes through periodic tree and active-note refresh.

Only `.md` files appear as notes. Hidden directories, `.git`, `.obsidian` and `node_modules` are excluded from the note tree. Supported local preview images are PNG, JPEG, GIF, WebP and AVIF.

## Model tools

The active DSH provider receives these tools, all scoped to the currently selected Vault:

- `obsidian_list_notes`
- `obsidian_read_note`
- `obsidian_search_notes`
- `obsidian_write_note`
- `obsidian_move_note`
- `obsidian_delete_note`

All note paths are Vault-relative `.md` paths. `obsidian_list_notes` supports a `limit` from 1 to 500 and a continuation `cursor`. Replacing a note requires the `modifiedMs` value returned by `obsidian_read_note`. Deletion is permanent and should only be requested explicitly.

## Safety and filesystem behavior

- The plugin edits the original Vault files; it does not create backups or version history.
- Symlinks inside the Vault are not listed or followed for notes, assets or mutations.
- Note paths cannot be absolute, contain empty components or traverse with `..`.
- A write never silently replaces an existing note. Replacements require the last observed modification time.
- A move never overwrites an existing target.
- Mutation and Vault-selection HTTP requests require the configured browser origin.

Use Obsidian Sync, Git, Time Machine or another backup system before enabling write operations on important notes.

## Troubleshooting

### DSH fails to start

Run:

```sh
dsh --profile web --dump-config
```

Confirm that `vaultRoot` is a non-empty path to an existing directory. Replace `~` with an absolute path and check filesystem permissions.

### DSH starts with the wrong Vault

The UI selection is not persistent. Set `vaultRoot` in `~/.dsh/profiles/web/cordis.patch.yml`, restart DSH and inspect `--dump-config`. Also check whether a later `--patch` overlay overrides the profile value.

### Saving or selecting a Vault returns `ORIGIN_DENIED`

Set `mutationOrigin` to the exact URL shown in the browser address bar's origin: scheme, hostname and optional port, without a path. Restart DSH after changing it.

### A directory is absent from the chooser

The directory may be a symlink, inaccessible to the DSH process or no longer present. The chooser intentionally does not follow symlink directory entries.

### A note is absent from the tree

Confirm that it ends in `.md`, is not under a hidden or excluded directory and is not reached through a symlink.

### Saving reports a conflict

The file changed after it was opened. Preserve any draft text, reload the note, reconcile the changes and save again.

### A note is too large

Increase `maxNoteBytes` in a complete config override, restart DSH and verify the effective configuration.

## Update and remove

Rebuild and add the plugin again to update a source checkout:

```sh
pnpm run build
dsh plugin --profile web add "$(pwd)"
```

Remove it with:

```sh
dsh plugin --profile web remove @dsh-plugins/dsh-obsidian
```

Restart DSH and confirm that `id: dsh-obsidian` is absent from `dsh --profile web --dump-config`. Remove any obsolete `dsh-obsidian` override from the profile patch as well.

## Development verification

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:check
pnpm run e2e:rc6
pnpm run release:check
```

The rc.6 Playwright check uses the installed stable Chrome channel and requires a clean, committed worktree so the tested package has an immutable identity.
