# M2 — Capture & inbox (T012–T014)

Detailed, buildable specs for the second milestone. After these three tasks the app can
actually take material in: a user can create a source by hand, see it land in an **inbox**,
read its preview, edit its provenance, set its priority, and triage it (keep / prioritize /
accept into active learning / delete) — all through the keyboard-first inbox screen. This is
the first milestone that lets a real source exist; M1 only stood up the shell + seeded demo
data.

Everything here obeys the M1 architecture: the React renderer (`apps/web`) calls the narrow
typed `window.appApi` bridge; the Electron main process (`apps/desktop`) validates the IPC
payload (Zod) and routes to the `packages/local-db` repositories; mutations run in one SQLite
transaction and append an `operation_log` entry; deletes are soft (`deleted_at`). The renderer
never touches SQLite, Node, or the filesystem. **There is no auto-fetch in M2** — provenance is
captured by hand; remote URL fetching + snapshots land in the server phase (M12, T060).

Read first:
- [`../design-system.md`](../design-system.md) and the kit inbox screen
  [`../../design/kit/app/screen-inbox.jsx`](../../design/kit/app/screen-inbox.jsx) +
  `../../design/kit/screenshots/inbox.png` — the import strip + two-pane (list / preview +
  metadata + triage rail) layout this milestone reproduces.
- [`../domain-model.md`](../domain-model.md) — `Element`/`Source`/`Document`, the `inbox`
  status, the `raw_source` stage, priority A/B/C/D, and the operation-log shapes.
- [`../../CLAUDE.md`](../../CLAUDE.md) — layering, Electron security, SQLite rules, data rules.
- Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md). Format/depth exemplar:
  [`M1-foundations.md`](./M1-foundations.md).

What already exists (confirmed by inspecting the repo — **do not rebuild these**):
- `SourceRepository.create(input: CreateSourceInput)` in
  [`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts)
  already creates a `source` element + its `sources` provenance row in one transaction with a
  `create_source` op (and `create_element` via `ElementRepository.createWithin`). `CreateSourceInput`
  **already accepts** `title`, `priority`, `status`, `stage`, `url`, `canonicalUrl`, `originalUrl`,
  `author`, `publishedAt`, `accessedAt`, `snapshotKey`, `reasonAdded` — i.e. all T014 provenance
  fields. It defaults `status: "inbox"` and `stage: "raw_source"`.
- The `sources` table
  ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts)) already has
  `url`, `canonical_url`, `original_url`, `author`, `published_at`, `accessed_at`, `snapshot_key`,
  `reason_added` columns. **T014 needs no new migration** (see its Notes).
- `DocumentRepository.upsert(input: UpsertDocumentInput)` in
  [`../../packages/local-db/src/document-repository.ts`](../../packages/local-db/src/document-repository.ts)
  stores **both** `prosemirror_json` and `plain_text` (and optional stable `document_blocks`),
  logging `update_document`.
- `ElementRepository.update` / `softDelete` / `reschedule` (with `update_element`,
  `soft_delete_element`, `reschedule_element` ops) in
  [`../../packages/local-db/src/element-repository.ts`](../../packages/local-db/src/element-repository.ts).
- Priority helpers `priorityFromLabel` / `priorityToLabel` / `DEFAULT_PRIORITY` (= `C`) in
  [`../../packages/core/src/priority.ts`](../../packages/core/src/priority.ts).
- The IPC seam pattern: shared contract
  [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts) +
  channels [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts),
  router [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts), DB service
  [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts), preload
  [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts), and the
  renderer client [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts).
- The selection context `useSelection()`
  ([`../../apps/web/src/shell/selection.tsx`](../../apps/web/src/shell/selection.tsx)) and the
  inspector ([`../../apps/web/src/components/inspector/Inspector.tsx`](../../apps/web/src/components/inspector/Inspector.tsx))
  — the inbox should set the selection so the existing inspector reacts.

What is **missing** and this milestone adds:
- The `window.appApi` surface is **read-only today** (`app`/`db`/`settings`/`inspector`). M2 adds
  the **first mutation commands** (`sources.importManual`, inbox list/get, triage). Adding a
  capability means adding a channel + Zod schema in the shared contract **first**.
- The `/inbox` route is a placeholder; M2 replaces it with the real screen.
- **Tiptap is not installed** — `packages/editor` is still a stub (the editor lands in T015/M3).
  So T013 must convert pasted text to ProseMirror JSON with a small pure helper, **not** a live
  editor (see T013 Notes).

Build order is the task order; T013 depends on T012, T014 on T013.

---

## T012 — Inbox

- **Status:** `[ ]`  · **Depends on:** T008, T004
- **Roadmap line:** Done when a source can be created in inbox, listed, viewed, kept,
  prioritized, accepted into active learning, or deleted.

### Goal

A real **Import & Inbox** screen at `/inbox` where freshly captured sources (status `inbox`)
are listed, previewed, and triaged. The user can create an inbox source, see it in the list,
open its preview + metadata, change its priority (A/B/C/D), **accept** it into active learning
(status `inbox → active`), keep it for later (`dismissed`/`scheduled`), or **delete** it
(soft-delete). Every action goes through a typed `window.appApi` command, runs in a transaction,
and appends an `operation_log` entry. The screen matches the kit's two-pane layout.

### Context to load first

- Reference: [`../design-system.md`](../design-system.md), the kit screen
  [`../../design/kit/app/screen-inbox.jsx`](../../design/kit/app/screen-inbox.jsx) +
  `screenshots/inbox.png`; [`../domain-model.md`](../domain-model.md) (statuses, stages, priority).
- Existing code to inspect: `SourceRepository.create` + `findById`
  ([`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts)),
  `ElementRepository.{listByStatus,update,softDelete}`
  ([`../../packages/local-db/src/element-repository.ts`](../../packages/local-db/src/element-repository.ts)),
  the IPC seam files listed in the intro, the inspector + `useSelection`.
