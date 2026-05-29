# M3 — Document editor & reading (T015–T018)

Detailed, buildable specs for the third milestone. After these four tasks a source is no
longer an opaque placeholder: its body renders and edits in a **constrained Tiptap editor**,
every block carries a **stable ID** that survives saves and re-imports, the user can set and
resume a **read-point**, and `/source/$id` becomes a **clean reading workspace** matching
`design/kit/app/screen-reader.jsx`. This is the substrate the whole extraction/lineage chain
(M4) is built on — **get the stable block IDs and read-points right here, because extracts,
source-locations, sub-extracts, and sync all anchor to them.**

The canonical architecture is unchanged from M1/M2: `apps/web` is a pure **renderer**; the
**Electron main** process (`apps/desktop`) owns SQLite via `packages/local-db` repositories;
the renderer reaches everything through the narrow typed `window.appApi` bridge over
**validated (Zod) IPC**. No SQL, no Node, no filesystem in the renderer. Editor/document logic
(the ProseMirror schema, block-ID extension, JSON↔plain-text↔blocks transforms) lives in
**`packages/editor`** — framework-light and testable — not inside React components.

**What already exists (do not rebuild it):**

- **Schema (T006).** `documents`, `document_blocks` (with `stableBlockId` + the unique
  `document_blocks_stable_idx` on `(documentId, stableBlockId)`), `document_marks`, and
  `read_points` are already defined in
  [`packages/db/src/schema/documents.ts`](../../packages/db/src/schema/documents.ts) and
  [`packages/db/src/schema/relations.ts`](../../packages/db/src/schema/relations.ts), and are
  in migration `drizzle/0000_*.sql`. **No new migration is needed for T015–T018** unless you add
  a column (call it out if you do).
- **Repository (T008).**
  [`packages/local-db/src/document-repository.ts`](../../packages/local-db/src/document-repository.ts)
  already implements `upsert(...)` (body + `plainText` + block replacement, logging
  `update_document`), `findById`, `listBlocks`, `getReadPoint`, and `setReadPoint(...)`
  (logging `set_read_point`) — all transactional with operation-log append.
- **Core types (T005).** `Document`, `ReadPoint`, `BlockId`, `ElementLocation`,
  `DistillationStage` exist in [`packages/core`](../../packages/core/src).

**What does NOT exist yet (this milestone builds it):**

