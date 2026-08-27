# dsh-file-attachment

Adds host-local temporary file attachments to the DeepSeek Harness web
composer. It works with text-only models because attachments are represented in
the prompt as ordinary text containing a sanitized name, media type, size, and
absolute `file://` URI.

The plugin supports file selection, drag and drop, and clipboard paste. The
clipboard path is tested in Chromium and WebKit for current macOS Chrome-family
browsers and Safari.

It does not change model capability metadata, create native image blocks,
inspect file content, or invoke MCP tools. The Agent decides whether to read the
path locally or pass it through an MCP upload/analyze workflow.

## Install

Trust both pnpm Git source normalizations, then install through DSH:

```sh
dsh plugin --profile web config set --location=project --json allowBuilds \
  '{"@dsh-plugins/dsh-file-attachment@git+https://github.com/shiliai/dsh-plugins.git":true,"@dsh-plugins/dsh-file-attachment@git+ssh://git@github.com/shiliai/dsh-plugins.git":true}'
dsh plugin --profile web add \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-file-attachment'
```

Restart the profile after installation.

## Configuration

The bundled defaults are:

```yaml
maxFileBytes: 26214400
maxFilesPerMessage: 10
maxMessageBytes: 104857600
ttlMs: 86400000
cleanupIntervalMs: 3600000
```

Files are stored under `$DSH_HOME/attachments/tmp` unless `root` is configured.
They use random, sanitized names and mode `0600`. Upload and delete requests
require a browser Origin matching the request host or an entry in
`allowedOrigins`.

Temporary references expire by design. The default 24-hour window is intended
for the active conversation, not durable archival access from old transcripts.

## Verify

```sh
pnpm --filter @dsh-plugins/dsh-file-attachment release:check
```