- Invariants in play: renderer never touches SQL; mutations are transactional + logged;
  soft-delete only; new material defaults to a **non-dominating** priority (`C`) and the `inbox`
  status; lineage is preserved (a source has no parent/source — it IS the lineage root).

### Deliverables

- [ ] **IPC contract (add the first mutation surface)** in
      [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts):
  - Zod request schemas + response types for:
    - `sources.importManual(req)` — create a source in `inbox` (T013 carries the body; T012 may
      land it with title-only and T013 extends the schema). Validate `title` (1–512 chars),
      optional provenance fields, and an optional priority **label** (`"A"|"B"|"C"|"D"`, default
      `"C"`). Return the new element id + a summary.
    - `inbox.list()` — return inbox-status source summaries (id, title, type, status, stage,
      priority, `srcType` label, author, accessedAt, length/char-count, a short preview snippet).
    - `inbox.get(req)` — full preview payload for one inbox item (provenance + plain-text body
      preview), or `null`.
    - `inbox.triage(req)` — apply one triage action to a source:
      `accept` (→ status `active`), `keepForLater` (→ `dismissed`), `delete` (soft-delete),
      and `setPriority` (label → numeric via `priorityFromLabel`). Validate `id` + a discriminated
      `action` union. Return the updated summary (or `{ deleted: true }`).
  - Add the new methods to the `AppApi` interface (`sources`, `inbox` groups).
- [ ] **Channels** in
      [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts):
      `sourcesImportManual`, `inboxList`, `inboxGet`, `inboxTriage`.
- [ ] **IPC handlers** in [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts):
      one `ipcMain.handle` per channel, each `Schema.parse(rawRequest)`-ing before calling the
      DB service. (The disposer already loops `Object.values(IPC_CHANNELS)`, so it covers the new
      channels automatically.)
- [ ] **DB-service methods** in
      [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts):
      `importManualSource(...)`, `listInbox()`, `getInboxItem(id)`, `triageInboxItem(...)` that
      compose `this.repos.sources` / `this.repos.elements` (and `this.repos.documents` for the
      preview). Map label→numeric priority with `priorityFromLabel`. These are the only place the
      repositories are touched for the inbox.
- [ ] **Inbox read query** (optional but preferred) in `packages/local-db` —
      `packages/local-db/src/inbox-query.ts` (mirroring the `inspector-query.ts` pattern) that
      composes `ElementRepository.listByStatus("inbox")` filtered to `type === "source"` + the
      `sources` row + a `documents.plainText` preview slice into the flat `InboxItemSummary` /
      `InboxItemDetail` shapes, so list/preview logic stays out of React. Export it from
      [`../../packages/local-db/src/index.ts`](../../packages/local-db/src/index.ts) and add it to
      `createRepositories`/`Repositories` if it needs the bag (or construct it like `InspectorQuery`).
- [ ] **Renderer client** in [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts):
      mirror the new types and add `appApi.importManualSource`, `appApi.listInbox`,
      `appApi.getInboxItem`, `appApi.triageInboxItem`, plus the matching `AppApi`-interface entries.
