# DSH Obsidian

`@dsh-plugins/dsh-obsidian` adds an Obsidian-vault workflow to the DeepSeek Harness Web profile. It keeps the DSH conversation, provider, permission, and session runtime, while adding a Markdown file tree and a note editor/preview in the details panel.

## Install

Build the plugin checkout, then add it to the Web profile:

```sh
pnpm install --config.auto-install-peers=false
pnpm run build
dsh plugin --profile web add /Users/chris/project/dsh-plugins/dsh-obsidian
```

Start DSH from the Vault directory. The process working directory is the Vault root:

```sh
cd /path/to/obsidian-vault
dsh web
```

Open **Obsidian notes** from the sidebar footer. The notes view temporarily replaces the session browser; the back button restores it. Opening a note uses the right details panel, and closing the note restores DSH's normal tool details.

## Note workflow

- Browse nested Markdown notes, search paths and contents, and create notes.
- Edit with stale-save conflict detection or preview GFM, task lists, Wiki links, local images, and frontmatter-aware content.
- Move, rename, or delete the active note from its action menu.
- Add the active note reference to the current DSH chat draft.
- Observe external or provider changes through periodic tree and active-note refresh.

The active DSH provider receives these Vault-scoped tools:

- `obsidian_list_notes`
- `obsidian_read_note`
- `obsidian_search_notes`
- `obsidian_write_note`
- `obsidian_move_note`
- `obsidian_delete_note`

Replacing an existing note requires the `modifiedMs` value returned by `obsidian_read_note`. All note paths are Vault-relative `.md` paths. Symlinks are never traversed while listing, and reads or writes through a symlink that leaves the Vault are rejected.

## Configuration

The bundle contributes this DSH patch:

```yaml
- insert:
    - id: dsh-obsidian
      name: '@dsh-plugins/dsh-obsidian'
      inject: [webServer, tools]
      config:
        vaultRoot: !!js process.cwd()
        maxNoteBytes: 2097152
        searchResultLimit: 100
```

Override the row in a later profile patch to change limits or pin another Vault root.

## Development

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:check
```

The package targets the DSH pre-release plugin interfaces represented by `deepseek-harness` commit `47f943859bef60e4160492346772ded9b24f765a`.
