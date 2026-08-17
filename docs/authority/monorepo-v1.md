# DSH Plugins Monorepo Baseline

Baseline revision: `monorepo-v1`

## Approval

The maintainer approved one repository with one directory per plugin and asked
for implementation in the conversation immediately preceding this migration.

## Required Stories

### US-M1

As the plugin maintainer, I want all DSH plugins under one repository's
`plugins/` directory, so that I can discover, install, and verify them from one
workspace.

- Given the monorepo has been cloned
- When the maintainer installs dependencies or runs root checks
- Then both plugins are discovered and verified without entering separate repos

### US-M2

As the plugin maintainer, I want each plugin to retain an independent package,
version, test suite, and release command, so that plugins can evolve and ship
without a shared release version.

- Given one plugin changes
- When its filtered package or release command runs
- Then only that plugin's package identity and release workflow are required

### US-M3

As the current DSH user, I want repository migration to preserve plugin history
and the active profile, so that organization work does not erase provenance or
interrupt the installed DSH experience.

- Given both plugins have existing Git history and Obsidian is linked locally
- When the repositories move under the monorepo
- Then original tips remain reachable and the current DSH starts with both
  plugins and remote access online

## Constraints

- Do not squash or discard either plugin's existing Git history.
- Do not change plugin package names or versions during migration.
- Do not publish packages or alter DSH user data.
- Push only after local package, profile, and runtime verification succeeds.

## Non-goals

- A shared plugin version.
- Publishing to npm.
- Refactoring plugin implementation code.
- Treating `dsh-explainer` as a plugin.
