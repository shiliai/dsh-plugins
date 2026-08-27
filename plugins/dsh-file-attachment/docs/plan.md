# DSH File Attachment Implementation Plan

1. Scaffold `@dsh-plugins/dsh-file-attachment` with host and browser entries,
   strict TypeScript, build, test, package, and release commands.
2. Implement a DSH-home-backed temporary file store with bounded writes,
   sanitized names, random identities, deletion, and periodic expiry cleanup.
3. Register same-origin host endpoints for limits, upload, and draft deletion.
4. Register composer attachment UI for file selection, drag/drop, and paste;
   cover macOS Safari and Chromium clipboard representations.
5. Append deterministic local attachment references to the text draft and keep
   native DSH image content empty.
6. Add focused host/client tests, Chromium/WebKit browser coverage, README,
   pack verification, root install metadata, and version checks.
7. Run plugin release checks plus root `versions:check`, `check`, and
   `pack:check`; perform final user-story playback against the tested artifact.
