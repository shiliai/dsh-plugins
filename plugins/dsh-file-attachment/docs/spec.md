# DSH File Attachment Plugin Spec

Baseline: `dsh-file-attachment-v2`

Authority: the user request in the Codex task on 2026-08-22, including the
clarification that attachments are local temporary files and the requirement
to support clipboard paste on macOS Safari and Chromium browsers.

## User Stories

### US-A1: Attach a local file

As a DSH chat user, I want to select, drag, or paste an image or ordinary file
into the composer, so that the file is available on the DSH host without
switching to an image-capable conversation model.

- Given an ordinary DSH session and a permitted file
- When the user selects it, drops it, or pastes it from the clipboard
- Then the host stores an immutable temporary copy and the composer shows a
  removable attachment before submission.

### US-A2: Let the Agent decide how to inspect it

As a DSH chat user, I want the submitted message to carry an accessible local
file reference, so that the Agent can decide whether to use local tools or MCP
tools to inspect it.

- Given one or more successfully uploaded draft attachments
- When the user submits the message
- Then the model-visible text contains each sanitized name, media type, byte
  count, and absolute `file://` URI, while no native image content block or
  automatic MCP call is created.

## Constraints

- Prioritize current macOS Safari and Chromium clipboard APIs. Read both
  `clipboardData.files` and file-valued `clipboardData.items`; deduplicate the
  same browser file object when both collections expose it.
- Browser bytes are sent only to the current DSH host. Secrets and MCP
  credentials never enter the browser bundle.
- Store files below the resolved DSH home, using random directory names and a
  sanitized display-name suffix. Never interpret an uploaded name as a path.
- Default limits are 25 MiB per file, 10 files per message, and 100 MiB per
  message. Limits are configurable and enforced by both client hints and host.
- Temporary files expire after 24 hours by default. Cleanup runs at startup and
  periodically. Deleting a draft attachment removes its temporary file.
- Upload and delete are same-origin mutations. File reads are not exposed as a
  public unauthenticated HTTP download endpoint.

## Non-goals

- Do not change model capability metadata or the host's native image gate.
- Do not send DSH image content blocks.
- Do not call `upload_image`, `analyze_image`, or another MCP tool automatically.
- Do not parse, OCR, summarize, or transform uploaded content.
- Do not promise that an expired temporary path remains usable from old chat
  history.

## Architecture

The host plugin owns a temporary-file store and a small same-origin JSON API.
The client plugin registers composer controls and document-level drop/paste
listeners. It uploads file bytes as canonical base64 JSON, keeps returned
metadata in a per-session draft store, and inserts a deterministic attachment
reference block into the text draft. Submission therefore follows DSH's normal
text-only prompt path.

The attachment reference format is:

```text
[Attached file: screenshot.png]
type: image/png
size: 12345 bytes
uri: file:///absolute/path/to/random-id-screenshot.png
```

The reference is plain model-visible text. The Agent remains responsible for
choosing and invoking any local or MCP tool.

## Verification

- Unit tests cover filename sanitization, containment, limits, expiry, deletion,
  and deterministic reference formatting.
- HTTP tests cover same-origin enforcement, malformed input, aggregate limits,
  upload, and delete.
- Client tests cover selection, drag/drop, Safari-style clipboard files,
  Chromium-style clipboard items, deduplication, removal, and draft insertion.
- A browser fixture verifies the composer workflow in WebKit and Chromium.
- Package and repository release checks verify the Git source artifact.
