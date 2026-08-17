# Monorepo Migration Plan

1. Freeze root workspace metadata and record the approved `monorepo-v1` stories.
2. Back up both source repositories and import their full histories under
   `plugins/dsh-remote` and `plugins/dsh-obsidian` without squashing.
3. Move the unversioned architecture explainer under `tools/dsh-explainer`.
4. Replace nested workspace and lock files with one root pnpm workspace and lock.
5. Install once at the root; run root checks and per-plugin pack checks.
6. Update the active DSH profile's Obsidian link, restart its managed process,
   and verify local DSH, tunnel, public HTTPS, and plugin visibility.
7. Push `main` and archive tags to the empty GitHub repository only after all
   prior checks pass.

Recovery before push is the complete pre-migration source-directory backup.
After push, recovery additionally uses the root pre-import commit and archive
tags; no user data or package publication is involved.