- `packages/editor` is an empty placeholder — **no Tiptap/ProseMirror dependency is installed.**
- There are **no `documents.*` or `readPoints.*` channels** on the `window.appApi` surface
  ([`apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts) only has
  `app`/`db`/`settings`/`inspector`). Each new capability is a new channel + Zod schema +
  preload method + main router handler + db-service method + renderer client wrapper.
- `/source/$id` is still a `Placeholder`
  ([`apps/web/src/router.tsx`](../../apps/web/src/router.tsx)).

Read first: [`../domain-model.md`](../domain-model.md) ("Document/editor rules"),
[`../design-system.md`](../design-system.md) (the `screen-reader` row + reading marks),
[`../../CLAUDE.md`](../../CLAUDE.md) ("Document/editor rules", "SQLite rules", layering), and the
design reference [`../../design/kit/app/screen-reader.jsx`](../../design/kit/app/screen-reader.jsx)
+ [`../../design/kit/screenshots/reader.png`](../../design/kit/screenshots/reader.png) +
the reading-mark CSS in [`../../design/kit/styles/app.css`](../../design/kit/styles/app.css)
(`mark.hl`, `mark.extracted`, `.dimmed`, `.readpoint`, `.reader`, `.pbar`, `.readpara`). Spec
contract: [`_TEMPLATE.md`](./_TEMPLATE.md).

Build order is the task order: T016 depends on T015, T017 on T016, T018 on T017 (+ the shell,
T004). **Selection-toolbar / Extract / Cloze / Highlight / processed-span marks are M4
(T019–T026) — they are explicitly deferred; M3 stops at a read-only-feeling reader with a
read-point and *display* of extracted spans seeded by M4.**

---

## T015 — Tiptap document editor

- **Status:** `[ ]`  · **Depends on:** T013, T005

### Goal
A source's body renders and edits as rich text using a **deliberately constrained**
Tiptap/ProseMirror schema (headings, paragraphs, bold, italic, links, blockquotes, ordered &
bullet lists, inline + block code, horizontal rule). Edits serialize to ProseMirror JSON +
flattened plain text and persist through the existing `DocumentRepository.upsert(...)` via a
new typed `window.appApi.documents.*` surface, and reload byte-for-byte on reopen. This turns a
source from an opaque placeholder into an editable document — the substrate the rest of M3/M4
builds on.

### Context to load first
- Reference: [`../domain-model.md`](../domain-model.md) "Document/editor rules";
  [`../../CLAUDE.md`](../../CLAUDE.md) "Document/editor rules" + layering rules.
- Existing code to inspect:
  [`packages/editor/src/index.ts`](../../packages/editor/src/index.ts) (placeholder),
  [`packages/editor/package.json`](../../packages/editor/package.json) (no Tiptap dep yet),
  [`packages/local-db/src/document-repository.ts`](../../packages/local-db/src/document-repository.ts)
  (`upsert`/`findById` already exist),
  [`packages/core/src/source.ts`](../../packages/core/src/source.ts) (`Document` type),
  the contract/preload/router/db-service/client wiring chain
  ([`apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts),
  [`apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts),
  [`apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts),
  [`apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts),
  [`apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts),
  [`apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts)) — follow the `inspector.*`
  pattern exactly when adding the new commands.
- Invariants in play: renderer never touches SQLite/Node/fs; `update_document` op-log append;
  `plainText` stays in sync with the JSON; the schema is **constrained** (no arbitrary HTML).

### Deliverables
- [ ] **Editor package deps + schema.** Add Tiptap to
  [`packages/editor/package.json`](../../packages/editor/package.json): `@tiptap/core`,
  `@tiptap/pm`, `@tiptap/react`, and **`@tiptap/starter-kit`** (or the discrete extensions —
  Document, Paragraph, Text, Heading, Bold, Italic, Link, Blockquote, BulletList, OrderedList,
  ListItem, Code, CodeBlock, HorizontalRule, History). **Configure StarterKit to allow ONLY the
  constrained set** — disable `strike`/anything not in the list so the schema cannot grow by
  accident. Export the extension array as `interleaveExtensions` (or `buildExtensions()`) from
  `packages/editor/src/schema.ts`, replacing the `editorPlaceholder` export in
  [`packages/editor/src/index.ts`](../../packages/editor/src/index.ts).
- [ ] **Serialization helpers** in `packages/editor/src/serialize.ts` (framework-agnostic, no
  React): `toPlainText(doc)` (flatten ProseMirror JSON → newline-joined block text, kept in
  sync with what `DocumentRepository` stores in `plainText`), and `emptyDoc()`
  (`{ type: "doc", content: [{ type: "paragraph" }] }`). These run in Vitest without a DOM.
- [ ] **React editor component** `packages/editor/src/SourceEditor.tsx` (uses
  `@tiptap/react` `useEditor`/`EditorContent`): props `{ initialDoc, editable, onChange }`,
  emits `{ prosemirrorJson, plainText }` on debounced change. Styling uses the design tokens
  (reuse the `.reader` / `.reader p` / `.reader h3` faces from `app.css` — IBM Plex Serif read
  face) — no hard-coded colors/px.
- [ ] **New `documents.*` IPC surface.** In
  [`apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts) add
  `documentsGet: "documents:get"` and `documentsSave: "documents:save"`. In
  [`contract.ts`](../../apps/desktop/src/shared/contract.ts) add `DocumentsGetRequestSchema`
  (`{ elementId }`), `DocumentsSaveRequestSchema`
  (`{ elementId, prosemirrorJson: z.unknown(), plainText: z.string(), schemaVersion?: number }`),
  result types (`{ document: { prosemirrorJson, plainText, schemaVersion, updatedAt } | null }`),
  and extend the `AppApi` interface with `documents: { get(...); save(...) }`.
- [ ] **Wire the new commands** through every layer following the `inspector.*` precedent:
  preload method ([`preload/index.ts`](../../apps/desktop/src/preload/index.ts)), validated
  handler in [`ipc.ts`](../../apps/desktop/src/main/ipc.ts), `getDocument`/`saveDocument`
  methods on [`db-service.ts`](../../apps/desktop/src/main/db-service.ts) that route to
  `repos.documents.findById` / `repos.documents.upsert`, and the mirrored client wrapper +
  types in [`apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts). `documents.save`
  computes `plainText` via the editor's `toPlainText` on the **renderer** side and passes it in;
  the main side persists exactly what it receives (it does not re-parse ProseMirror in main).
- [ ] **Renderer integration point.** A small `apps/web/src/pages/source/useDocument.ts` hook
  (load on mount via `appApi.getDocument`, save debounced via `appApi.saveDocument`) so T018 can
  drop the editor into `/source/$id`. Loading/empty/no-desktop states handled (mirror
  `DesktopStatusPanel`'s `isDesktop()` guard).
- [ ] **Tests:**
  - Vitest in `packages/editor` for `toPlainText`/`emptyDoc` and that the configured schema
    **accepts** the allowed nodes/marks and **rejects/strips** disallowed ones (e.g. a `strike`
    mark or raw `<script>` does not survive a JSON round-trip through the schema).
  - Vitest in `packages/local-db` (or reuse `repositories.test.ts`) proving `upsert` →
    `findById` round-trips ProseMirror JSON + `plainText` unchanged (the persistence half).
  - A contract test extending
    [`apps/desktop/src/shared/contract.test.ts`](../../apps/desktop/src/shared/contract.test.ts)
    for the two new schemas (valid + invalid payloads).
- [ ] **Docs:** check the T015 roadmap box with the commit ref; note the new `documents.*`
  channels so M4 builders know the surface exists.

### Done when
- A source body renders in the constrained editor; the user can apply headings, bold, italic,
  links, blockquotes, both list types, inline/block code, and an `hr`, and nothing outside that
  set can be entered.
- Editing then reopening the source shows the **same** content (ProseMirror JSON + `plainText`
  persisted via `documents.save` → `DocumentRepository.upsert`, reloaded via `documents.get`).
- The mutation appends an `update_document` operation-log entry (already done by `upsert`).
- The renderer reaches documents only through `window.appApi.documents.*` — no SQL/fs in
  components.
- `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass.
- The feature survives an **app restart** (verified by T018's E2E once the reader exists; the
  T015 unit/contract tests prove the persistence path).

### Notes / risks
- **Constrained schema is the point.** Do not ship full StarterKit defaults; an over-broad
  schema makes later block-ID + mark + extraction logic (T016/M4) brittle. Tables, images,
  task-lists, mentions, etc. are out of scope.
- Keep React out of `schema.ts`/`serialize.ts` so they stay unit-testable without a DOM and so
  the main process could (later) reuse them if needed.
- `schemaVersion` defaults to `1`; bump only with a documented migration of stored JSON — not
  in this task.
- **Block IDs are T016**, not here. T015 may persist blocks via `upsert({ blocks })` with
  placeholder IDs, but the *stable* ID extension + preservation guarantees land in T016 — keep
  the `blocks` plumbing ready but don't claim stability yet.

---

## T016 — Stable block IDs

- **Status:** `[ ]`  · **Depends on:** T015

### Goal
Every block-level node in the editor carries a **stable, persistent ID** that survives editing,
saving, and re-importing the same source — so extracts, read-points, source-locations, and the
eventual sync can anchor to a paragraph/heading and still find it after the document is edited.
This is the single most load-bearing guarantee in the document layer.

### Context to load first
- Reference: [`../domain-model.md`](../domain-model.md) "Document/editor rules" (stable block
  IDs are the anchor lineage depends on); [`../../CLAUDE.md`](../../CLAUDE.md) "Document/editor
  rules" + "SQLite rules" (IDs generated in the domain layer).
- Existing code to inspect:
  [`packages/db/src/schema/documents.ts`](../../packages/db/src/schema/documents.ts) — the
  `document_blocks.stableBlockId` column + the unique `(documentId, stableBlockId)` index
  **already exist**; [`packages/local-db/src/document-repository.ts`](../../packages/local-db/src/document-repository.ts)
  `upsert({ blocks })` + `listBlocks` already persist/read them;
  [`packages/local-db/src/ids.ts`](../../packages/local-db/src/ids.ts) (`newRowId` = UUID v4
  today; the comment notes a one-line switch to ULID);
  [`packages/core/src/ids.ts`](../../packages/core/src/ids.ts) (`BlockId` brand).
- Invariants in play: a block's ID is assigned **once** and never regenerated on edit; the same
  ID maps to the same `document_blocks` row; soft-deletes don't orphan referenced block IDs.

### Deliverables
- [ ] **`blockId` ProseMirror attribute.** A Tiptap extension in
  `packages/editor/src/block-id.ts` that adds a global `blockId` attribute to every block-level
  node (paragraph, heading, blockquote, list item / list container per the chosen granularity,
  code block, horizontal rule). On node creation with no `blockId`, mint one; render it to the
  DOM as `data-block-id` so the reader (T018) and later mark/extraction code can target it.
  Implement via a ProseMirror **appendTransaction** plugin (or `addGlobalAttributes` +
  a node-view/`appendTransaction` filler) that assigns IDs to any block missing one — never
  re-assigning an existing one.
- [ ] **ID strategy (decision, documented in the file):** block IDs are **ULID strings**
  (lexicographically sortable, time-ordered, collision-resistant) minted in the editor at block
  creation time. Add a `newBlockId()` minter — either bring `ulid` into `packages/editor` **or**
  (preferred, to keep one minting site) add `newBlockId(): BlockId` to
  [`packages/local-db/src/ids.ts`](../../packages/local-db/src/ids.ts) and a renderer-safe
  equivalent the editor can call without Node `crypto`. **Resolve the UUID-vs-ULID nuance here:**
  M1's `newRowId` mints UUID v4 for `document_blocks.id` (the surrogate PK); the *stable* block
  ID (`stableBlockId`) is what lineage references and is what this task makes ULID. Document that
  `document_blocks.id` (PK) and `stableBlockId` (anchor) are distinct on purpose.
- [ ] **Preservation transform** in `packages/editor/src/blocks.ts`: `toBlockInputs(doc)` →
  `DocumentBlockInput[]` (`{ blockType, order, stableBlockId }`) read straight off the
  `blockId` attributes (never regenerated), passed to `DocumentRepository.upsert({ blocks })`.
  On **re-import** of the same source (M2 import path), existing block IDs in the incoming JSON
  are preserved; only genuinely new blocks get fresh IDs.
- [ ] **Save path uses it.** Wire `documents.save` (T015) to send `blocks` derived from
  `toBlockInputs`, so every save refreshes `document_blocks` while preserving stable IDs.
- [ ] **Tests:**
  - Vitest in `packages/editor`: a document round-trips through edit → serialize → re-parse with
    **identical** `blockId`s; inserting a new paragraph mints exactly one new ID and leaves the
    others untouched; reordering preserves IDs (only `order` changes).
  - Vitest in `packages/local-db`: `upsert({ blocks })` then `listBlocks` returns the same
    `stableBlockId`s in order; a second `upsert` with the same IDs replaces rows without changing
    the stable IDs (idempotent re-save).
- [ ] **Docs:** check the T016 box; note the ULID decision + the `id` vs `stableBlockId`
  distinction in the progress log so M4 (source-locations) and M11 (sync) builders rely on it.

### Done when
- Every block node has a stable ID, visible as `data-block-id` in the rendered DOM and stored as
  `document_blocks.stableBlockId`.
- Editing, saving, and reloading a document **preserves** all existing block IDs; only new blocks
  get new IDs (proven by tests).
- Re-importing the same source preserves block IDs (no churn that would orphan extracts/read-
  points).
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass; persistence survives **app restart**.

### Notes / risks
- **Do not regenerate IDs on every save** — that would silently break every extract and read-
  point pointing at the document. The appendTransaction filler must be strictly additive.
- Decide list granularity explicitly (IDs on `listItem` vs the list container) and document it;
  M4 extraction will target whatever you choose.
- Cross-document copy/paste can carry foreign `blockId`s; for M3 it's acceptable that pasted
  blocks keep or get new IDs as long as IDs stay **unique per document** (the schema's unique
  index enforces this) — note any duplicate-on-paste handling deferred to M4.

---

## T017 — Read-points

- **Status:** `[ ]`  · **Depends on:** T016

### Goal
A source/topic remembers how far the user has read: a **read-point** (stable block ID + character
offset) that the user can set, jump to, and that auto-advances when they extract. Reopening a
source resumes near the last read-point instead of at the top — the core "incremental" affordance.

### Context to load first
- Reference: [`../domain-model.md`](../domain-model.md) (`read_points` model + the read-point in
  "Document/editor rules"); [`../scheduling-and-priority.md`](../scheduling-and-priority.md) is
  *not* required (read-points are not scheduling) but the attention scheduler later reads
  last-processed.
- Existing code to inspect:
  [`packages/db/src/schema/relations.ts`](../../packages/db/src/schema/relations.ts)
  (`read_points` table — one per element, `blockId` + `offset`, already migrated);
  [`packages/local-db/src/document-repository.ts`](../../packages/local-db/src/document-repository.ts)
  (`getReadPoint`/`setReadPoint` **already implemented**, logging `set_read_point`);
  [`packages/core/src/element.ts`](../../packages/core/src/element.ts) (`ReadPoint` type).
- Invariants in play: one read-point per element (upsert, not append); the block ID referenced
  must be a real `stableBlockId` from T016; `set_read_point` op-log append (already done by the
  repository).

### Deliverables
- [ ] **New `readPoints.*` IPC surface.** In
  [`channels.ts`](../../apps/desktop/src/shared/channels.ts) add
  `readPointGet: "readPoint:get"` and `readPointSet: "readPoint:set"`. In
  [`contract.ts`](../../apps/desktop/src/shared/contract.ts) add `ReadPointGetRequestSchema`
  (`{ elementId }`), `ReadPointSetRequestSchema`
  (`{ elementId, documentId, blockId: z.string().min(1), offset: z.number().int().min(0) }`),
  result types (`{ readPoint: { blockId, offset, updatedAt } | null }`), and extend `AppApi`
  with `readPoints: { get(...); set(...) }`. Wire through preload / `ipc.ts` (validated) /
  `db-service.ts` (`getReadPoint`/`setReadPoint` → `repos.documents.*`) / the renderer client in
  [`appApi.ts`](../../apps/web/src/lib/appApi.ts), mirroring `inspector.*`.
- [ ] **Set read-point.** A "Set read-point" action (button + `Space` shortcut per the kit's
  `Btn variant="primary" icon="bookmark"` + `Kbd k="␣"`) that captures the block ID + offset at
  the current caret/scroll anchor in the reader and calls `readPoints.set`. (The action button is
  added in T018's reader; T017 provides the command + a renderer helper to resolve the current
  block/offset from the editor selection.)
- [ ] **Jump to read-point.** A `jumpToReadPoint()` helper that scrolls/focuses the block whose
  `data-block-id` matches the stored read-point and places the caret at the offset; used on reader
  open and by an explicit "Resume" affordance.
- [ ] **Auto-update on extract (stub seam).** Expose a `markReadThrough(blockId)` path
  (renderer helper + the existing `readPoints.set`) that M4's extraction (T021) will call so an
  extract auto-advances the read-point to (at least) the extracted block. **In M3, wire it to the
  "Set read-point" action only; the extraction call site is deferred to T021** — leave a clearly
  named seam, do not build extraction here.
- [ ] **Resume on reopen.** `useDocument`/the reader loads the read-point alongside the document
  and resumes near it (scrolls to the block, renders the `.readpoint` divider before the first
  unread block per the kit).
- [ ] **Tests:**
  - Vitest in `packages/local-db`: `setReadPoint` then `getReadPoint` round-trips; a second
    `setReadPoint` **updates** (does not duplicate) the single row; a `set_read_point` op-log
    entry is appended (assert via `OperationLogRepository`).
  - Contract test for the two new schemas (valid + invalid: negative offset, empty blockId).
- [ ] **Docs:** check the T017 box; note the `readPoints.*` surface + the `markReadThrough` seam
  reserved for T021.

### Done when
- A read-point (`blockId` + `offset`) can be **set** on a source/topic and persists in
  `read_points` (one row per element).
- The user can **jump** to the read-point; reopening the source **resumes** near it (scrolls to
  the block, shows the read-point divider).
- The `markReadThrough` seam exists and updates the read-point; the actual auto-advance-on-extract
  call site is explicitly deferred to T021.
- `set_read_point` op-log entries are written; data survives **app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks
- The stored `blockId` must be a **stable** block ID from T016. If a referenced block is later
  deleted, `jumpToReadPoint` must degrade gracefully (fall back to nearest surviving block / top)
  — `read_points` has `onDelete: cascade` on the element, not on individual blocks, so a stale
  `blockId` is possible; handle it.
- `offset` is a character offset within the block's text; clamp to the block length on jump.
- Read-points are **not** the attention scheduler. Don't compute due dates here — T028 reads
  last-processed signals later.

---

## T018 — Source reading mode

- **Status:** `[ ]`  · **Depends on:** T017, T004

### Goal
`/source/$id` becomes a real **incremental reading workspace**: a clean, serif reading column
showing the source title + metadata header, the document body (via the T015 editor, read-leaning
by default), a **read-point marker**, **display markers for already-extracted spans**, a reading-
progress bar, an action bar (set read-point, postpone, mark done, lower priority, open original),
and a source inspector — matching `design/kit/app/screen-reader.jsx` in light **and** dark, all
reading through `window.appApi`. Pleasant enough to actually process a long article.

### Context to load first
- Reference: [`../design-system.md`](../design-system.md) (the `screen-reader` → `/source/$id`
  row; reading marks `mark.hl`/`mark.extracted`/`.dimmed`/`.readpoint`; the source inspector +
  `LineageTree`); [`../../CLAUDE.md`](../../CLAUDE.md) "Key screens" (Source Reader) + "UX rules".
- Existing code to inspect:
  [`../../design/kit/app/screen-reader.jsx`](../../design/kit/app/screen-reader.jsx) +
  [`../../design/kit/screenshots/reader.png`](../../design/kit/screenshots/reader.png) (the
  layout/interaction spec), the reading-mark CSS in
  [`../../design/kit/styles/app.css`](../../design/kit/styles/app.css) (lines ~377–410, 596–605:
  `.reader`, `.reader p/h3`, `.pbar`, `.readpara`, `.readpoint`, `mark.*`, `.dimmed`,
  `.sel-toolbar`); the current placeholder + route in
  [`apps/web/src/router.tsx`](../../apps/web/src/router.tsx) (`/source/$id`); the shell +
  inspector ([`apps/web/src/shell/Shell.tsx`](../../apps/web/src/shell/Shell.tsx),
  [`apps/web/src/components/inspector/Inspector.tsx`](../../apps/web/src/components/inspector/Inspector.tsx),
  the existing `inspector.get` payload with `source`/`children`/`location`); the selection context
  [`apps/web/src/shell/selection.tsx`](../../apps/web/src/shell/selection.tsx).
- Invariants in play: renderer reads only via `window.appApi` (`documents.get`,
  `readPoints.get`, `inspector.get`); rebuild the prototype's *visual output*, not its
  Babel-in-browser structure; tokens only, no hard-coded colors/px.

### Deliverables
- [ ] **Real `/source/$id` page** replacing the placeholder: a `apps/web/src/pages/source/`
  module (e.g. `SourceReader.tsx`) wired into [`router.tsx`](../../apps/web/src/router.tsx). On
  mount it loads the document (`useDocument`, T015), the read-point (T017), and the inspector
  payload (`appApi.getInspectorData({ id })`, T010) for the source's metadata/lineage.
- [ ] **Source header** matching the kit: title (`page-title`), author + URL + concept tag +
  priority + status + `SchedulerChip` (attention) + last-processed/next line, using the existing
  `packages/ui` / inspector primitives. URL/author/concept come from the inspector `provenance`.
- [ ] **Reading column** (`.reader`, serif read face): the document body rendered by the T015
  editor (default **read-leaning** — editable toggle is fine but the resting state is reading);
  a progress `.pbar` driven by the read-point position over total blocks; the `.readpoint`
  divider rendered before the first unread block (per T017).
- [ ] **Extracted-span display markers.** Render `mark.extracted` spans for blocks/ranges that
  already have an `extracted_span` mark or an `ElementLocation` pointing into this source. **M3
  only *displays* them** (read from `inspector.get`'s children/locations and/or
  `document_marks`); **creating** extracted spans + the selection toolbar is M4 (T019–T021).
  Surface the "Extracts from this source" inspector section using `inspector.get` `children`.
- [ ] **Action bar** (kit's row of `Btn`s): **Set read-point** (`Space`, primary, calls
  `readPoints.set` via T017), Postpone, Mark done, Lower priority, Open original. For M3, wire
  **Set read-point** fully; Postpone / Mark done / Lower priority may call existing
  element/queue commands if available, otherwise render disabled/no-op with a clear TODO pointing
  at M5 (T027–T031) — **do not invent a scheduling path here.** "Open original" is a
  best-effort link (M2 provenance URL) or disabled when absent.
- [ ] **Keyboard actions** in the reader (extend the shell's keyboard handling): `Space` set
  read-point. (Extract/Cloze/Highlight `E`/`C`/`H` shortcuts belong to the M4 selection toolbar
  — note them as reserved, do not implement.)
- [ ] **Reading styles in the renderer.** Port the needed reading-mark CSS into the app's stylesheet
  (e.g. a `apps/web/src/pages/source/reader.css` deriving from tokens) — `mark.hl`,
  `mark.extracted`, `.dimmed`, `.readpoint`, `.reader`, `.pbar`, `.readpara`. **Do not edit
  `design/kit`** (it is immutable reference); reproduce the visual output against `tokens.css`.
- [ ] **E2E (Playwright)** extending [`tests/e2e`](../../tests/e2e): drive the Electron app (or
  the renderer where the desktop harness isn't wired) for
  **(a) edit → reload**: open `/source/$id` of a seeded source, edit the body, reopen the route,
  assert the edit persisted; and
  **(b) reopen → resume-at-read-point**: set a read-point partway down, navigate away, reopen the
  source, assert the read-point divider/scroll lands at the saved block (not the top). Add a
  `restart-app → verify-persistence` step if the Electron E2E harness supports it; otherwise note
  that the persistence guarantee is covered by the T015/T017 repository tests + the reload E2E and
  the full restart E2E lands in T049.
- [ ] **Docs:** check the T018 box; record the milestone exit in the progress log.

### Done when
- `/source/$id` shows the source title, metadata, body, a read-point marker, extracted-span
  display markers, a progress bar, and the action bar — matching `screen-reader.jsx` /
  `reader.png` in **both** light and dark.
- Editing the body and reopening the route shows the persisted edit (E2E (a)).
- Setting a read-point and reopening resumes near it (E2E (b)).
- All reading happens through `window.appApi` (`documents.get`/`readPoints.get`/`inspector.get`)
  — no SQL/Node/fs in the page.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the relevant `pnpm e2e` pass.

### Notes / risks
- **Selection toolbar, Extract, Cloze, Highlight, and processed-span collapse are M4
  (T019–T026).** T018 displays extracted spans and sets read-points; it must not create extracts
  or highlights. Keep the selection seam clean for T019.
- Long documents: the reader is the editor in a read-leaning mode; virtualization is **not**
  required for the MVP — note it as a possible later optimization (M20 scale work) if a seeded
  article is large.
- Reuse the shell's right inspector slot rather than building a parallel panel; the source's
  metadata/lineage already come from `inspector.get` (T010). The kit's "References cited" /
  private "Notes" sections are nice-to-have polish — defer if not backed by data yet.

---

## Exit criteria for M3

- All of T015–T018 are `[x]` in [`../roadmap.md`](../roadmap.md), each with its commit ref.
- A source body **renders and edits** in the constrained Tiptap editor and **persists + reloads**
  through `window.appApi.documents.*` → `DocumentRepository` (with `update_document` op-log
  entries).
- Every block carries a **stable ULID block ID** that is **preserved** across edits, saves, and
  re-imports (distinct from the `document_blocks.id` surrogate PK), and is queryable as
  `stableBlockId` — the anchor M4 extraction and M11 sync depend on.
- **Read-points** can be set/jumped/resumed (one per element, `set_read_point` logged), with the
  auto-advance-on-extract seam reserved for T021.
- `/source/$id` is a real reading workspace matching `screen-reader.jsx` in light + dark, and the
  edit→reload and reopen→resume-at-read-point flows pass under Playwright.
- The renderer never touches SQLite/Node/fs; every new capability is a narrow typed
  `window.appApi` command (`documents.get/save`, `readPoints.get/set`) with validated IPC.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the relevant `pnpm e2e` are green; the feature
  survives **app restart**.

When M3 is complete, generate `tasks/M4-extraction.md` from the roadmap before
starting T019. M4 builds the selection toolbar, highlights, extraction, source-locations,
sub-extracts, and processed-span collapse on top of the stable block IDs + read-points landed
here.
