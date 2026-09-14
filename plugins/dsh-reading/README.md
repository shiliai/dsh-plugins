# dsh-reading

Immersive reading workbench for DeepSeek Harness. Read EPUB / PDF side-by-side with the agent conversation; AZW3/MOBI/AZW files are converted to EPUB when the local conversion tool is available. Reading progress and project context persist locally.

## Status

- **M1–M4 (this release)**: local EPUB/PDF library and reader, persistent progress, three-pane workbench, and Wallabag read-later import/list/article reading.

## Features

- **Three-pane workbench**: left = library/read-later/annotations tabs, middle = reader, right = the live DSH conversation.
- **EPUB**: rendered by [foliate-js](https://github.com/johnfactotum/foliate-js) with TOC drawer, font size, theme (dark / paper / sepia), and paginated/scrolled flow.
- **PDF**: rendered by [pdf.js](https://mozilla.github.io/pdf.js/) in continuous-scroll mode with lazy page rendering.
- **Progress**: persisted locally in the plugin data dir (`state.json`); EPUB restores by epubcfi, PDF by page + scroll ratio.
- **Wallabag read-later**: paste an HTTP(S) URL to save it, fetch the extracted article, open it in the middle pane, and persist article scroll progress.
- **Math rendering**: `\(...\)` / `\[...\]` LaTeX fragments inside Wallabag articles (e.g. WeChat formula articles extracted by a patched graby) render via bundled MathJax SVG output — no network fonts needed.
- **NAS Calibre-Web OPDS**: browse the configured nasubuntu catalogue and download a selected book into the local reader cache.
- **Import**: click 导入 in the library pane (`.epub` / `.pdf` / `.azw3` / `.mobi` / `.azw` accepted; Amazon formats render after the M3 conversion pipeline).

## Configuration

Deployment-level config lives in `$DSH_HOME/.env` (non-secrets) and the `refs:` mapping in `$DSH_HOME/.credentials.yaml` (secrets). See `docs/plans/dsh-reading-v1.env.example` in the monorepo. The DSH Settings → Plugins → Reading panel shows the active data-source endpoints and local cache policy; credentials are never displayed:

| Variable | Default | Purpose |
|---|---|---|
| `READING_DATA_DIR` | `~/.dsh/reading` | Books + `state.json` directory |
| `READING_OPDS_0_URL` | — | OPDS/Calibre-Web catalogue URL |
| `READING_OPDS_0_USERNAME` | — | OPDS username |
| `READING_WALLABAG_URL` | — | Wallabag origin |
| `READING_WALLABAG_CLIENT_ID` | — | OAuth client id (credential ref) |
| `READING_WALLABAG_CLIENT_SECRET` | — | OAuth client secret (credential ref) |
| `READING_WALLABAG_USERNAME` | — | Wallabag username (credential ref) |
| `READING_WALLABAG_PASSWORD` | — | Wallabag password (credential ref) |

> EPUB rendering note: foliate-js requires CSP to block scripts in book content. DSH does not send CSP headers; only open books you trust.

## Development

```sh
pnpm install
pnpm run check        # typecheck + tests + build
pnpm run release:check
```
