# dsh-reading

Immersive reading workbench for DeepSeek Harness. Read EPUB / PDF (and soon AZW3/MOBI via conversion) side-by-side with the agent conversation, with local reading-progress persistence.

## Status

- **M1 (this release)**: plugin skeleton, local library (import + browse), foliate-js EPUB reader, pdf.js PDF reader (Range-capable file endpoint), reading progress persistence, three-pane workbench (library / reader / conversation).
- Planned: M2 OPDS library source, M3 SSH `ebook-convert` + annotations, M4 Wallabag read-later + Obsidian export. See `docs/plans/dsh-reading-v1.md` in the monorepo.

## Features

- **Three-pane workbench**: left = library (read-later / annotations tabs land in later milestones), middle = reader, right = the live DSH conversation.
- **EPUB**: rendered by [foliate-js](https://github.com/johnfactotum/foliate-js) with TOC drawer, font size, theme (dark / paper / sepia), and paginated/scrolled flow.
- **PDF**: rendered by [pdf.js](https://mozilla.github.io/pdf.js/) in continuous-scroll mode with lazy page rendering.
- **Progress**: persisted locally in the plugin data dir (`state.json`); EPUB restores by epubcfi, PDF by page + scroll ratio.
- **Import**: click 导入 in the library pane (`.epub` / `.pdf` / `.azw3` / `.mobi` / `.azw` accepted; Amazon formats render after the M3 conversion pipeline).

## Configuration

Deployment-level config lives in `$DSH_HOME/.env` (non-secrets) and `$DSH_HOME/.credentials.yaml` (secrets). See `docs/plans/dsh-reading-v1.env.example` in the monorepo. M1 only uses:

| Variable | Default | Purpose |
|---|---|---|
| `DSH_READING_DATA_DIR` | `~/.dsh/reading` | Books + `state.json` directory |

> EPUB rendering note: foliate-js requires CSP to block scripts in book content. DSH does not send CSP headers; only open books you trust.

## Development

```sh
pnpm install
pnpm run check        # typecheck + tests + build
pnpm run release:check
```
