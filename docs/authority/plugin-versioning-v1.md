# Plugin Versioning and GitHub Update Baseline

Baseline revision: `plugin-versioning-v1`

## Approval

The maintainer requested repository versioning rules, versions for both current
plugins, and dsh-driven detection and automatic update of installed plugins from
the public GitHub repository in the 2026-08-18 task message.

## Required stories

### PV-01

As the plugin maintainer, I want one enforceable repository version policy, so
that each plugin can be released independently and traced to an immutable tag.

- Given a plugin's shipped code or packaging changes
- When the maintainer prepares a release
- Then that plugin receives a strict SemVer bump, passes its release checks, and
  may be tagged with its plugin-scoped version tag

### PV-02

As a DSH user, I want installed plugins to expose their current version and
GitHub source, so that dsh can compare the installation with its remote source.

- Given either supported plugin is installed from its GitHub monorepo path
- When the user runs the repository updater through dsh plugin management
- Then it compares the installed SemVer with the public GitHub manifest and
  reports current, outdated, or migration-required

### PV-03

As a DSH user, I want dsh to update an outdated plugin automatically, so that I
do not need to clone, build, pack, or edit the profile manually.

- Given a supported plugin tracks its GitHub monorepo path and a newer revision
  is available
- When the user runs the repository updater's update command through dsh
- Then it preserves build trust, fetches and prepares the newer package, and dsh
  reconciles it as the same profile bundle

## Constraints

- The two plugins remain independently versioned.
- GitHub subdirectory sources track the default branch; every shipped plugin
  change merged to that branch must include the corresponding version bump.
- Existing local path, link, and tarball installs require one explicit migration
  to a GitHub source before remote update detection is possible.
- Git-hosted build scripts must be allowlisted with pnpm's stable package plus
  Git repository key so future commit SHAs remain authorized.
- The repository must be publicly readable for unauthenticated GitHub installs.

## Non-goals

- Publishing packages to npm.
- Modifying upstream `@deepseek-ai/dsh`.
- Silently rewriting profile files or restarting a running DSH process.
- Changing GitHub repository visibility or creating release tags in this task.
