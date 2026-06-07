---
title: Interleave Extension Redesign
status: active
date: 2026-06-07
origin: design bundle from https://api.anthropic.com/v1/design/h/YUWVYq2n6SFzkBicXrVf7g?open_file=Interleave+Extension.html
execution: code
---

# Interleave Extension Redesign

## Problem Frame

The Chrome extension popup and options page still use a plain scaffold UI, while the fetched design bundle defines a polished Interleave-native extension experience. The production extension should port the design output into the real MV3 extension without copying the prototype runtime, adding new features, or widening the local-first capture boundary.

## Scope Boundaries

- Implement the real extension popup and options/pairing page in `apps/extension`.
- Use the correct existing logo assets from `apps/extension/icons/*`, generated from `brand/logo.png`.
- Remove shortcut concepts from the extension, including MV3 commands and command handling.
- Remove the popup's side-panel affordance. The side panel can remain as an installed extension surface, but the popup should not promote it.
- Preserve the existing loopback capture contract and background message flow. No new desktop routes, renderer APIs, SQLite access, filesystem access, or cloud calls.

## Requirements Trace

- Design bundle `Interleave Extension.html`: branded Interleave popup, connection pill, local-only footer, compact page context, selection-aware capture, priority chips, saved state, offline/unpaired states, options/pairing page.
- Design transcript final iteration: no shortcut hints, no side-panel button in the popup, priority popup only, options page included.
- Project rules: extension is browser-only and must reuse design language through local tokens, not desktop renderer components or `window.appApi`.
- Prior learnings: keep loopback commands narrow, use tokenized local CSS, verify browser-only surfaces with contract/unit tests and visual checks.

## Existing Patterns To Follow

- `apps/extension/src/shared.ts`: normalized `CaptureOutcome` and `OpenSourceOutcome`.
- `apps/extension/src/sidepanel.ts`: priority selection and capture message shape.
- `apps/extension/src/options.ts`: existing pair/ping/write flow.
- `apps/extension/src/tokens.css`: extension-local OKLCH tokens and browser-boundary comments.
- `apps/extension/build.mjs`: static asset copying and icon requirements.

## Implementation Units

### U1: Popup Structure And Behavior

Files:
- Modify `apps/extension/popup.html`
- Modify `apps/extension/src/popup.ts`
- Modify `apps/extension/src/tokens.css`
- Modify `apps/extension/src/popup.test.ts`

Approach:
- Replace the three-button popup with a 332px-ish branded card using the existing icon PNG.
- Render a header with logo, "Interleave / Capture", and a connection-status pill derived from capture outcomes and saved pairing config.
- Show active tab title/domain, selection state, priority chips defaulting to `C`, and context-aware actions.
- Send `priority` with both `save-page` and `save-selection` messages.
- Render saved/duplicate states with an `Open in Interleave` action and priority metadata.
- Render not-paired, bad-token, not-running, and generic errors as designed banners/actions.
- Keep only `Options & pairing` plus `Local-only` in the footer.

Test Scenarios:
- Loads active tab title/domain and shows default priority `C`.
- Priority clicks update `aria-pressed`, hint text, and dispatched message payload.
- Page save dispatches `{ type: "save-page", priority }`.
- Selection save dispatches `{ type: "save-selection", priority }`.
- Success and duplicate outcomes render saved copy plus `Open in Interleave`.
- Not-paired and not-running outcomes render the correct setup/retry states.
- Popup no longer references `save-inbox`, `open-panel`, side panel, or shortcuts.

### U2: Options Page Redesign

Files:
- Modify `apps/extension/options.html`
- Modify `apps/extension/src/options.ts`
- Modify `apps/extension/src/tokens.css`
- Modify `apps/extension/src/options.test.ts`

Approach:
- Rebuild the page as an Interleave settings-like pairing surface: brand header, connection state card, pairing steps, token field, port field, save/test action, and local-only privacy note.
- Add show/hide token support with accessible labels.
- Preserve `readPairedConfig`, `writePairedConfig`, `pingApp`, and `pairWithApp` behavior.
- Use status classes compatible with the extension tokens and existing tests.

Test Scenarios:
- Saved token/port load into redesigned fields and initial connection state reflects saved token.
- Empty token warns without writing config.
- Save/test writes token and port, pings app, pairs origin, and reports "Paired".
- Not-running and bad-token outcomes produce distinct error copy.
- Token visibility toggle changes input type and button label.

### U3: Remove Shortcut Concepts And Popup Side-Panel Entry

Files:
- Modify `apps/extension/manifest.json`
- Modify `apps/extension/src/background.ts`
- Modify `apps/extension/src/background.test.ts`
- Modify `apps/extension/README.md`

Approach:
- Remove `commands` from the manifest.
- Remove `chrome.commands.onCommand` handling and comments.
- Remove the side-panel context menu only if it is presented as shortcut/command access; keep the side-panel surface itself available through Chrome's extension surface if needed.
- Remove README instructions that mention commands or the popup's side-panel button.

Test Scenarios:
- Background tests no longer mock/register `chrome.commands`.
- Install registers only the intended context menus.
- Search confirms no extension shortcut/command references remain.
- Manifest validates/builds without the `commands` key.

### U4: Build, Visual Verification, And Regression Checks

Files:
- No intended production files beyond U1-U3.

Approach:
- Run focused extension tests and build first.
- Serve or open the built popup/options HTML in a browser for screenshot-based visual checks of popup default, popup saved/error states where possible, options page light/dark, and overflow.
- Run root checks required by the repo unless a tool/environment blocker is explicit.

Test Scenarios:
- `pnpm --filter @interleave/extension build`
- Focused Vitest for `apps/extension/src/*.test.ts`
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- Browser visual checks show no horizontal overflow, no text overlap, correct logo, and coherent light/dark styling.