- [ ] **`/inbox` screen** — replace the placeholder in
      [`../../apps/web/src/router.tsx`](../../apps/web/src/router.tsx) (inboxRoute) with a real
      `InboxScreen` component (new files under `apps/web/src/pages/inbox/`):
  - Two-pane layout from the kit: a left list of inbox items (using/rebuilding `TypeIcon`, the
    `result`/`badge` row), and a right preview pane with the metadata rail + a **Priority** A/B/C/D
    chip group + a **Triage** action list (Activate / Save for later / Delete with `1`/`3`/`6`-style
    Kbd hints). The "Read soon"/"Merge"/"Archive" extras from the kit are visual-only stubs in M2 or
    omitted; **only Activate, Save for later, Set priority, and Delete are wired** (scheduling lands
    in M5; dedup/merge in M12).
  - The import strip ("Paste URL / Paste text / Upload PDF / Browser capture / Manual note") renders
    per the kit; in M2 only **"Paste text" / "Manual note"** opens the working modal (T013). The
    others are visibly disabled/"coming soon" (URL fetch → M12, PDF → M14, extension → M13).
  - An `EmptyState` ("Inbox zero") when the list is empty, matching the kit.
  - Selecting an item calls `useSelection().select(id)` so the **existing inspector** shows it; the
    in-page metadata rail is for triage-time editing only.
  - All data via `appApi.*`; render gracefully when `!isDesktop()` (mirror the inspector's
    desktop-only fallback).
- [ ] **Tests (unit / domain)** — extend
      [`../../packages/local-db/src/repositories.test.ts`](../../packages/local-db/src/repositories.test.ts)
      (or add `packages/local-db/src/inbox-query.test.ts`) against an in-memory better-sqlite3 DB
      (`test-db.ts`): creating a source lands it in `inbox`; `listInbox` returns only inbox sources
      (not active/deleted ones); `triage` accept flips status to `active` and writes an
      `update_element` op; `setPriority` stores the right numeric value; `delete` soft-deletes
      (`deletedAt` set, `status = "deleted"`) and writes `soft_delete_element`; a deleted item drops
      out of `listInbox`.
- [ ] **Tests (contract)** — extend
      [`../../apps/desktop/src/shared/contract.test.ts`](../../apps/desktop/src/shared/contract.test.ts)
      so each new schema accepts a valid payload and rejects malformed ones (missing `title`, bad
      priority label, unknown triage action).
- [ ] **Tests (E2E, Electron)** — new `tests/electron/inbox.spec.ts` (see Done when).
- [ ] **Docs** — check the T012 box in [`../roadmap.md`](../roadmap.md) with the commit ref and add
      a Progress-log line.

### Done when

- A source can be **created in inbox** (via the new `sources.importManual` command — title-only is
  enough for T012; T013 adds the body), **listed** at `/inbox`, **viewed** (preview + metadata),
  **kept** (Save for later → `dismissed`), **prioritized** (A/B/C/D updates the numeric priority),
  **accepted into active learning** (Activate → status `active`, leaving the inbox), or **deleted**
  (soft-delete → trash, leaving the inbox).
- Every mutation runs in one transaction and appends the correct `operation_log` entry
  (`create_source` + `create_element` on import; `update_element` on accept/keep/priority;
  `soft_delete_element` on delete).
- The renderer reaches all of this **only through `window.appApi`**; no generic `db.query` exists
  and no SQL lives in the React components.
- The screen matches the kit's inbox layout in light **and** dark.
- An Electron E2E imports a source, sees it in the list, accepts one and deletes another, and —
  after an **app restart** against the same data dir — the accepted source is gone from the inbox
  but still exists (now `active`), and the deleted one is absent.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Status semantics for triage** (resolve a roadmap ambiguity): the roadmap says "kept,
  prioritized, accepted into active learning, or deleted." Map them to the domain statuses in
  [`../domain-model.md`](../domain-model.md): **accept → `active`**, **keep for later →
  `dismissed`** (intentionally set aside, not deleted — a true "read soon" date needs the attention
  scheduler, T028, so do **not** invent a `due_at` here), **delete → soft-delete** (`deletedAt` +
  status `deleted`). "Prioritize" is `setPriority` and does not change status. Leave "Read
  soon"/scheduling for M5.
- New material must **not dominate** older high-value material: default imported priority is `C`
  (`DEFAULT_PRIORITY`), per the priority rules.
