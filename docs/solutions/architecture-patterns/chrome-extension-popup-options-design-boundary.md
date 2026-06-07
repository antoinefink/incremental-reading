---
title: "Chrome extension popup/options design boundary"
date: "2026-06-07"
category: "docs/solutions/architecture-patterns/"
module: "apps/extension popup and options"
problem_type: "architecture_pattern"
component: "tooling"
severity: "medium"
applies_when:
  - "Implementing or redesigning Interleave's Chrome extension popup/options surfaces."
  - "Extension UI needs Interleave visual parity without importing Electron renderer assumptions."
  - "Popup command payloads must snapshot current form state at submit time."
  - "Extension pages need visual verification against built dist with Chrome API mocks."
related_components:
  - "apps/extension"
  - "apps/extension background"
  - "design tokens"
tags:
  - "chrome-extension"
  - "popup"
  - "options"
  - "design-boundary"
  - "visual-verification"
  - "chrome-api-mocks"
  - "async-guard"
  - "command-payloads"
---

# Chrome extension popup/options design boundary

## Context

The Chrome extension popup and options page needed to match a supplied Interleave design while staying honest about what the extension can actually do. The popup is a compact, priority-first browser capture surface; the options page is a local pairing surface. Neither is the Electron renderer, and neither has direct access to SQLite, filesystem state, or trusted source lifecycle operations.

The implementation also had to remove stale capability promises. The design did not include keyboard shortcuts or a popup side-panel button, so those affordances had to disappear from the UI, manifest commands, background listeners, tests, and README rather than only from visible copy.

## Guidance

Treat extension design work as both a visual implementation and a browser-boundary contract.

Keep the extension UI self-contained. Re-declare or mirror the canonical design tokens needed by the extension, use the real packaged extension logo assets, and rebuild the prototype structure in browser-extension HTML/CSS/TypeScript. Do not import renderer components or assume `window.appApi`.

Use submit-time snapshots for capture commands. The popup may preview selected text and priority, but the command sent to the background worker should carry the exact selection and priority the user submitted. Do not ask the background worker to re-read mutable browser selection when the popup already showed the user a specific text snapshot.

```ts
function send(type: "save-page" | "save-selection"): void {
  const submittedPriority = priority;
  const submittedSelection = selection;

  chrome.runtime.sendMessage(
    {
      type,
      priority: submittedPriority,
      ...(type === "save-selection" && submittedSelection
        ? { selection: submittedSelection }
        : {}),
    },
    (outcome) => renderCaptureOutcome(type, outcome, submittedPriority),
  );
}
```

Disable or ignore mutable form controls while a save is pending, then render the saved state from the submitted values. This prevents a late response from showing a different priority than the one sent over the browser boundary.

Guard async UI completions against stale renders. Browser actions such as opening a captured source can resolve after the user dismisses the saved view. Capture the initiating DOM nodes and bail out if they are no longer connected.

```ts
async function openSourceFromButton(sourceId: string, button: HTMLButtonElement): Promise<void> {
  const result = document.getElementById("save-result") as HTMLDivElement | null;
  const outcome = await openCapturedSource(sourceId, { activate: true });

  if (!button.isConnected) return;
  if (outcome.kind === "ok" && result?.isConnected) {
    result.textContent = "Opened in Interleave";
  }
}
```

Verify browser-facing contracts directly:

- Popup tests should assert the exact `chrome.runtime.sendMessage` payload, including explicit selected text and submitted priority.
- Background tests should assert explicit selection payload handling, context-menu selection capture, and the explicit side-panel context-menu path.
- Manifest tests should assert removed capabilities stay removed while required surfaces remain configured.
- Visual checks should load the built extension output with Chrome API mocks and inspect actual rendered popup/options states.

## Why This Matters

Extension UI is easy to make visually correct while remaining behaviorally dishonest. Shortcut hints, manifest commands, or unsupported panel buttons advertise workflows the user cannot rely on. A popup that previews one selection but asks the background worker to read another can silently save different evidence than the user saw.

The boundary is also part of Interleave's local-first security model. The extension remains an untrusted browser surface that sends narrow, token-protected commands to the desktop app. The desktop side owns pairing validation, source creation, activation, and reader navigation.

Testing the built extension output catches a different class of regressions than component tests. It proves the packaged HTML, CSS, icons, browser globals, and dark/light token behavior survive bundling.

## When to Apply

- Redesigning the extension popup, options page, or side panel.
- Changing capture payloads, priority controls, selected-text handling, or paired/offline states.
- Removing or adding user-visible extension capabilities in the manifest.
- Porting a design prototype into browser-extension HTML/CSS/TypeScript.
- Verifying extension UI states that depend on Chrome APIs, local loopback reachability, or asynchronous open actions.

## Examples

A manifest regression test should lock down both removal and preservation:

```ts
expect(manifest.commands).toBeUndefined();
expect(manifest.action?.default_popup).toBe("popup.html");
expect(manifest.options_page).toBe("options.html");
expect(manifest.side_panel?.default_path).toBe("sidepanel.html");
```

A visual verifier can serve `apps/extension/dist`, inject Chrome API mocks before page load, and assert both screenshots and small structural metrics:

```ts
await page.addInitScript(() => {
  window.chrome = {
    runtime: {
      id: "visual-extension",
      sendMessage: (_message, callback) => callback({ kind: "ok", response }),
    },
    tabs: {
      query: async () => [{ id: 5, title: "Article", url: "https://example.com" }],
    },
    scripting: {
      executeScript: async () => [{ result: "Selected text" }],
    },
  };
});

await page.goto(`${baseUrl}/popup.html`);
await page.waitForSelector(".selection-preview");
await page.screenshot({ path: "popup-selection.png", fullPage: true });
```

Useful visual metrics for this surface include:

- Correct extension logo paths, such as `icons/icon-32.png` and `icons/icon-48.png`.
- Popup shell width matching the design.
- No stale shortcut or side-panel copy.
- Options shell width and port/help grid columns matching the design.
- Paired, not-paired, not-running, selection, no-selection, and saved states rendering without console errors.

## Related

- [Public static sites should reuse design tokens without crossing desktop boundaries](./public-static-site-design-boundary.md) - adjacent browser-only boundary pattern for reusing visual language without importing desktop runtime assumptions.
- [URL and browser-captured articles should open as internal readable sources](../ui-bugs/url-imported-articles-inbox-processing.md) - related capture workflow precedent for keeping extension actions narrow and desktop-owned.
- [Battle-testing matrix and test-hardening execution for core app surfaces](./test-audit-driven-battle-testing.md) - related guidance on turning review findings into explicit invariant tests.
- [Extract/card IPC invariant test hardening](./extract-card-ipc-invariant-test-hardening.md) - related payload-shape testing precedent.
