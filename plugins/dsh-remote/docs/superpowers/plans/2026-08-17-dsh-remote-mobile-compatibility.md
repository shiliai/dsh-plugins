# DSH Remote Mobile Compatibility Plan

Status: approved for implementation
Approved: 2026-08-17, user instruction "好的，我们自己开始修复吧"
Authority: https://github.com/shiliai/dsh-plugins/issues/2

## User story baseline

### MOB-01

As a DSH user opening an existing session from an Android phone, I want the
session header, Chat and Trajectory views, and their controls to fit the visual
viewport, so that I can inspect ongoing work without clipped or unreachable
content.

- Given a 360x800, 390x844, or 412x915 portrait viewport, when an existing
  session is opened and Chat or Trajectory is selected, then the document has
  no unintended horizontal overflow and important controls remain reachable.
- Given a long trajectory label, when the row is rendered, then it truncates or
  scrolls inside its own region without expanding the page.
- Given the sidebar is expanded on a narrow viewport, when it opens, then it is
  presented as an overlay and does not squeeze the session column below its
  usable width.

### MOB-02

As a DSH user working remotely from a phone, I want the composer and Remote
access panel to remain readable and operable, so that I can continue a session
and manage its private link without switching to a desktop.

- Given a narrow portrait viewport, when the composer is shown, then its text
  input, add/command, access mode, model/reasoning, and send/stop controls fit
  without overlap.
- Given the virtual keyboard changes the visual viewport height, when the page
  resizes, then the composer remains anchored inside the visible application.
- Given Remote access is opened, when its panel is displayed, then all controls
  fit inside the visual viewport.
- Given a desktop viewport, when the compatibility layer is loaded, then the
  existing desktop layout remains unchanged.

## Implementation boundary

The defect is owned by upstream DSH 0.1.0-rc.6, whose public repository has no
mobile fix or open PR. This repository will provide a narrow compatibility
layer in `plugins/dsh-remote` until upstream ships an equivalent fix.

The compatibility layer will:

1. Discover DSH shell, sidebar, details, header, trajectory, and composer nodes
   through stable DOM semantics and add `data-dsh-remote-mobile-*` markers.
2. Apply scoped CSS only below a portrait-mobile breakpoint.
3. Render the expanded sidebar as an overlay, hide collapsed details overflow,
   compact the header, and reflow the composer controls.
4. Remove markers and observers when the plugin client is disposed.

It will not modify upstream package files, authentication, private-link
handling, tunnel behavior, `DSH_HOME`, or persisted sessions and model settings.

## Verification

- Unit tests for semantic node marking, mutation handling, and cleanup.
- CSS contract tests that pin the mobile breakpoint and required layout rules.
- Playwright screenshots and geometry assertions at 360x800, 390x844, and
  412x915, plus an existing desktop viewport.
- Live smoke test through `https://zsh.onlyservice.io/` and real Android Chrome
  verification when the device is available.

## Recovery

The change is isolated to the dsh-remote client bundle. Rollback consists of
removing the compatibility module and stylesheet rules or reverting the final
commit, rebuilding the plugin, and restarting the local DSH web profile. No
data migration or VPS configuration rollback is required.