- The inbox query must filter to live (`deletedAt IS NULL`) **and** `type === "source"` **and**
  `status === "inbox"`. Reuse `ElementRepository.listByStatus` then join the `sources` row.
- This is the first mutation surface on the bridge — keep the Electron security posture: validate
  every payload main-side, never expose `db.query`, keep the channel set narrow.
- Deferred: dedup/"possible duplicate" banner + Merge (M12 T061), URL fetch (M12 T060), PDF/EPUB
  upload (M14), browser capture (M13), concept assignment field (M8 T041 — render the input but it
  may be a no-op stub or omitted in M2).

---

## T013 — Manual text import

- **Status:** `[ ]`  · **Depends on:** T012
- **Roadmap line:** Done when a "New source" modal accepts title/URL/author/date/body and stores
  body as both plain text and ProseMirror JSON; a pasted article appears as a source in the inbox.

### Goal

A **"New source" modal** (reachable from the inbox import strip — "Paste text" / "Manual note" —
and ideally from the `⌘K` command palette) that captures **title, URL, author, date, and body**.
On save it creates an inbox source AND its document body, storing the body **both** as flattened
plain text (for search/preview) and as **ProseMirror JSON** (the future editable substrate).
Pasting an article's text and a title makes it appear immediately in the inbox list.

### Context to load first

- Reference: the kit metadata rail in
  [`../../design/kit/app/screen-inbox.jsx`](../../design/kit/app/screen-inbox.jsx) (fields: Title,
  Author, Concept, Reason saved) and [`../design-system.md`](../design-system.md) form primitives.
- Existing code to inspect: `DocumentRepository.upsert`
  ([`../../packages/local-db/src/document-repository.ts`](../../packages/local-db/src/document-repository.ts))
  — it already stores `prosemirrorJson` + `plainText`; the `Document` type
  ([`../../packages/core/src/source.ts`](../../packages/core/src/source.ts)) types `prosemirrorJson`
  as `unknown` on purpose; the T012 `sources.importManual` command + DB-service method.
- Invariants in play: the document body is the substrate for lineage; **stable block IDs**
  matter later (T016), so generate block ids now if cheap; source creation + document upsert run in
  **one transaction**; the renderer sends a plain string and the **main process** builds the
  ProseMirror JSON (no editor/Node in the renderer).

### Deliverables

- [ ] **Plain-text → ProseMirror converter** (pure, framework-agnostic) — `packages/core` is the
      natural home since `Document.prosemirrorJson` is `unknown` and core stays editor-free; add
      `packages/core/src/prosemirror.ts` exporting e.g.
      `plainTextToProseMirrorDoc(text: string): { doc: unknown; plainText: string; blocks: { blockType: "paragraph"; order: number; stableBlockId: string }[] }`.
      It splits the pasted text on blank lines into paragraphs, builds a minimal valid ProseMirror
      `doc` (`{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }, …] }`),
      and assigns a stable block id per paragraph (reuse `@interleave/core` id helpers). Unit-test
      it. **Rationale:** Tiptap is not installed until T015/M3, so we do not stand up a live editor
      here — just a deterministic converter the document upsert and the later editor both agree on.
- [ ] **Extend `sources.importManual`** (contract + schema + DB service) to accept the full input:
      `title`, optional `url`, `author`, `publishedAt` (the "date" field — an ISO date string),
      `body` (raw pasted text), `reasonAdded`, and the priority label. The DB-service method creates
      the source via `SourceRepository.create` **and** upserts the document via
      `DocumentRepository.upsert(plainTextToProseMirrorDoc(body))` — **in the same logical flow**.
      If `SourceRepository.create` and `DocumentRepository.upsert` cannot share one transaction
      across repos as written, add a small transactional method (e.g.
      `SourceRepository.createWithDocument(input)`) so the source row + document row + their
      `create_source` / `create_element` / `update_document` ops all commit atomically (preferred —
      a source must never persist without its body).
- [ ] **"New source" modal** in the renderer (new files under `apps/web/src/pages/inbox/`, e.g.
      `NewSourceModal.tsx`): a Radix-style dialog with Title / URL / Author / Date / Body inputs
      (+ the priority chip group), keyboard-submittable (`⌘↵`), closeable (`Esc`). On submit it calls
      `appApi.importManualSource(...)`, closes, refreshes `inbox.list()`, and selects the new item.
      Open it from the inbox import strip and (nice-to-have) a `⌘K` "New source" command.
