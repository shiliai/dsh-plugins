# DSH Obsidian

`@dsh-plugins/dsh-obsidian` adds an Obsidian-vault workflow to the DeepSeek Harness Web profile. It keeps the DSH conversation, provider, permission, and session runtime, while adding a Markdown file tree and a note editor/preview in the details panel.

## Install

Build the plugin checkout, then add it to the Web profile:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add "$(pwd)"
```

Start DSH from the Vault directory. The process working directory is the Vault root:

```sh
cd /path/to/obsidian-vault
dsh web
```

Open **Obsidian notes** from the sidebar footer. The notes view temporarily replaces the session browser; the back button restores it. Opening a note uses the right details panel after the current session has a message, or the center panel before the first message. Closing the note restores DSH's normal surface.

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

Replacing an existing note requires the `modifiedMs` value returned by `obsidian_read_note`. `obsidian_list_notes` accepts an optional `limit` (1-500) and `cursor`, returning `nextCursor` when more paths remain. All note paths are Vault-relative `.md` paths. Symlinks are never followed for listing, reads, assets, or mutations.

## Configuration

The bundle contributes this DSH patch:

```yaml
- insert:
    - id: dsh-obsidian
      name: '@dsh-plugins/dsh-obsidian'
      inject: [webServer, tools]
      config:
        vaultRoot: !!js process.cwd()
        mutationOrigin: !!js process.env.DSH_OBSIDIAN_ORIGIN ?? 'http://127.0.0.1:3080'
        maxNoteBytes: 2097152
        searchResultLimit: 100
```

The standard DSH Web origin defaults to `http://127.0.0.1:3080`. Set `DSH_OBSIDIAN_ORIGIN` to the exact browser origin before starting DSH when using another host or port. Mutation requests are accepted only from that configured origin; matching client-supplied `Origin` and `Host` headers are not sufficient. Override the row in a later profile patch to change limits, the origin, or pin another Vault root. Verify the effective configuration with `dsh --profile web --dump-config`.

## Development

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:check
pnpm run e2e:rc6
pnpm run release:check
```

Requires Node `^22.19.0 || >=24.0.0`, pnpm, and a DSH `0.1.0-rc.6` Web profile. The rc.6 Playwright check uses the installed stable Chrome channel. React is supplied by the DSH host; the package keeps React only for development builds and tests.

## Recovery

Stop the Web profile, remove the bundle with `dsh plugin --profile web remove @dsh-plugins/dsh-obsidian`, then restart DSH and confirm the row is absent from `dsh --profile web --dump-config`. The plugin never creates a Vault backup or version history. Restore overwritten or deleted notes from your Vault backup, sync service, or Obsidian version history before restarting the profile.
