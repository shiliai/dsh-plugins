# dsh-reading

Immersive reading workbench for DeepSeek Harness. Read EPUB / PDF side-by-side with the agent conversation; AZW3/MOBI/AZW files are converted to EPUB when the local conversion tool is available. Reading progress and project context persist locally.

## Status

- **M1–M4 (this release)**: local EPUB/PDF library and reader, persistent progress, three-pane workbench, and Wallabag read-later import/list/article reading.
- **M5 (this release)**: local-library entry in the workbench, per-book metadata/summary editing (sidecar `metadata.json`), one-click LLM summary generation using the current conversation, and uploading local books back to the NAS calibre-web library (metadata included) through the calibre-web web upload flow.

## Features

- **Three-pane workbench**: left = local library / NAS library / read-later / annotations tabs, middle = reader, right = the live DSH conversation.
- **EPUB**: rendered by [foliate-js](https://github.com/johnfactotum/foliate-js) with TOC drawer, font size, theme (dark / paper / sepia), and paginated/scrolled flow.
- **PDF**: rendered by [pdf.js](https://mozilla.github.io/pdf.js/) in continuous-scroll mode with lazy page rendering.
- **Progress**: persisted locally in the plugin data dir (`state.json`); EPUB restores by epubcfi, PDF by page + scroll ratio.
- **Wallabag read-later**: paste an HTTP(S) URL to save it, fetch the extracted article, open it in the middle pane, and persist article scroll progress.
- **Metadata & summary**: right-click a local book → 「元数据与上传…」 to edit title/author/tags/summary (stored in a `metadata.json` sidecar; the library list reflects it immediately). 「用对话生成概要」 asks the current conversation's LLM — which already has the book context injected — to write the summary and fills the form back.
- **Upload back to the NAS library**: confirm metadata and upload in one click. The server drives the calibre-web browser flow (login → CSRF → multipart `/upload`), then writes title/author/tags/summary via the ajax edit endpoints. If the account lacks edit rights the upload still succeeds and the metadata writes surface as warnings.

### Open-first reading flow

Pasting a URL no longer waits for Wallabag's own extraction. The article opens immediately from the local extraction pipeline (built-in adapter for client-rendered z.ai blog posts: the page shell references an MDX bundle, which is parsed into HTML without executing JavaScript), and the article is saved to Wallabag in the background afterwards — a failed save never blocks reading. Existing Wallabag entries whose content is the "wallabag can't retrieve contents" error placeholder are repaired automatically on open/view by re-extracting the content locally and writing it back via the Wallabag API.
- **Math rendering**: `\(...\)` / `\[...\]` LaTeX fragments inside Wallabag articles (e.g. WeChat formula articles extracted by a patched graby) render via bundled MathJax SVG output — no network fonts needed.
- **NAS Calibre-Web OPDS**: browse the configured nasubuntu catalogue and download a selected book into the local reader cache.
- **Import**: click 导入 in the local library pane (`.epub` / `.pdf` / `.azw3` / `.mobi` / `.azw` accepted; Amazon formats render after the M3 conversion pipeline).

## Configuration

Deployment-level config lives in `$DSH_HOME/.env` (non-secrets) and the `refs:` mapping in `$DSH_HOME/.credentials.yaml` (secrets). See `docs/plans/dsh-reading-v1.env.example` in the monorepo. The DSH Settings → Plugins → Reading panel shows the active data-source endpoints and local cache policy; credentials are never displayed:

| Variable | Default | Purpose |
|---|---|---|
| `READING_DATA_DIR` | `~/.dsh/reading` | Books + `state.json` directory |
| `READING_OPDS_0_URL` | — | OPDS/Calibre-Web catalogue URL |
| `READING_OPDS_0_USERNAME` | — | OPDS username |
| `READING_CALIBRE_WEB_URL` | derived from `READING_OPDS_0_URL` minus `/opds` | calibre-web web origin used for uploads |
| `READING_CALIBRE_WEB_USERNAME` / `READING_CALIBRE_WEB_PASSWORD` | falls back to `READING_OPDS_0_*` | Upload account (password via credential ref; needs Upload permission, and edit permission to write metadata) |
| `READING_WALLABAG_URL` | — | Wallabag origin |
| `READING_WALLABAG_CLIENT_ID` | — | OAuth client id (credential ref) |
| `READING_WALLABAG_CLIENT_SECRET` | — | OAuth client secret (credential ref) |
| `READING_WALLABAG_USERNAME` | — | Wallabag username (credential ref) |
| `READING_WALLABAG_PASSWORD` | — | Wallabag password (credential ref) |

> EPUB rendering note: foliate-js requires CSP to block scripts in book content. DSH does not send CSP headers; only open books you trust.

## Config export / import

Reading joins the shared DSH「配置迁移」(config portability) contract — a Settings → Plugins →「配置迁移」tab that moves plugin configuration between machines as a single JSON envelope (no books, progress, or annotations).

- **Endpoints** (under the plugin API prefix): `GET /dsh-reading/api/config/export[?redact=1]` and `POST /dsh-reading/api/config/import[?dryRun=1]`.
- **Exported content**: wallabag / OPDS / calibre-web data-source config, user settings (`rootDir`, `createSessionOnOpen`), and `library.dataDir` as reference only.
- **Credentials are exported in plaintext by default** (required for one-click migration); uncheck「包含敏感凭据」or pass `?redact=1` to blank `clientSecret`/`password`. Treat the export file as a secret.
- **Import behavior**: on import, adapters rebuild in place — changes apply to the running host immediately, no restart. Sections with blank credentials are skipped with a warning (partial credentials are never written); sections with invalid URLs reject the whole import and leave no residue.
- **Config priority** (per source): explicit cordis config > `<dataDir>/reading-config.json` (written by imports; corrupt files are ignored) > env / credentials refs. cordis `null` still force-disables a source. The override file never touches `.env`, `.credentials.yaml`, or the profile manifest.
- Other plugins join with two steps via the shared `@dsh-plugins/dsh-config-portability` package (see its README); the tab appears once no matter how many plugins register.

## Development

```sh
pnpm install
pnpm run check        # typecheck + tests + build
pnpm run release:check
```