- [ ] **Tests (unit)** — `packages/core/src/prosemirror.test.ts`: blank-line splitting →
      paragraph count; empty/whitespace body → a valid empty doc; round-trip `plainText` equals the
      normalized input; each block gets a unique stable id.
- [ ] **Tests (domain)** — extend the local-db tests: `importManual` with a multi-paragraph body
      persists a `documents` row whose `prosemirror_json` parses to N paragraph nodes and whose
      `plain_text` matches; the source still lands in `inbox`.
- [ ] **Tests (E2E, Electron)** — extend `tests/electron/inbox.spec.ts` (see Done when).
- [ ] **Docs** — check the T013 box in [`../roadmap.md`](../roadmap.md) + Progress-log line.

### Done when

- The "New source" modal accepts **title / URL / author / date / body** and, on save, creates an
  **inbox** source whose document body is stored as **both** `plain_text` and `prosemirror_json`
  (verify the JSON parses to one paragraph node per blank-line-separated paragraph).
- A **pasted article appears as a source in the inbox** list immediately (no reload), with its
  title and a body preview.
- Source row + document row + their ops (`create_source`, `create_element`, `update_document`)
  commit atomically; a failure leaves neither.
- After an **app restart** against the same data dir, the pasted source and its body persist
  (preview still shows the body, inspector still shows provenance).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Do not install Tiptap here.** The live constrained-schema editor is T015 (M3); T013 only needs
  a deterministic plain-text→PM-JSON converter. Keep the produced doc shape compatible with the
  editor's planned constrained schema (paragraphs only is fine for pasted plain text).
- The "date" field is the source's **published date** (`publishedAt` / `published_at`), not the
  accessed date — accessed date is set automatically in T014. Accept a loose date string and store
  it as ISO; do not over-validate.
- Rich-paste (HTML→PM) and Markdown import are **deferred** (M14 T068). M2 ingests plain text only;
  if HTML is pasted, treat it as text.
- Keep the modal pure UI: it gathers field values and calls one `appApi` command; the main process
  owns the conversion + persistence (layering rule — no PM-building in the renderer).

---

## T014 — Source provenance fields (no auto-fetch)

- **Status:** `[ ]`  · **Depends on:** T013
- **Roadmap line:** Done when schema/UI capture canonical URL, original URL, accessed date, and
  snapshot fields for manual imports (no remote fetching yet).

### Goal

Capture and surface full **provenance** for manual imports — **canonical URL**, **original URL**,
**accessed date**, and **snapshot** fields — with **no remote fetching**. The user can record
where a source came from (and the app stamps when it was captured), and the inspector + inbox
preview show it, so even hand-entered sources have durable, lineage-grade origin metadata.

### Context to load first

- Reference: [`../domain-model.md`](../domain-model.md) (the `sources` provenance row),
  [`../../CLAUDE.md`](../../CLAUDE.md) data/asset rules (snapshots are vault assets, not DB blobs).
