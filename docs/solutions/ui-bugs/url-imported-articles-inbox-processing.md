---
title: "URL and browser-captured articles should open as internal readable sources"
date: "2026-06-06"
last_updated: "2026-06-06"
category: "docs/solutions/ui-bugs/"
module: "import-inbox-and-browser-capture"
problem_type: "ui_bug"
component: "service_object"
severity: "medium"
symptoms:
  - "URL/blog imports appeared as Manual note in inbox source-type labels."
  - "Inbox selected preview flattened and truncated persisted article content instead of rendering the full formatted body."
  - "Browser extension captures could save or dedupe articles but offered no direct Open in Interleave action."
  - "Recent browser captures in the side panel were visible but not actionable."
  - "Duplicate URL Open existing paths could lose the source status needed to activate inbox matches before reader navigation."
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "database"
  - "frontend_stimulus"
  - "authentication"
  - "testing_framework"
tags:
  - "inbox"
  - "url-import"
  - "browser-capture"
  - "loopback"
  - "open-source"
  - "source-activation"
  - "source-reader"
  - "typed-contract"
---

# URL and browser-captured articles should open as internal readable sources

## Problem

The inbox treated URL-imported articles like manual notes: the type label was misleading, the selected preview used a truncated plain-text slice instead of the persisted formatted document, and the right rail had external provenance links but no internal action that opened the source for processing.

The browser extension had the same workflow gap from the other side: capture responses returned the saved source id, but the popup, side panel, and recent-capture rows offered no way to open the local source reader and start working on it.

## Symptoms

- URL and blog imports appeared as `Manual note` in the inbox source-type label.
- The selected inbox preview flattened formatting and could omit the tail of a long article.
- The user could open the canonical web URL but not the local source reader from the inbox.
- Browser captures reported `Saved` or `Already saved`, but did not offer `Open in Interleave`.
- Recent captures in the browser side panel were static history rows.
- Duplicate URL imports reduced the duplicate match to an id, losing the source status needed to decide whether an inbox match should be accepted before navigation.
- Malformed persisted document JSON could be passed directly to the editor preview.
- Stale inbox triage calls could mutate sources that had already left the inbox.

## What Didn't Work

- Returning only `bodyPreview` from the inbox detail contract was not enough. It was plain text, intentionally truncated, and could not preserve the source reader's ProseMirror structure.
- Keeping `srcType` as an M2 placeholder made all source summaries say `Manual note`, even when provenance contained URL, media, snapshot, or source-type data.
- Handling `Read now` purely in the renderer would not protect against stale IPC calls from another window or a delayed duplicate click.
- Refreshing the full inbox detail after a priority-only change needlessly re-sent full article bodies over IPC.
- Treating `/capture` success as enough was insufficient. The extension already had the saved source id, but no authenticated desktop command consumed it.
- Exposing a generic route or renderer command to the extension would have widened the loopback attack surface.
- Hard-loading an already open renderer window would risk losing pending renderer state. Loaded windows need an in-app event and router navigation.
- Passing only a duplicate source id to `Open existing` was too thin because behavior depends on whether the existing source is still in `inbox`.

## Solution

Make the selected inbox detail a full-body payload, but keep full document data out of the list query:

```ts
export interface InboxItemDetail {
  readonly summary: InboxItemSummary;
  readonly provenance: InboxProvenance;
  readonly bodyDoc: unknown | null;
  readonly bodyText: string | null;
  readonly bodyPreview: string | null;
}
```

Return `bodyDoc` from the document row whenever the row exists, and return the full untruncated `plainText` as `bodyText`. Keep `bodyPreview` only as a legacy fallback.

Derive inbox source labels from persisted provenance instead of a hard-coded placeholder:

```ts
export function inboxSourceTypeLabel(source: Source | null): string {
  if (!source) return "Manual note";
  if (source.mediaKind) return mediaSourceLabel(source.mediaKind);
  if (source.sourceType) return SOURCE_TYPE_LABEL[source.sourceType];
  if (source.snapshotKey?.toLowerCase().endsWith(".pdf")) return "PDF";
  if (source.snapshotKey?.toLowerCase().endsWith(".epub")) return "Book";
  if (source.snapshotKey?.toLowerCase().endsWith(".html")) return "Web article";
  if (source.url || source.canonicalUrl || source.originalUrl) return "Web article";
  return "Manual note";
}
```

URL imports should also persist a source type:

```ts
sourceType: "article";
```

In the renderer, prefer a formatted read-only `SourceEditor` only after validating the opaque document JSON against the editor schema. Fall back to full text when the JSON is malformed or missing:

```ts
const inboxPreviewSchema = buildSchema();

function validBodyDoc(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    inboxPreviewSchema.nodeFromJSON(value);
    return value;
  } catch {
    return null;
  }
}
```

