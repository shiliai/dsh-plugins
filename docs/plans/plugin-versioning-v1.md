# Plugin Versioning and Update Plan

1. Add repository-wide versioning, tagging, Git source, migration, and
   verification rules to `AGENTS.md`.
2. Bump both current plugin packages from `0.1.0` to `0.1.1`, add GitHub
   monorepo metadata, and make Git dependency preparation explicit.
3. Add a root verifier and a dependency-free updater that runs through
   `dsh plugin ... dlx`, compares installed SemVer with GitHub manifests, and
   invokes pnpm inside the selected profile.
4. Make update migrate existing local/tarball installs to GitHub subdirectory
   sources while preserving pnpm build trust and dsh bundle reconciliation.
5. Run focused version checks, both package suites/builds, pack checks, and an
   isolated source/update smoke test without changing the live DSH profile.

Recovery is the unchanged Git base `3f51238c81c7d007133abb6250d900eb61ed9369`;
this task performs no publish, tag, profile mutation, or service restart.