- Existing code to inspect: the `sources` table
  ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts)) — it
  **already declares** `canonical_url`, `original_url`, `accessed_at`, and `snapshot_key`; the
  `Source` core type ([`../../packages/core/src/source.ts`](../../packages/core/src/source.ts));
  `SourceRepository.create` (which already threads all these fields); the inspector's
  `SourceProvenance` shape ([`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts)).
- Invariants in play: **no network calls** anywhere in M2; snapshot bytes never go in SQLite
  (`snapshot_key` is a vault-relative path only); the accessed date is auto-stamped.

### Deliverables

- [ ] **Confirm: no migration needed.** The `sources` schema already has `canonical_url`,
      `original_url`, `accessed_at`, `snapshot_key`. **Verify this against the generated migration**
      and the live dev DB before writing any migration. Only if a column is genuinely absent, add a
      Drizzle migration via `pnpm db:generate` (and note the backfill = `NULL` for existing rows).
- [ ] **Provenance derivation in the DB service** (extend the T013 `importManual` flow): when
      saving a manual source, **auto-stamp `accessedAt`** to "now" (ISO) if the renderer did not
      supply one; **derive `canonicalUrl`** from the entered `url` with a small pure normalizer (new
      `packages/core/src/url.ts`, e.g. `canonicalizeUrl(raw): string | null` — lowercases host,
      strips common tracking params `utm_*`, `fbclid`, `gclid`, drops the fragment, trims trailing
      slash) and set `originalUrl = url` (the as-entered URL) so both are preserved. `snapshotKey`
      stays `null` in M2 (no snapshot is fetched/written yet).
- [ ] **Contract + client** — extend `sources.importManual` (and the inbox detail payload +
      `SourceProvenance`) so the renderer can optionally pass `canonicalUrl`/`originalUrl`/
      `accessedAt`/`snapshotKey`, and so `inbox.get` / inspector return all four. Keep them optional;
      the service fills the derived defaults.
- [ ] **UI** — surface provenance in the "New source" modal's metadata rail (read-back of the
      derived canonical URL; an editable accessed-date field defaulting to today) and in the inbox
      preview + the existing inspector "Source" section (which already renders `url`, `author`,
      `publishedAt`, `accessedAt`, `reasonAdded` — extend it to also show **canonical URL** and
      **original URL** when present).
- [ ] **Tests (unit)** — `packages/core/src/url.test.ts`: tracking params stripped; fragment
      dropped; host lowercased; `null`/garbage input → `null`; an already-canonical URL is stable
      (idempotent).
- [ ] **Tests (domain)** — importing a source with a tracking-laden URL stores the normalized
      `canonical_url`, keeps `original_url` verbatim, auto-stamps `accessed_at`, and leaves
      `snapshot_key` `null`; **assert no network module is imported** in the import path (keep the
      code path fetch-free — e.g. a lint/grep guard in the test or a code comment).
- [ ] **Tests (E2E, Electron)** — extend `tests/electron/inbox.spec.ts`: import a source with a
      messy URL, open its inspector, assert canonical URL + accessed date are shown; assert no
      outbound request was made (the app must work fully offline).
- [ ] **Docs** — check the T014 box in [`../roadmap.md`](../roadmap.md) + Progress-log line; note
      the "no migration required" finding (or the migration if one was actually needed).

### Done when

- Manual imports **capture and persist** canonical URL, original URL, accessed date, and the
  snapshot field (`snapshot_key`, left `null` in M2), with **zero remote fetching** — the flow
  works offline.
- `canonical_url` is a normalized form of the entered URL; `original_url` preserves the
  as-entered URL; `accessed_at` is auto-stamped at import time.
- The provenance is visible in the inbox preview and the universal inspector, and survives an
  **app restart**.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Most of this is already plumbed** (schema columns + `CreateSourceInput` fields exist). T014 is
  mainly: (1) confirm no migration is needed, (2) add the **derivation** logic (canonicalize + stamp
  accessed-at) and the URL normalizer, and (3) surface the fields in UI. Do not re-add columns that
  exist.
- **Auto-fetch / Readability / snapshot capture is deferred to M12 (T060)**, and canonical-URL
  **duplicate detection** to M12 (T061). M2 only *captures* `canonical_url`; it does **not** dedupe
  against it. Designing the normalizer now (in `packages/core`) means T061 can reuse it.
- `snapshot_key` will point at a vault asset (`assets/sources/<id>/original.html`) once snapshots
  exist (M12); in M2 it is `null`. Never store snapshot bytes in SQLite.
- Keep the normalizer conservative — stripping `utm_*`/`fbclid`/`gclid` + fragment + trailing slash
  is enough for M2; aggressive normalization risks collapsing distinct URLs and belongs with the
  dedup work (T061).

---

## Exit criteria for M2

- All of T012–T014 are `[x]` in [`../roadmap.md`](../roadmap.md) with commit refs + Progress-log
  entries.
- A user can, entirely offline and keyboard-first, create a source by hand (title / URL / author /
  date / body), see it in the **inbox**, read its preview, edit its priority and provenance, and
  triage it — accept into active learning (`inbox → active`), keep for later (`dismissed`), or
  delete (soft-delete). The body is stored as **both** plain text and ProseMirror JSON, and full
  provenance (canonical URL, original URL, accessed date, snapshot field) is captured with **no
  remote fetching**.
- All capture/triage flows go through the typed `window.appApi` bridge (the first **mutation**
  commands: `sources.importManual`, `inbox.list/get/triage`); no generic `db.query` exists and no
  SQL lives in React components. Every meaningful mutation is transactional and appends the right
  `operation_log` entry (`create_source`, `create_element`, `update_document`, `update_element`,
  `soft_delete_element`).
- Everything **survives an app restart** (proven by `tests/electron/inbox.spec.ts`), and source
  lineage is preserved (a source is a clean lineage root with a document body).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the Electron Playwright E2E are green in CI.

When M2 is complete, generate `tasks/M3-document-editor.md` from the roadmap before
starting T015 (the milestone that finally installs Tiptap and turns the stored ProseMirror JSON
into a live, editable, constrained-schema document).