Replace the old primary `Activate` action with `Read now`: accept the inbox item, then navigate to `/source/$id`. Keep external URL links visually and semantically separate from the internal processing action.

Apply the same internal-processing rule to browser captures. Add a narrow open command to the capture contract instead of a generic command channel:

```ts
export const OpenSourceRequestSchema = z.object({
  id: z.string().trim().min(1).max(ELEMENT_ID_MAX),
  activate: z.boolean().optional().default(true),
});
```

Handle `POST /open-source` in the desktop loopback server with the same paired-origin CORS, bearer token, JSON content type, body cap, and Zod validation posture as `/capture`. The route calls an injected opener and returns only typed non-leaky outcomes such as `not_found` or `open_failed`.

Keep source validation, activation, and window focus in Electron main:

```ts
const element = dbService.repos.elements.findById(id);
if (!element || element.deletedAt || element.type !== "source") {
  return { status: "not_found" };
}

if (input.activate && element.status === "inbox") {
  dbService.triageInboxItem({ id, action: { kind: "accept" } });
}
```

For an already loaded desktop window, send a receive-only `sources:openReader` event through preload and let the renderer navigate to `/source/$id`. For a loading or newly created window, load the encoded source route directly.

In the extension, centralize `openCapturedSource()` in shared browser-only code. The popup success and deduped states render `Open in Interleave`, and the side panel renders the same action for both the current capture status and recent-capture rows.

For duplicate URL imports inside the app, pass the full `SourceDuplicateSummary` through `Open existing`. If the match is still an inbox source, accept it first, then navigate to `/source/$id`; active matches navigate directly.

Finally, make inbox triage conditional in Electron main before mutating:

```ts
const current = tx.select().from(elements).where(eq(elements.id, id)).get();
if (!current || current.deletedAt || current.type !== "source" || current.status !== "inbox") {
  throw new Error("Inbox item is no longer available.");
}
```

Use the returned summary to patch priority-only state locally, avoiding a second `inbox.get` call that would resend the full body.

## Why This Works

The inbox preview now receives the same durable document data that the reader uses: valid ProseMirror JSON for formatted rendering and full plain text as a fallback. Formatting is preserved without making the list endpoint heavy, because only the selected detail endpoint carries the full body.

Source labels now reflect provenance rather than import modality assumptions. A source with URL or HTML snapshot provenance reads as a web article, while true manual text stays a manual note.

The internal processing action is explicit and local: `Read now` changes lifecycle state and opens the local reader, while canonical URL links remain external provenance links.

The browser extension remains untrusted. It can only POST a paired, token-authenticated `{ id, activate }` request to the loopback server. Electron main still owns the database lookup, lifecycle transition, window focus, and route choice.

Activating before navigation means a just-captured inbox source becomes work-ready before the source reader opens. Using a main-to-renderer open event for already loaded windows avoids hard reloads and preserves renderer state.

The stale triage guard belongs in Electron main because it protects all callers, not just the current React window. It prevents a second accept/delete request from reviving or mutating an item that is no longer a live inbox source.

## Prevention

- Keep full article bodies on selected-detail contracts, not list contracts.
- Validate opaque persisted document JSON before handing it to editor components.
- For summary-only mutations, use the mutation response to patch summary state instead of re-fetching full detail.
- Guard command-shaped inbox mutations at the main-process/service boundary with live element preconditions.
- Give each future browser-extension desktop action its own narrow capture contract and loopback route; do not add a generic command endpoint.
- Keep lifecycle mutations main-side. The extension may request an open action, but it should not decide database state directly.
- Preserve full duplicate match objects through UI callbacks when open behavior depends on status or metadata.
- Test both the legacy fallback path and the formatted path:
  - provenance labels for URL imports, manual notes, snapshots, and media
  - full `bodyDoc` and untruncated `bodyText`
  - empty formatted docs with empty plain text
  - malformed formatted JSON falling back to full text
  - `Read now` activation and navigation failure handling
  - stale duplicate accept/delete requests that must not mutate deleted or non-inbox rows
  - `/open-source` auth, CORS, body-size, schema, not-found, and open-failed cases
  - activation before source-reader navigation
  - existing-window event navigation versus loading/new-window route loading
  - extension success, dedupe, recent-open, bad-token, and not-running states

## Related Issues

- [Active card rows should open a protected card detail surface](./active-card-rows-open-card-detail-surface.md) - adjacent routing precedent for opening the specific work surface for an object instead of a generic or inert destination.
- [Electron main rolling backups pattern](../architecture-patterns/electron-main-rolling-backups-over-renderer-reminders.md) — low overlap; reinforces keeping trusted state transitions in Electron main.
