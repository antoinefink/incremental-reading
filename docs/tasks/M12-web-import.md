# M12 — Local-first web import (T060–T061)

Detailed, buildable specs for the **Import by URL** milestone. After these two tasks the app
can take a source in from the live web entirely **locally**: the user pastes a URL into the
existing inbox import strip, the **Electron main process** fetches the page, runs Mozilla
Readability over a DOM, sanitizes the article HTML, writes BOTH `original.html` and
`cleaned.html` into the filesystem asset vault, converts the cleaned article into the
constrained ProseMirror document (with stable block ids), and creates an **inbox** source
carrying title/byline/canonicalUrl/originalUrl/accessedAt/snapshotKey — through the SAME
source pipeline manual import already uses (transactional, `operation_log`-logged). T061 then
makes that import **dedup-aware**: URLs are canonicalized, already-imported canonical URLs and
content-hash duplicates are detected, and a re-import returns a structured "reuse or new
version" result the renderer/extension surface.

> **Re-scope vs. the original roadmap line.** Per the already-updated roadmap, T058 is a
> **local background runner** (an Electron utility process / `worker_threads` queue — NOT
> pg-boss, NOT a server worker) and T059 is **local asset-vault scaling for large media** (NOT
> app-level S3). T060/T061 are built **local-first** and simply do **not** block on those
> (now-local) infra tasks: the MVP is a **local-first Electron desktop app on native SQLite**
> with a **filesystem asset vault** — there is no Postgres, no worker, no S3, no auth in scope.
> **URL import is therefore built local-first, in the Electron main process, against the
> EXISTING `window.appApi` + asset-vault stack** (`SourceRepository.createWithDocument`,
> `AssetRepository`, `canonicalizeUrl`). The fetch + snapshot-write happens synchronously in
> the main process (no job queue) — there is no background-runner prerequisite; a runner-backed
> async pipeline is a later optimization, not a blocker. This re-scope is the whole point of
> doing M12 now: it lights up real web import without waiting on any further infra. Record the
> re-scope in the Progress log when T060 lands.

Everything here obeys the established architecture (see [`../../CLAUDE.md`](../../CLAUDE.md)):
the React renderer (`apps/web`) calls the narrow typed `window.appApi` bridge; the Electron
main process (`apps/desktop`) validates the IPC payload (Zod) and routes to the
`packages/local-db` repositories + a NEW pure-transform package; the multi-table mutation runs
in one SQLite transaction and appends `operation_log` entries; the asset bytes go to the
filesystem vault via `AssetRepository`, never SQLite; the renderer never touches Node, the
network, the filesystem, or SQLite. **The fetch + Readability + sanitize + snapshot-write all
run in the Electron main process** — never the renderer.

Read first:
- [`../architecture.md`](../architecture.md) — the asset-vault layout
  (`assets/sources/<source_id>/ original.html, cleaned.html, snapshot.json`, line ~173) and the
  "Mozilla Readability for article extraction" note (line ~83).
- [`../domain-model.md`](../domain-model.md) — `Source` provenance row (`canonical_url`,
  `original_url`, `accessed_at`, `snapshot_key`), the `inbox` status, the `raw_source` stage,
  and the operation-log shapes.
- [`../design-system.md`](../design-system.md) and the kit inbox screen
  [`../../design/kit/app/screen-inbox.jsx`](../../design/kit/app/screen-inbox.jsx) — the import
  strip whose **"Paste URL"** chip is already present (disabled "coming soon" in M2); M12 wires
  it up. Do NOT invent a new screen.
- The closest analog spec: [`M2-capture-and-inbox.md`](./M2-capture-and-inbox.md) — match its
  structure, depth, and "Done when"/deliverables/tests style. M12 is the auto-fetch follow-on
  M2 explicitly deferred ("Auto-fetch / Readability / snapshot capture is deferred to M12
  (T060)", "canonical-URL duplicate detection to M12 (T061)").
- Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md). Format/depth exemplar:
  [`M2-capture-and-inbox.md`](./M2-capture-and-inbox.md).

What already exists (confirmed by inspecting the repo — **do not rebuild these**):
- **`SourceRepository.createWithDocument(input)`** in
  [`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts)
  creates the `source` element + `sources` provenance row + `documents` body + stable
  `document_blocks`, all in ONE transaction, logging `create_element` + `create_source` +
  `update_document`. `CreateSourceWithDocumentInput` already accepts `title`, `priority`,
  `status`, `stage`, `url`, `canonicalUrl`, `originalUrl`, `author`, `publishedAt`,
  `accessedAt`, `snapshotKey`, `reasonAdded`, and `body` (raw text). **This is the convergence
  point.** It currently takes a raw text `body` and runs `plainTextToProseMirrorDoc` itself —
  T060 must thread a *pre-built ProseMirror doc* through it (see T060 deliverables).
- **`AssetRepository`** in
  [`../../packages/local-db/src/asset-repository.ts`](../../packages/local-db/src/asset-repository.ts):
  `create(input)` inserts metadata only (owning element, kind, `vaultRoot`, `relativePath`,
  `contentHash`, `mime`, `size`); `findByContentHash(hash)` is the dedup lookup (the prompt
  called it `findByHash`); `listForElementByKind(id, kind)`. `AssetKind` includes
  **`source_html`** and `snapshot`; `VaultRoot` includes `assets`
  ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts)). **The repository
  writes NO bytes** — the main process writes the file then records metadata.
- **`canonicalizeUrl(raw): string | null`** in
  [`../../packages/core/src/url.ts`](../../packages/core/src/url.ts) — the conservative
  normalizer T014 built *specifically for T061 to reuse* ("anything heavier … is intentionally
  left to the M12 duplicate-detection work (T061), which will REUSE this function"). Strips
  `utm_*`/`fbclid`/`gclid`/etc., drops the fragment, lowercases host, trims trailing slash.
- **`plainTextToProseMirrorDoc(text)`** in
  [`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts) and its
  `ProseMirrorDoc`/`ProseMirrorParagraphNode`/`ProseMirrorBlock` types + injectable
  `BlockIdMinter`. **These types are paragraph-ONLY today** (`ProseMirrorDoc.content` is
  `readonly ProseMirrorParagraphNode[]`; `ProseMirrorBlock.blockType` is the literal `"paragraph"`),
  so T060 must FIRST widen them (see the "Widen the core ProseMirror conversion types" deliverable)
  before T060's HTML→PM converter can produce the SAME `PlainTextConversion` `{ doc, plainText,
  blocks }` shape `createWithDocument` stores (paragraphs/headings/lists/blockquotes/code, each with
  a stable `blockId` attr — see below).
- **The constrained editor schema** in
  [`../../packages/editor/src/schema.ts`](../../packages/editor/src/schema.ts)
  (`ALLOWED_NODE_NAMES` = doc/text/paragraph/heading/blockquote/bulletList/orderedList/listItem
  /codeBlock/horizontalRule/hardBreak; `ALLOWED_MARK_NAMES` = bold/italic/link/code) and the
  stable-block-id rules in
  [`../../packages/editor/src/block-id.ts`](../../packages/editor/src/block-id.ts)
  (`shouldCarryBlockId`, `BLOCK_ID_NODE_TYPES`, the strictly-additive filler, one id per row).
  **The doc T060 produces MUST validate against `buildSchema()` and carry a `blockId` attr on
  exactly the outermost block of each row.**
- **The IPC seam**: shared contract
  [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts)
  (the `sources` group ~line 2501, `SourcesImportManualRequestSchema` ~line 770,
  `InboxItemSummary`/`SourceProvenance`), channels
  [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts)
  (`sourcesImportManual`), router
  [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts), DB service
  [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts)
  (`importManualSource`, ~line 599), preload
  [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts), and the
  renderer client [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts).
- **The app-data paths + vault skeleton** in
  [`../../apps/desktop/src/main/paths.ts`](../../apps/desktop/src/main/paths.ts) (`AppPaths`
  with `assetsDir`; `ensureVaultSkeleton` already makes `assets/sources/`). The backup handler
  already threads `paths` into IPC via `IpcHandlerContext`
  ([`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts) ~line 81) — URL
  import reuses that mechanism to get `assetsDir`.
- **A main-side vault-writer + hash model**: `BackupService` +
  [`../../apps/desktop/src/main/backup-manifest.ts`](../../apps/desktop/src/main/backup-manifest.ts)
  (`sha256(bytes)`, `sha256File(path)` via `node:crypto`) show exactly how the main process
  writes files under the data dir and content-hashes them. Mirror this for snapshot writes.
- **The import strip** in
  [`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx):
  `IMPORT_OPTS` already has `{ icon: "link", label: "Paste URL", hint: "Fetch & clean — coming
  soon" }` (disabled). The `NewSourceModal`
  ([`../../apps/web/src/pages/inbox/NewSourceModal.tsx`](../../apps/web/src/pages/inbox/NewSourceModal.tsx))
  is the dialog pattern to mirror for the URL prompt.

What is **missing** and this milestone adds:
- A NEW pure-transform package, **`@interleave/importers`** (`packages/importers/`), holding
  the framework-agnostic, fixture-testable transforms: HTML → readable article → constrained
  ProseMirror doc, plus dedup helpers (content hashing, URL-key derivation). It depends on
  `@interleave/core` and `@interleave/editor` (for the schema/block-id contract) but **NOT** on
  Electron, `fs`, or the network — the orchestrating service (fetch, vault write, DB
  transaction) stays main-side. (This matches `architecture.md`'s planned
  `packages/importers/` "Readability, PDF, EPUB … import logic".) **Bundling caveat (see the
  "Editor import surface" deliverable + Bundling risk):** `@interleave/importers` needs only the
  React-free schema/block-id modules from `@interleave/editor`, but that package's barrel
  (`src/index.ts`) ALSO re-exports `SourceEditor` (which imports `@tiptap/react` + `react`) and the
  package has **no `"sideEffects": false`** flag and **no schema sub-path export** — so a barrel
  import (`from "@interleave/editor"`) risks pulling React/@tiptap-react into the esbuild `main.cjs`
  bundle. M12 MUST establish a React-free schema/block-id import surface (below) — do not assume the
  barrel tree-shakes cleanly.
- A main-side **`UrlImportService`** in `apps/desktop/src/main/` that orchestrates: fetch (Node
  `fetch`/undici) → Readability-over-DOM (via the importers package) → sanitize → write
  `original.html` + `cleaned.html` to the vault + record `AssetRepository` metadata → HTML→PM
  → `createWithDocument`. This is the SHARED seam M13's loopback server will also call.
  **Naming/wiring contract (binding on M13 too):** the service is named **`UrlImportService`**,
  lives in `apps/desktop/src/main/url-import-service.ts`, composes the pure
  **`@interleave/importers`** package, and takes its paths/deps (the open DB + `assetsDir`) at
  **construction time** — NOT a per-call `ctx`. M13's loopback server receives the
  already-constructed `importService`, so both callers (the IPC handler and the loopback handler)
  share one fully-built instance. (M13's "Upstream dependency" section restates this exact
  contract verbatim.)
- New `window.appApi.sources.importUrl(...)` surface (channel + Zod schema + result, preload +
  ipc + db-service wiring).
- The dedup index + lookup query (T061), and the migration that adds the canonical-URL index.
- The renderer "Import from URL" affordance — wiring the EXISTING "Paste URL" chip to a small
  URL-prompt dialog + a re-import "reuse or new version" choice.

Build order is the task order; **T061 depends on T060** (it makes T060's import dedup-aware).

---

## T060 — Automatic URL import (local-first)

- **Status:** `[ ]`  · **Depends on:** T013, T015, T016, T047
  (re-scoped off T058/T059 — see the milestone note; the real deps are the source+document
  pipeline, the constrained editor schema, stable block ids, and the main-side vault-write
  pattern the backup task established)
- **Roadmap line:** Done when URL import fetches the page, runs Readability, stores the original
  snapshot + cleaned HTML, converts to ProseMirror JSON, and creates a source.

### Goal

A user pastes a URL into the inbox import strip and the app imports the live web page **fully
locally**. The Electron **main process** fetches the page (following redirects, with a timeout
and a body-size cap), extracts the readable article with Mozilla Readability over a DOM,
sanitizes the article HTML to the constrained tag set, writes BOTH the raw `original.html` and
the cleaned `cleaned.html` into the filesystem asset vault under
`assets/sources/<source_id>/` (recording content-hashed `AssetRepository` metadata), converts
the cleaned article into the constrained ProseMirror document (headings/paragraphs/lists/
blockquotes/code with **stable block ids**), and creates an **inbox** `source` carrying the
extracted title, byline (author), `originalUrl`/`canonicalUrl`, the auto-stamped `accessedAt`,
and the `snapshotKey` pointing at `cleaned.html` — through the existing source pipeline, in one
transaction, appending the right `operation_log` entries. The new source appears in the inbox
list immediately and survives an app restart. The renderer never runs the fetch, never builds
the doc, and never touches the vault.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) (asset-vault layout + Readability note),
  [`../domain-model.md`](../domain-model.md) (`Source` provenance, `inbox`/`raw_source`),
  [`../design-system.md`](../design-system.md) + the kit import strip.
- Existing code to inspect: `SourceRepository.createWithDocument` +
  `CreateSourceWithDocumentInput`
  ([`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts)),
  `AssetRepository` ([`../../packages/local-db/src/asset-repository.ts`](../../packages/local-db/src/asset-repository.ts)),
  `plainTextToProseMirrorDoc` + the `ProseMirror*` types
  ([`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts)),
  `canonicalizeUrl` ([`../../packages/core/src/url.ts`](../../packages/core/src/url.ts)),
  `buildSchema`/`ALLOWED_NODE_NAMES`/`ALLOWED_MARK_NAMES`
  ([`../../packages/editor/src/schema.ts`](../../packages/editor/src/schema.ts)),
  `shouldCarryBlockId`/`BLOCK_ID_NODE_TYPES`/`newBlockId`
  ([`../../packages/editor/src/block-id.ts`](../../packages/editor/src/block-id.ts) +
  `block-ids.ts`), the IPC seam files, `AppPaths`/`assetsDir`
  ([`../../apps/desktop/src/main/paths.ts`](../../apps/desktop/src/main/paths.ts)), the
  `IpcHandlerContext` paths plumbing
  ([`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts) ~line 81), and the
  `sha256`/`sha256File` helpers
  ([`../../apps/desktop/src/main/backup-manifest.ts`](../../apps/desktop/src/main/backup-manifest.ts)).
- Invariants in play: renderer never touches network/SQL/fs; the fetch + Readability + sanitize
  + vault write all run **main-side**; the multi-table mutation is one transaction + logged;
  source lineage is preserved (a URL source is a clean lineage root with a body + a snapshot);
  asset bytes live in the vault (never SQLite); the produced doc validates against the
  constrained schema and carries stable block ids; new material defaults to a **non-dominating**
  priority (`C`).

### Dependencies to add (concrete, justified)

Add to **`packages/importers`** (pure transform — bundled into `main.cjs` by esbuild, which
bundles everything except `electron`/`bindings`/`prebuild-install`, so deps must be pure-JS):
- **`@mozilla/readability`** — the canonical article-extraction algorithm (the same one
  `architecture.md` names). Pure JS; operates on a `Document`. It needs a DOM but does not ship
  one.
- **`linkedom`** — a fast, pure-JS, dependency-light DOM (`parseHTML`) for headless Node.
  Chosen over **`jsdom`**: jsdom drags in a large, partly-native-leaning dependency tree
  (canvas/vm/whatwg-* stacks) that bloats and complicates the esbuild main bundle, while
  `linkedom` is a small pure-JS module that bundles cleanly and gives Readability the
  `Document` it needs. (If a fixture proves Readability needs a jsdom-only DOM feature, fall
  back to `jsdom` with `asarUnpack` notes — but default to linkedom.)
- **`sanitize-html`** — an allowlist HTML sanitizer that runs on an HTML *string* (via the
  pure-JS `htmlparser2`), needing **no** `window`/DOM global. Chosen over a `DOMPurify`-on-
  linkedom setup because it does not require wiring a DOM window into the bundle and its
  allowlist maps 1:1 to our constrained tag set. Configure it to allow ONLY the tags the
  constrained schema can represent (see the HTML→PM mapping below) and to drop everything else
  (scripts, styles, iframes, event handlers, `javascript:` URLs).

Declare these in `packages/importers/package.json` `dependencies` and add `@interleave/core` +
`@interleave/editor` as workspace deps. The three pure-JS deps above bundle cleanly; the
`@interleave/editor` dep is the one bundling caveat — import only its React-free schema/block-id
modules through the surface the "React-free editor import surface" deliverable establishes, NOT the
barrel that re-exports `SourceEditor`/React (see Bundling risk). **Do not** add a network/HTTP
library — use the Node global `fetch` (Electron 38 ships Node 22, which has stable global
`fetch`/undici); `fetch` lives only in the main-side `UrlImportService`, never in the importers
package (keep it pure).

### Deliverables

- [ ] **Widen the core ProseMirror conversion types (prerequisite — they are paragraph-only
      today).** The existing `@interleave/core` types in
      [`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts) are
      paragraph-only: `ProseMirrorDoc.content: readonly ProseMirrorParagraphNode[]` and
      `ProseMirrorBlock.blockType: "paragraph"`. A heading/list/blockquote/codeBlock doc does NOT
      satisfy `PlainTextConversion` as currently typed, so `htmlToProseMirrorDoc` (and the
      pre-built `conversion` threaded through `createWithDocument`) would not typecheck. Widen the
      core types to a constrained-but-richer shape that BOTH converters produce:
      - Introduce a richer `ProseMirrorNode` union (`paragraph` | `heading` (with `attrs.level: 1|2|3`)
        | `blockquote` | `bulletList` | `orderedList` | `listItem` | `codeBlock` | `horizontalRule`,
        plus inline `text`/`hardBreak` + marks `bold`/`italic`/`link`/`code`) so
        `ProseMirrorDoc.content` admits the full constrained node set (mirroring
        `ALLOWED_NODE_NAMES`/`ALLOWED_MARK_NAMES`/`ALLOWED_HEADING_LEVELS`), and widen
        `ProseMirrorBlock.blockType` from the literal `"paragraph"` to the constrained block-type
        enum (`"paragraph" | "heading" | "blockquote" | "listItem" | "codeBlock" | …` — the
        row-bearing node types per `BLOCK_ID_NODE_TYPES`).
      - Keep `PlainTextConversion = { doc, plainText, blocks }` as the SINGLE shared result type
        BOTH `plainTextToProseMirrorDoc` (which still only emits paragraphs) and `htmlToProseMirrorDoc`
        return — widening the member types is backward-compatible (the paragraph-only converter still
        satisfies the wider union). (Naming the wider type `PlainTextConversion` is now a slight
        misnomer; an optional rename to `DocumentConversion` with a `PlainTextConversion` alias is
        acceptable but not required — if renamed, update every importing call site + the
        `createWithDocument` `conversion` field.)
      - `@interleave/core` must stay editor-free (no ProseMirror/Tiptap import) — these are plain TS
        interfaces, exactly as today. Update `prosemirror.ts`'s own tests for the wider shape
        (`prosemirror.test.ts` exists).
      - **Downstream consumers to verify (widening is non-breaking for all of them, but name them so a
        builder checks them — and so an optional `DocumentConversion` rename's "update every call site"
        is genuinely complete):** `PlainTextConversion`/`ProseMirrorDoc`/`ProseMirrorBlock` are
        re-exported from [`../../packages/core/src/index.ts`](../../packages/core/src/index.ts) (~lines
        133-142) and consumed by `packages/local-db/src/extraction-service.ts` (reads
        `conversion.blocks[].blockType` at ~lines 165-166 / 218 and passes it through to a text column —
        the wider union still satisfies it) and `packages/testing/src/factories.ts` (constructs blocks
        with `blockType: "paragraph"` at ~lines 55-58 — the `"paragraph"` literal still satisfies the
        wider union). No code change is needed in these for a pure widening; a rename to
        `DocumentConversion` would require updating their imports too.
- [ ] **New package `@interleave/importers`** (`packages/importers/`) with `package.json`,
      `tsconfig.json`, `src/index.ts`, and (mirroring sibling packages) a Vitest config. It
      exports the PURE transforms below and is added to the workspace + to
      `apps/desktop`'s deps so the bundler pulls it in.
  - [ ] **`extractArticle(html: string, opts: { url: string }): ExtractedArticle`** in
        `packages/importers/src/readability.ts`. Parses `html` with `linkedom`'s `parseHTML`,
        runs `@mozilla/readability`'s `Readability(doc).parse()`, and returns
        `{ title: string | null; byline: string | null; lang: string | null; contentHtml:
        string; excerpt: string | null; siteName: string | null }` (the article's *raw*
        readable HTML, pre-sanitize). When Readability returns `null` (not an article),
        `contentHtml` is `""` and `title`/`byline` are `null` — the caller decides the fallback
        (see edge handling). No network, no `fs`.
  - [ ] **`sanitizeArticleHtml(html: string): string`** in
        `packages/importers/src/sanitize.ts`. Runs `sanitize-html` with an allowlist covering
        ONLY: `h1`–`h6`, `p`, `blockquote`, `ul`, `ol`, `li`, `pre`, `code`, `hr`, `br`, `a`
        (only `href`, only `http(s)`/`mailto`), `strong`/`b`, `em`/`i`. Drops all other tags
        (keeping inner text), all `class`/`id`/`style`/`on*` attributes, all
        `script`/`style`/`iframe`/`img`/`svg`/`form` (images are deferred to M14/M15 —
        keep their alt text or drop). Returns the cleaned HTML string. Pure.
  - [ ] **`htmlToProseMirrorDoc(html: string, mint?: BlockIdMinter): PlainTextConversion`** in
        `packages/importers/src/html-to-prosemirror.ts`. Parses the SANITIZED HTML (linkedom)
        and walks it into the SAME `{ doc, plainText, blocks }` `PlainTextConversion` shape
        `plainTextToProseMirrorDoc` returns — **using the WIDENED core types** (see the "Widen the
        core ProseMirror conversion types" deliverable above; the doc must admit the full
        constrained node set, not just paragraphs), mapping:
        - `h1`/`h2`/`h3` → `heading` (level 1–3; clamp `h4`–`h6` to 3 per `ALLOWED_HEADING_LEVELS`);
          `p` → `paragraph`; `blockquote` → `blockquote`; `ul` → `bulletList`, `ol` →
          `orderedList`, `li` → `listItem`; `pre`/`code`-block → `codeBlock`; `hr` →
          `horizontalRule`. Inline `strong`/`em`/`a`/`code` → the `bold`/`italic`/`link`/`code`
          marks.
        - Assign a stable `blockId` (default minter = `newBlockId` from `@interleave/editor`,
          injectable for tests) to exactly the **outermost block of each row**, obeying
          `shouldCarryBlockId` / `BLOCK_ID_NODE_TYPES` (id on `listItem`/`blockquote`, NOT the
          inner paragraph; never on `bulletList`/`orderedList` containers). Emit the parallel
          `blocks` list (`{ blockType, order, stableBlockId }`) for the row-bearing nodes so
          `document_blocks` mirrors the doc — exactly like `plainTextToProseMirrorDoc`.
        - `plainText` is the flattened text mirror (paragraph text joined with blank lines) for
          search/preview.
        - **The output MUST validate against `buildSchema()`** — add an assertion in tests that
          `Node.fromJSON(buildSchema(), result.doc)` does not throw and that every node name is
          in `ALLOWED_NODE_NAMES` / every mark in `ALLOWED_MARK_NAMES`.
        - Empty/garbage HTML → a valid empty doc (`{ type: "doc", content: [] }`), empty
          `plainText`, zero blocks (never an invalid document).
- [ ] **React-free editor import surface (bundling-critical).** `@interleave/importers` must
      consume ONLY the React-free schema/block-id modules from `@interleave/editor` —
      `buildSchema`/`ALLOWED_NODE_NAMES`/`ALLOWED_MARK_NAMES`/`ALLOWED_HEADING_LEVELS` (`schema.ts`),
      `newBlockId`/`BlockIdMinter` (`block-ids.ts`), and
      `shouldCarryBlockId`/`BLOCK_ID_NODE_TYPES` (`block-id.ts`) — WITHOUT dragging
      `SourceEditor` → `@tiptap/react` → `react` into the esbuild `main.cjs` bundle (the barrel
      `@interleave/editor/src/index.ts` re-exports `SourceEditor`). Pick ONE and document it:
      **(a)** add a `"sideEffects": false` flag to `packages/editor/package.json` so esbuild can
      tree-shake the unused `SourceEditor`/React surface out of a barrel import (verify the editor's
      modules are genuinely side-effect-free — they are pure schema/helpers — and that
      `pnpm --filter @interleave/desktop build` succeeds and produces a `main.cjs` with no `react`/
      `@tiptap/react` in it); OR **(b)** add a React-free **sub-path export** to
      `packages/editor/package.json` `exports` (e.g. `"./schema"` → `./src/schema.ts`, `"./block-id"`
      → `./src/block-id.ts`, `"./block-ids"` → `./src/block-ids.ts`) and import the schema/block-id
      contract from those deep paths in `@interleave/importers`, never the barrel. Prefer **(a)** if
      verified clean (smallest change); fall back to **(b)** if the bundle still pulls React. Either
      way, add a check (in the bundling-risk note's verify step) that the packaged `main.cjs` does
      NOT contain `@tiptap/react`/`react-dom`. This is a prerequisite for the importers package to
      "bundle cleanly" — the earlier claim is only true once this surface exists.
- [ ] **Thread a pre-built doc through the source pipeline.** Extend
      `CreateSourceWithDocumentInput`
      ([`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts))
      so a caller may pass a **pre-built `conversion: PlainTextConversion`** (the WIDENED
      `{ doc, plainText, blocks }` type — see the core-types deliverable — already computed by the
      importer) INSTEAD of a raw `body` string. `createWithDocument` stores the supplied doc /
      plainText / blocks verbatim (no re-conversion) and only falls back
      to `plainTextToProseMirrorDoc(body)` when it is not. This keeps HTML→PM conversion in the
      importers package (the layering rule — no editor/DOM work in `local-db`) while reusing the
      exact same atomic transaction (element + sources + documents + document_blocks + the
      `create_element`/`create_source`/`update_document` ops). Add a unit test that the
      pre-built path stores the supplied doc/plainText/blocks verbatim.
- [ ] **Thread the pre-minted source id through `createWithDocument`.** The `UrlImportService`
      mints the source id up front (step 2 below) so the vault path `assets/sources/<source_id>/`
      is known before the row exists — but `CreateSourceWithDocumentInput` (source-repository.ts
      ~lines 73-76) has **no `id` field** and `createWithDocument` calls `elementsRepo.createWithin(tx,
      {…})` (source-repository.ts ~lines 185-193) WITHOUT forwarding any id, so there is currently no
      way to pass it through. `ElementRepository.CreateElementInput` already supports an optional `id`
      (element-repository.ts ~lines 63-65, applied as `input.id ?? newElementId()` at ~line 106), so
      the mechanism exists at the element layer. Extend `CreateSourceWithDocumentInput` with a
      `readonly id?: ElementId` and forward it into the `createWithin` call (`id: input.id`), so the
      created element adopts the pre-minted id. Without this the id-up-front vault path is
      impossible. (Mirror the same `id?` on `CreateSourceInput`/`create` only if a caller needs it;
      the URL-import path goes through `createWithDocument`.) Add a unit test that a supplied `id` is
      adopted by the created source element.
- [ ] **Make the source + asset inserts atomic (tx-composable seam — required for "no orphan
      source/asset/file").** Today neither side composes into an outer transaction: `AssetRepository.create`
      uses `this.db.insert(...)` directly (asset-repository.ts ~lines 42-65), NOT a passed `tx`, so it
      cannot enroll in an outer transaction; and `SourceRepository.createWithDocument` opens its OWN
      internal `this.db.transaction` (source-repository.ts ~line 184) and returns, so there is no
      `createWithDocumentWithin(tx, …)` seam to compose the asset inserts into. To get real atomicity
      (snapshot files written, then BOTH the source rows AND the two `source_html` asset rows committed
      together, or all rolled back), add BOTH tx-composable seams — mirroring the existing
      `SourceRepository.createExtractWithin(tx, input)` pattern (source-repository.ts ~lines 287-342):
      - `AssetRepository.createWithin(tx: DbClient, input: CreateAssetInput): Asset` — the same body as
        `create` but inserting on the passed `tx` (keep `create` as
        `db.transaction((tx) => this.createWithin(tx, input))`).
      - `SourceRepository.createWithDocumentWithin(tx: DbClient, input): SourceWithDocument` — the body of
        the current `createWithDocument` lifted to run on a passed `tx` (keep `createWithDocument` as
        `db.transaction((tx) => this.createWithDocumentWithin(tx, input))` so the existing single-call
        path is unchanged).
      Then the `UrlImportService` wraps `createWithDocumentWithin(tx, …)` + the two
      `asset.createWithin(tx, …)` calls in ONE `db.transaction` so the source, document, blocks, asset
      rows, and their ops commit (or roll back) as a unit. Add a unit test that a thrown error during the
      asset insert rolls back the source row too (no orphan).
- [ ] **Main-side `UrlImportService`** in `apps/desktop/src/main/url-import-service.ts`. It is
      constructed with its dependencies — the open DB / repositories and the vault `assetsDir`
      (and any other paths) — injected at construction time (`new UrlImportService({ db,
      repositories, assetsDir })`), so a single built instance is shared by the IPC handler AND
      M13's loopback handler. Public:
      `importFromUrl(input: { url: string; priority?: PriorityLabel; reasonAdded?: string | null;
      forceNewVersion?: boolean }): Promise<UrlImportResult>` (single `input` arg — no per-call
      `ctx`; `assetsDir` came in at construction). `UrlImportResult` is the discriminated
      `{ status: "imported"; id; item } | { status: "duplicate"; matches }` shape (T061 adds the
      `"duplicate"` arm; T060 always returns `status: "imported"`). Steps:
  1. **Fetch** with the Node global `fetch`: follow redirects (capture the FINAL url for
     `canonicalUrl` derivation and the entered url for `originalUrl`), apply an
     `AbortController` **timeout** (e.g. 15s), reject non-`http(s)` schemes, reject
     non-HTML `Content-Type` (read the header; allow `text/html`/`application/xhtml+xml`),
     and **cap the body size** (e.g. 8 MB — stream/measure and abort if exceeded) so a hostile
     URL cannot exhaust memory. Set a desktop `User-Agent`. On any network failure / non-2xx /
     timeout / oversize / non-HTML, throw a typed `UrlImportError` with a `code`
     (`fetch_failed` / `timeout` / `not_html` / `too_large` / `http_error` / `blocked_host`) the
     IPC layer maps to a friendly message.
     - **SSRF / redirect guard (required, testable).** Before fetching the body, reject any URL
       — and any URL the redirect chain RESOLVES to (re-check the FINAL url, not just the entered
       one) — whose scheme is not `http`/`https`, OR whose host resolves to a loopback / link-local
       / private range: `127.0.0.0/8`, `::1`, `169.254.0.0/16`, and the RFC1918 private ranges
       (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`). Throw `UrlImportError { code:
       "blocked_host" }`. This is **low-risk locally** (the import is user-initiated and, for M13,
       token-gated), but it is now a network-reachable surface (the same service is called from
       M13's loopback capture server), so make it a **concrete requirement with a unit test**, not
       optional prose. (A pure host-classification helper — `isBlockedImportHost(host): boolean` —
       is the unit-testable seam; the fetch checks both the entered and the redirected host.)
  2. **Mint the source id up front** (so the vault path `assets/sources/<source_id>/` is known
     before the DB row exists — generate it with the same id minter the element repo uses, and
     pass it into `createWithDocument` so the element adopts it). *Alternatively* create the
     source first, then write assets keyed by the returned id, then update `snapshotKey` — but
     prefer the up-front id so the whole thing is one transaction with the snapshot key already
     set. Pick ONE and document it; the id-up-front path is preferred.
  3. **`extractArticle` → `sanitizeArticleHtml` → `htmlToProseMirrorDoc`** (all from the
     importers package).
  4. **Write snapshots to the vault**: create `assets/sources/<source_id>/`, write
     `original.html` (the raw fetched bytes) and `cleaned.html` (the sanitized article HTML),
     content-hash each with `sha256File`, and record asset metadata for both via the
     **`AssetRepository.createWithin(tx, …)`** seam (added above) on the same transaction as the
     source insert (kind `source_html`, `vaultRoot: "assets"`, `relativePath:
     "sources/<source_id>/original.html"` / `".../cleaned.html"`, the mime, the size). The
     `sources.snapshotKey` is set to the cleaned-HTML relative path. **Bytes never touch
     SQLite.** **Dedup note (for T061):** BOTH `original.html` and `cleaned.html` are recorded as
     `source_html` assets on the SAME source, so their content hashes both live in `assets`; the
     T061 snapshot-hash dedup query MUST disambiguate which one it is matching (see
     `findSourceBySnapshotHash` in T061) — it dedups on the **`cleaned.html`** hash specifically,
     so the cleaned-HTML relative path (`sources/<id>/cleaned.html`) is the criterion that resolves
     the correct owning source.
  5. **Create the source** via `createWithDocument` with `status: "inbox"`, `stage:
     "raw_source"`, the extracted `title` (fallback: the page `<title>`, then the host), the
     extracted `byline` → `author`, `url` = final url, `originalUrl` = entered url,
     `canonicalUrl = canonicalizeUrl(finalUrl)`, auto-stamped `accessedAt`, the `snapshotKey`,
     the pre-built `conversion`, and the priority label (default `C`). The asset-metadata
     inserts MUST run inside the **same** transaction as `createWithDocument` via the
     tx-composable seam added below (the "Make the source+asset insert atomic" deliverable) so a
     failure leaves NO orphan source/asset/file. (If a file was written but the transaction rolls
     back, best-effort unlink the partial `assets/sources/<source_id>/` dir; note this in code.)
  6. Return `{ status: "imported", id, item: InboxItemSummary }` (the fresh inbox summary, like
     `importManualSource`). T060 always returns the `"imported"` arm; T061 adds the `"duplicate"`
     arm to this same discriminated `UrlImportResult`.
- [ ] **`importFromHtml` capture entry point (M12 OWNS this — not deferred).** Add a second public
      method `importFromHtml(input: { url: string; html: string; title?: string | null; priority?:
      PriorityLabel; reasonAdded?: string | null; accessedAt?: string | null; forceNewVersion?:
      boolean }): Promise<UrlImportResult>` to `UrlImportService`. It SKIPS step 1 (the fetch) and
      runs the identical step 2–6 pipeline over the supplied `html` (raw HTML → `original.html`;
      `extractArticle` → `sanitizeArticleHtml` → `htmlToProseMirrorDoc` → vault write →
      `createWithDocument`). This is the entry point M13's extension "save page" path calls (the
      worker already has the rendered DOM, which gets past paywalls/JS the bare `fetch` cannot).
      Implement `importFromUrl` and `importFromHtml` so the shared step 2–6 body is a single
      private helper both call (one fetches first, one is handed the bytes) — they must produce
      IDENTICAL sources. **M12 lands this now; M13 does not add it.** Add a service test that an
      `importFromHtml` over a fixture HTML lands the same source shape as `importFromUrl` would for
      that HTML (without any network call).
- [ ] **IPC contract** in
      [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts):
  - `SourcesImportUrlRequestSchema = z.object({ url: z.string().trim().min(1).max(2048),
    priority: PriorityLabelSchema.optional(), reasonAdded: z.string().trim().max(2048)
    .optional() })` and its `SourcesImportUrlRequest` type.
  - `SourcesImportUrlResult` is the SAME discriminated shape as the service's `UrlImportResult`,
    so the IPC result and the service result never diverge: at T060 land the `"imported"` arm
    `{ status: "imported"; id: string; item: InboxItemSummary }` (always); T061 adds the
    `{ status: "duplicate"; matches }` arm (see T061). (Defining it discriminated from the start
    avoids a breaking shape change in T061.)
  - Add `importUrl(request): Promise<SourcesImportUrlResult>` to the `AppApi` `sources` group
    (~line 2501).
- [ ] **Channel** `sourcesImportUrl: "sources:importUrl"` in
      [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts).
- [ ] **IPC handler** in [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts):
      `ipcMain.handle(IPC_CHANNELS.sourcesImportUrl, async (_e, rawRequest) => …)` that
      `SourcesImportUrlRequestSchema.parse(rawRequest)`-es and `await`s
      `dbService.importFromUrl(request)`. **The handler MUST be `async`/await** because
      `importFromUrl` does network I/O (unlike the synchronous inbox handlers like
      `importManualSource`) — mirror the existing async `backupsCreate` handler
      ([`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts) ~line 398,
      `ipcMain.handle(IPC_CHANNELS.backupsCreate, async () => { … await … })`), NOT the sync
      source handlers. The vault path is NOT threaded per-call: the `UrlImportService` is built
      once in the DB service with `assetsDir` already injected at `open()`/`setPaths()` time (see
      the DB-service deliverable — `assetsDir` is threaded into `DbService`, NOT handed in per
      request), so this handler is a thin adapter that only parses + awaits `dbService.importFromUrl`.
      (`bootstrap()` supplies `paths.assetsDir` to `DbService` once at startup — the same value the
      `IpcHandlerContext` already carries for the backup handler; if `context` is absent in the
      contract-only test harness, the handler may be skipped there as backup is.)
- [ ] **DB-service method + `assetsDir` threading + public accessor** in
      [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts).
      `DbService.open(dbPath, options)` currently receives only `{ migrationsDir, nativeBinding }`
      (db-service.ts ~line 223) and constructs every service from `this.handle.db` alone — there is
      **no filesystem path in `DbService` today**, and `assetsDir` lives only in `bootstrap()`'s
      `paths` (index.ts ~line 49), reaching just the IPC layer via
      `registerIpcHandlers(dbService, { paths, migrationsDir })` (index.ts ~line 88). The URL import
      service needs the vault `assetsDir` at construction, so **thread it into `DbService`** — pick
      ONE and make it the deliverable:
      - **(a, preferred)** extend `DbService.open(dbPath, options)` to accept an `assetsDir?: string`
        in its `options` bag, store it on the instance, and pass it when constructing the
        `UrlImportService`. `bootstrap()` already has `paths.assetsDir`, so it becomes
        `dbService.open(paths.dbPath, { migrationsDir, nativeBinding, assetsDir: paths.assetsDir })`.
      - **(b)** add a `DbService.setPaths({ assetsDir })` called from `bootstrap()` right after
        `open()` (before any import call) if you prefer to keep `open()`'s signature stable.
      Construct the `UrlImportService` ONCE (lazily, like the other services) with the open DB +
      that `assetsDir` injected at construction. Expose **two** public members:
      - `async importFromUrl(request): Promise<SourcesImportUrlResult>` (async — it awaits the
        service's network fetch);
      - a **public accessor `get urlImportService(): UrlImportService`** (lazily building the one
        instance on first read) that returns the SAME built instance, so M13's `bootstrap()` can do
        `startCaptureServer({ …, importService: dbService.urlImportService })` and the renderer IPC
        path + the loopback path share one fully-built service. If `assetsDir` was not provided
        (e.g. a contract-only test that never imports), the accessor throws a clear error rather than
        constructing a half-wired service.
      This is the ONLY place the importer + vault writer + repositories are composed for URL import,
      and the single built instance is the one M13's loopback server reuses.
- [ ] **Preload** in [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts):
      add `sources.importUrl` invoking `IPC_CHANNELS.sourcesImportUrl`.
- [ ] **Renderer client** in [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts):
      mirror the new types + `appApi.importUrlSource(request)` + the `AppApi`-interface entry.
- [ ] **Renderer "Import from URL" affordance** — wire the EXISTING "Paste URL" chip in
      [`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx):
      flip its `IMPORT_OPTS` entry from disabled "coming soon" to an `action: "url"`. **Note the
      concrete type/handler change:** `IMPORT_OPTS`'s `action` field is currently typed `action?:
      "manual"` and the chip enablement is hard-coded `const enabled = o.action === "manual"` (~lines
      55-66 / 469-475) — widen the `action` union to `"manual" | "url"` (and, with M13, `"capture"`)
      and extend the enable/click logic so an `"url"` chip is enabled and opens the URL modal
      (`o.action === "url" ? openUrlModal : …`), not the New-source modal. The chip then opens a
      small **`ImportUrlModal`** (new file under `apps/web/src/pages/inbox/`, mirroring
      `NewSourceModal`'s dialog/keyboard pattern): a single URL input (+ optional priority chip
      group + reason), `⌘↵` to submit / `Esc` to close, a busy/spinner state while the main
      process fetches, and an inline error on failure (mapping `UrlImportError.code` to a
      friendly line — "Couldn't reach that page", "That page isn't an article", "Timed out").
      On success it closes and calls the inbox `refresh(id)` (selecting the new source).
      Render gracefully when `!isDesktop()` (mirror the existing desktop-only fallback). Keep it
      pure UI: it calls ONE `appApi` command; all fetch/clean/persist is main-side.
- [ ] **Tests (unit, importers — fixture-driven)** in `packages/importers/src/*.test.ts`:
      check a small set of fixture HTML files under `packages/importers/src/__fixtures__/`
      (a normal article, a JS-heavy/empty-body page, a page with disallowed tags
      script/style/iframe/img, a list-and-blockquote-heavy article, a non-article landing page):
  - `extractArticle` returns the expected title/byline and non-empty `contentHtml` for the
    article fixture; `null`-ish (empty `contentHtml`) for the non-article fixture.
  - `sanitizeArticleHtml` strips `script`/`style`/`iframe`/`on*`/`javascript:` and keeps only
    allowlisted tags; idempotent (sanitizing twice == once).
  - `htmlToProseMirrorDoc`: a heading+paragraph+list+blockquote+code fixture maps to the right
    node types; **every node is in `ALLOWED_NODE_NAMES`, every mark in `ALLOWED_MARK_NAMES`,
    and `Node.fromJSON(buildSchema(), doc)` does not throw**; each row-bearing node has a unique
    `blockId` and the `blocks` list mirrors it; empty HTML → valid empty doc.
- [ ] **Tests (domain, local-db)** — extend the local-db tests: `createWithDocument` with a
      pre-built `conversion` stores the supplied doc/plainText/blocks verbatim (no
      re-conversion) and still lands the source in `inbox` with `create_source`/`update_document`
      ops; the raw-`body` fallback path is unchanged.
- [ ] **Tests (main-side service)** in `apps/desktop/src/main/url-import-service.test.ts`
      against a real temp-file SQLite DB + a **mocked `fetch`** (return a fixture HTML `Response`)
      + a temp `assetsDir`. **Follow the established desktop-main test pattern** (see
      [`../../apps/desktop/src/main/db-service.test.ts`](../../apps/desktop/src/main/db-service.test.ts) ~lines 33-34):
      `new DbService()` + `svc.open(dbPath, { migrationsDir, assetsDir })` against a `mkdtempSync`
      temp dir, NOT an in-memory helper — the desktop app's main tests use a real temp file (and a
      temp file is what makes the restart-persistence assertion below meaningful). (The in-memory
      `createInMemoryDb()` helper lives in `@interleave/local-db`'s `src/test-db.ts` and is used
      only by that package's OWN repository tests; it is not exported from the package barrel, so do
      not reach for it from `apps/desktop`.) Either drive the service through `DbService` (preferred,
      so the test exercises the real construction + accessor wiring) or construct `UrlImportService`
      directly against `createRepositories(handle.db)` + the temp `assetsDir`:
  - a successful import writes `original.html` + `cleaned.html` under
    `assets/sources/<id>/`, records two `source_html` asset rows whose `contentHash` matches
    `sha256File`, creates an `inbox` source whose `snapshotKey` is the cleaned-HTML path and
    whose document body parses to the expected nodes, and appends `create_source` +
    `update_document` ops;
  - **restart-persistence**: re-open the DB (new repositories on the same file) and assert the
    source + provenance + body + asset rows are still present and the snapshot files still exist
    on disk;
  - error paths: a mocked non-2xx / non-HTML / timeout / oversize response throws the typed
    `UrlImportError` with the right `code` and writes NO source row and NO partial vault dir
    (clean rollback).
- [ ] **Tests (contract)** — extend
      [`../../apps/desktop/src/shared/contract.test.ts`](../../apps/desktop/src/shared/contract.test.ts):
      `SourcesImportUrlRequestSchema` accepts a valid `{ url }`, rejects an empty/oversize url
      and a bad priority label.
- [ ] **Tests (E2E, Electron)** — new `tests/electron/url-import.spec.ts` (see Done when),
      driving the real Electron app against a **local fixture HTTP server** (a tiny Node
      `http` server the test starts serving a known article HTML), so no live network is hit.
- [ ] **Fixtures/seed** — seed: no schema/seed change required for T060 (the importer-fixture
      HTML files under `packages/importers/src/__fixtures__/` are the only new test data).
      Optionally add ONE URL-imported demo source to the seed so the inspector shows real
      provenance (title/byline/originalUrl/canonicalUrl/accessedAt/snapshotKey) out of the box —
      nice-to-have, not required.
- [ ] **Docs** — check the T060 box in [`../roadmap.md`](../roadmap.md) with the commit ref +
      a Progress-log line; note the local-first re-scope (no worker/S3) and the new
      `@interleave/importers` package.

### Done when

- Pasting a URL into the inbox "Import from URL" affordance imports the live page **locally**:
  the main process **fetches** it, runs **Readability**, stores **both** `original.html` and a
  sanitized **`cleaned.html`** in the vault under `assets/sources/<source_id>/` (with
  content-hashed `AssetRepository` metadata, bytes never in SQLite), converts the cleaned
  article to **ProseMirror JSON** that validates against the constrained schema with **stable
  block ids**, and **creates an `inbox` source** carrying title/byline/originalUrl/canonicalUrl/
  accessedAt/`snapshotKey` — all through `createWithDocument` in one transaction, appending
  `create_element` + `create_source` + `update_document`.
- The new source appears in the inbox list immediately (no reload), opens with its body + a
  preview, and shows its provenance in the universal inspector.
- The fetch/clean/persist all run **main-side**; the renderer reaches it only through
  `window.appApi.sources.importUrl` — no generic `db.query`, no network/fs in the renderer, no
  SQL in React.
- Paywall/JS-heavy/404/timeout/non-article URLs fail gracefully with a friendly message and
  leave no orphan source/asset/file (clean rollback) — the app never crashes or hangs.
- An Electron E2E imports a fixture URL (served by a local test HTTP server), sees the source in
  the inbox, opens its body, and — after an **app restart** against the same data dir — the
  source, its provenance, its body, and the `cleaned.html`/`original.html` snapshot files all
  survive.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Edge handling (paywall / JS-heavy / 404 / timeout / non-article).** Readability runs over
  the *fetched* HTML only — a server-rendered article works; a purely client-rendered SPA or a
  paywalled page may yield little/no `contentHtml`. Policy: when Readability returns no usable
  content, STILL create the source (so the capture is never lost) with the page `<title>` (or
  host) as the title, an empty/near-empty body, and a `reasonAdded` note like "Readability
  found no article body"; the user can then read it via the saved `original.html` snapshot or
  re-import as a manual note. 404/non-2xx/timeout/non-HTML/oversize are hard failures (typed
  `UrlImportError`) surfaced to the user — nothing is persisted. Do NOT execute page JS, do NOT
  load remote subresources, do NOT follow `<meta refresh>` — fetch the single document only.
- **Security.** The sanitizer is load-bearing: the cleaned HTML and the derived ProseMirror doc
  must contain NO scripts, event handlers, `javascript:`/`data:` URLs, remote images, iframes,
  or styles — both because the reader renders this content and because the constrained schema
  must accept it. Sanitize BEFORE HTML→PM, and let the constrained-schema validation be the
  final backstop (reject/strip any node the schema can't represent).
  - **SSRF / redirect guard (concrete requirement, not optional).** The fetch MUST reject
    non-`http(s)` schemes AND reject any URL — entered OR redirect-resolved (re-check the FINAL
    url) — whose host is loopback / link-local / private: `127.0.0.0/8`, `::1`, `169.254.0.0/16`,
    and RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), throwing `UrlImportError {
    code: "blocked_host" }` before reading the body (see fetch step 1). This is **low-risk locally**
    (user-initiated, and token-gated when reached via M13's loopback capture server) — keep it
    proportionate — but it is now a network-reachable surface (the SAME `UrlImportService` is
    called from the M13 loopback server), so it is a **required, unit-tested** behavior (a pure
    `isBlockedImportHost(host)` helper with a test asserting each blocked range is rejected and a
    public host is allowed), not a documented-away nicety.
- **Bundling.** `@mozilla/readability` + `linkedom` + `sanitize-html` are pure JS and bundle
  into `main.cjs` via esbuild (which already bundles everything but `electron`/`bindings`/
  `prebuild-install`). Verify `pnpm --filter @interleave/desktop build` succeeds and the
  packaged main still opens. If `linkedom` proves insufficient for Readability on some fixture,
  fall back to `jsdom` and `asarUnpack` any native bits — but try linkedom first.
  - **Editor barrel React leak (must verify).** The real bundling risk is `@interleave/editor`,
    NOT the pure-JS deps: its barrel re-exports `SourceEditor` (→ `@tiptap/react` → `react`), and
    the package has no `"sideEffects": false` and no schema sub-path export, so importing the
    schema/block-id contract from `@interleave/importers` can drag React into `main.cjs`. The
    "React-free editor import surface" deliverable fixes this (sideEffects flag OR a schema/block-id
    sub-path export). **Verify**: after `pnpm --filter @interleave/desktop build`, grep the built
    `main.cjs` and assert it contains neither `@tiptap/react` nor `react-dom` (the importers path
    must not pull the React editor surface). If it does, switch to the sub-path-export option.
  - **`@tiptap/core` + `@tiptap/starter-kit` ARE expected in `main.cjs` — do not mistake them for the
    React leak.** The importers' `htmlToProseMirrorDoc` test calls `buildSchema()`, which imports
    `@tiptap/core`'s `getSchema` + `@tiptap/starter-kit` (`packages/editor/src/schema.ts` ~lines 29-32);
    esbuild bundles everything except `electron`/`bindings`/`prebuild-install`
    ([`../../apps/desktop/build.mjs`](../../apps/desktop/build.mjs) ~line 51), so `@tiptap/core` +
    StarterKit + the underlying ProseMirror modules DO land in `main.cjs`. That is **acceptable** — they
    are pure JS, no native bindings, no React. The verify grep above asserts ONLY the absence of
    `@tiptap/react`/`react-dom`, NOT `@tiptap/core` (a bundled `@tiptap/core` is correct; a bundled
    `@tiptap/react`/`react-dom` is the leak).
- **The pre-built-doc seam matters.** HTML→PM conversion uses the editor's
  schema/block-id contract, so it lives in `@interleave/importers` (which may depend on
  `@interleave/editor`), NOT in `packages/local-db` (which must stay editor-free). Threading a
  pre-built `PlainTextConversion` through `createWithDocument` is what keeps the layering clean
  while reusing the exact atomic transaction.
- **Reuse for M13.** `UrlImportService.importFromUrl` is the SHARED capture pipeline the
  browser extension's loopback server (T062/T063) will call — keep it a clean,
  construction-time-injected (`new UrlImportService({ db, repositories, assetsDir })`),
  network-and-fs-isolated service so a second caller (the loopback HTTP handler) reuses the same
  built instance without going through the renderer. M13 passes the already-built
  `importService` into `startCaptureServer({ …, importService })`. See Downstream notes.
- **Deferred to T061:** dedup. T060 imports unconditionally (a re-import makes a second source);
  T061 adds canonical-URL + content-hash detection and the "reuse or new version" prompt.

---

## T061 — Canonical URL & duplicate detection

- **Status:** `[ ]`  · **Depends on:** T060
- **Roadmap line:** Done when URLs are normalized (tracking params removed), already-imported
  canonical URLs are detected, content hashes computed; re-importing prompts reuse-or-new-version.

### Goal

URL import becomes **dedup-aware**. Before creating a new source, the import service normalizes
the URL with `canonicalizeUrl` and checks whether that canonical URL is **already imported**;
it also content-hashes the cleaned snapshot and checks for a **content-hash duplicate** (the
same article reached via two different URLs). When a duplicate is found, the import does NOT
silently create a second source — it returns a structured **"reuse or new version"** outcome the
renderer/extension surface, letting the user open the existing source, import a fresh version
anyway, or cancel. The canonical-URL lookup is backed by an indexed query over the `sources`
table.

### Context to load first

- Reference: [`../../packages/core/src/url.ts`](../../packages/core/src/url.ts) (the
  `canonicalizeUrl` normalizer built for this), [`../domain-model.md`](../domain-model.md)
  (`sources.canonical_url`, `snapshot_key`), the M2 dedup deferral note in
  [`M2-capture-and-inbox.md`](./M2-capture-and-inbox.md) (T012/T014 — "dedup/'possible
  duplicate' banner + Merge (M12 T061)").
- Existing code to inspect: `AssetRepository.findByContentHash`
  ([`../../packages/local-db/src/asset-repository.ts`](../../packages/local-db/src/asset-repository.ts)),
  the `sources` schema
  ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts) — note
  `canonical_url` exists but is **NOT indexed**), the `UrlImportService` + the
  `SourcesImportUrl*` contract from T060.
- Invariants in play: the canonical-URL lookup is a typed query in `packages/local-db` (no SQL
  in React); dedup must consider only **live** sources (`deletedAt IS NULL`); content hashing
  reuses the snapshot `sha256` already computed in T060; no destructive auto-merge — re-import
  is a user choice; `canonicalizeUrl` is the single normalizer (do not fork it).

### Deliverables

- [ ] **Migration — index `sources.canonical_url`.** Add the index to the schema
      ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts),
      e.g. `index("sources_canonical_url_idx").on(table.canonicalUrl)`). **Structural change to
      note:** the `sources` table is currently declared as `sqliteTable("sources", { … })` with NO
      second `(table) => [...]` callback argument (only `sourceLocations` in the same file uses the
      callback form for its indexes) — so adding this index requires CONVERTING the `sources`
      definition to the callback form `sqliteTable("sources", { … }, (table) => [
      index("sources_canonical_url_idx").on(table.canonicalUrl) ])`, NOT just appending a stray
      `index()` call. Then run `pnpm db:generate` to produce the Drizzle migration; commit the
      generated SQL. Use a plain (non-unique) index — distinct sources MAY legitimately share a
      canonical URL (an explicit "import new version anyway"); uniqueness would block that. Note the
      backfill = no-op (existing rows already have `canonical_url` populated from T014/T060).
- [ ] **Canonical-URL lookup query** in `packages/local-db` —
      `packages/local-db/src/source-dedup-query.ts` (a small class/fn like the other `*-query`
      modules) exposing:
  - `findSourcesByCanonicalUrl(canonicalUrl: string): SourceDuplicateMatch[]` — live `source`
    elements whose `sources.canonical_url` equals the given value (joined to the element for
    its id/title/status/accessedAt), newest first.
  - `findSourceBySnapshotHash(contentHash: string): SourceDuplicateMatch | null` — via
    `AssetRepository.findByContentHash` → the owning `source` element (the same cleaned-HTML
    bytes already imported), or `null`. **Disambiguate which hash matched:**
    `findByContentHash` (asset-repository.ts ~lines 93-97) is **hash-only** — it returns whichever
    asset carries that content hash regardless of whether it is an `original.html` or a
    `cleaned.html`, so a raw lookup could resolve via the WRONG logical file (e.g. matching an
    `original.html` byte-collision and pointing at the wrong source). The query MUST therefore
    constrain the match to the **cleaned-HTML asset** — filter the returned asset by
    `kind === "source_html"` AND `relativePath` ending in `cleaned.html` (or, equivalently, look up
    via the source's `snapshotKey`, which is the cleaned-HTML relative path) — so the snapshot-hash
    dedup compares cleaned-snapshot to cleaned-snapshot and resolves the correct owning source
    element, never an ambiguous hit. Pass only the cleaned-HTML hash here (T060 hashes both files;
    dedup uses the `cleaned.html` one). Make the criterion explicit in the query.
  - `SourceDuplicateMatch = { elementId, title, status, accessedAt, matchedBy: "canonicalUrl"
    | "contentHash" }`. Export from
    [`../../packages/local-db/src/index.ts`](../../packages/local-db/src/index.ts) and add to
    `createRepositories`/`Repositories` (or construct like `InspectorQuery`).
- [ ] **Dedup in `UrlImportService`.** Extend `importFromUrl` with a `mode` /
      `forceNewVersion` flag:
  - After deriving `canonicalUrl` (and BEFORE writing the DB row), call
    `findSourcesByCanonicalUrl(canonicalUrl)`. If a live match exists AND `forceNewVersion` is
    false, return EARLY with a **duplicate** outcome (no source created, no vault write
    committed — discard any temp bytes) carrying the existing match(es).
  - After computing the cleaned-snapshot `contentHash` (T060 already hashes it), if no canonical
    match but `findSourceBySnapshotHash(hash)` returns a live source AND `forceNewVersion` is
    false, return the **duplicate** outcome with that match (`matchedBy: "contentHash"`).
  - When `forceNewVersion` is true (the user chose "import new version anyway"), skip both
    checks and import normally — producing a SECOND source that shares the canonical URL
    (intentional; the index is non-unique).
- [ ] **Contract extension** in
      [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts):
  - Extend `SourcesImportUrlRequestSchema` with `forceNewVersion: z.boolean().optional()`
    (default false).
  - Make `SourcesImportUrlResult` a discriminated result:
    `{ status: "imported"; id: string; item: InboxItemSummary }` OR `{ status: "duplicate";
    matches: readonly SourceDuplicateSummary[] }`, where `SourceDuplicateSummary = { elementId,
    title, status, accessedAt, matchedBy }`. (T060 always returned `status: "imported"`; T061
    adds the `"duplicate"` arm.)
  - No new channel — the existing `sources.importUrl` channel carries the richer result.
- [ ] **DB service + service wiring** — thread `forceNewVersion` through `importFromUrl` and
      return the discriminated result.
- [ ] **Renderer "reuse or new version" prompt** — when `appApi.importUrlSource(...)` returns
      `status: "duplicate"`, the `ImportUrlModal` (T060) shows the existing match(es): "Already
      imported as '<title>' on <date>" with three actions — **Open existing** (select that
      element / navigate to its reader, close), **Import new version** (re-call `importUrl` with
      `forceNewVersion: true`), and **Cancel**. Pure UI; the decision routes back through the
      same single command. (This is the local-first equivalent of M2's deferred "possible
      duplicate" banner — keep it inline in the import flow, not a separate screen.)
- [ ] **Tests (unit, dedup helpers)** — `packages/local-db/src/source-dedup-query.test.ts`
      against an in-memory DB via this package's own `createInMemoryDb()` from `./test-db` (a
      same-package relative import — `test-db.ts` is intentionally not on the package barrel and is
      the harness the other `local-db` repository tests use): two sources with the same
      `canonical_url` are both returned (newest
      first); a soft-deleted source is excluded; `findSourceBySnapshotHash` resolves the owning
      source from a known asset hash and returns `null` for an unknown hash. Also reuse
      `packages/core`'s `url.test.ts` to confirm `canonicalizeUrl` collapses the tracking-param
      variants the dedup relies on (e.g. `?utm_source=x` and the bare URL canonicalize equal).
- [ ] **Tests (main-side service)** — extend `url-import-service.test.ts`: importing the SAME
      fixture URL twice (default mode) returns `status: "imported"` the first time and
      `status: "duplicate"` (with the first source as the match) the second time, creating only
      ONE source; importing two DIFFERENT urls that canonicalize equal (tracking-param variant)
      is detected as a canonical duplicate; two different urls serving IDENTICAL article bytes
      are detected as a content-hash duplicate; `forceNewVersion: true` creates a second source
      sharing the canonical URL.
- [ ] **Tests (contract)** — extend `contract.test.ts`: `SourcesImportUrlRequestSchema` accepts
      `forceNewVersion`; the duplicate result type round-trips a `matches` payload.
- [ ] **Tests (E2E, Electron)** — extend `tests/electron/url-import.spec.ts`: import the fixture
      URL once, attempt the same URL again, assert the modal shows the "already imported" state
      (no second inbox item), then "Import new version" creates a second source; everything
      survives an **app restart**.
- [ ] **Fixtures/seed** — seed: no change needed for T061 (dedup is exercised by the unit /
      service / E2E tests that import the same fixture twice; no seed row is required).
- [ ] **Docs** — check the T061 box in [`../roadmap.md`](../roadmap.md) + a Progress-log line;
      note the `sources_canonical_url_idx` migration.

### Done when

- URLs are **normalized** (tracking params removed, via the shared `canonicalizeUrl`),
  already-imported **canonical URLs are detected** (indexed lookup over live sources), **content
  hashes are computed** for the cleaned snapshot and content-hash duplicates detected, and a
  **re-import returns a structured "reuse or new version" outcome** the modal surfaces — Open
  existing / Import new version / Cancel.
- Default re-import of an already-imported URL creates **no** second source; "Import new version"
  explicitly does (the canonical-URL index is non-unique by design).
- The dedup lookup is a typed `packages/local-db` query (no SQL in React); only live sources are
  matched; nothing is auto-merged or destroyed.
- The new `sources_canonical_url_idx` migration is included and applies cleanly on an existing
  dev DB; dedup behavior survives an **app restart**.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Single normalizer.** `canonicalizeUrl` is intentionally conservative (it does not strip
  `www.`, sort query params, or fold trailing-`index.html`); that's fine — over-aggressive
  normalization risks collapsing genuinely distinct URLs. If a class of false-negatives matters,
  extend `canonicalizeUrl` (with tests) rather than special-casing the dedup query, so manual
  import (T014) and URL import share one definition.
- **Content-hash is a backstop, not the primary key.** The cleaned-HTML hash catches the
  same-article-different-URL case but is sensitive to trivial markup differences (timestamps,
  ads, A/B variants), so it will MISS many true duplicates — that's acceptable; canonical-URL is
  the primary signal and the user always has the explicit "new version" escape hatch. Do not try
  to fuzzy-match content in this task (semantic/near-dup detection is T088, M18).
- **No merge here.** T061 detects duplicates and offers reuse/new-version; it does NOT implement
  merging two sources into one (that, and a library-wide "possible duplicates" view, are later
  maintenance work — T099, M20). Keep the scope to detection + the import-time choice.
- **Re-scoped deps.** Like T060, this is local-first: the dedup index lives in the local SQLite
  `sources` table, not a server. No Postgres/pgvector involvement.

---

## Downstream notes — M13 (browser extension) reuses this import service

M13 (T062 browser-extension MVP, T063 side-panel capture) builds a Manifest V3 extension that
must NEVER write SQLite directly. In the local-first model it captures a page/selection and
hands it to the **Electron app** to persist. The convergence point is the **same
`UrlImportService.importFromUrl` pipeline this milestone builds**, exposed to the extension via
a **token-protected `127.0.0.1` loopback HTTP capture server** mounted in the Electron main at
`app.whenReady` (alongside `registerIpcHandlers` in
[`../../apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts)). That server's
single capture handler validates the request (Zod, shared shapes) and **calls the M12 import
service** — so the renderer "Import from URL" path and the extension capture path land identical
sources in the inbox through one shared, tested pipeline. To keep that reuse clean, M12 MUST:

- Keep `UrlImportService` **transport-agnostic**: network fetch + vault write + DB transaction
  only, with `assetsDir` (and any other paths) injected at **construction time** (`new
  UrlImportService({ db, repositories, assetsDir })`) — no Electron `ipcMain`, no
  `BrowserWindow`, no renderer assumptions inside it, and no per-call `ctx`. The IPC handler is a
  thin adapter; the loopback handler will be a second thin adapter over the SAME built instance's
  SAME methods (`importFromUrl`, and `importFromHtml`/`importSelection` per below).
- Support a **"capture pre-fetched HTML" entry point** in addition to "fetch this URL": the
  extension already has the rendered page DOM/HTML (and gets past paywalls/JS the bare `fetch`
  cannot), so the service exposes `importFromHtml(input: { url; html; title?; priority?;
  reasonAdded?; accessedAt?; forceNewVersion? }): Promise<UrlImportResult>` (single `input` arg —
  no per-call `ctx`; `assetsDir` came in at construction) that SKIPS the fetch step and runs the
  same Readability→sanitize→snapshot→createSource pipeline over the supplied HTML. **M12 OWNS and
  ships this entry point now (see the `importFromHtml` deliverable in T060) — it is NOT deferred
  to M13.** It is a trivial split of `importFromUrl` around the fetch (the
  `extractArticle`/`sanitizeArticleHtml`/`htmlToProseMirrorDoc` transforms are already
  URL-independent), so both methods share one private pipeline helper and produce identical
  sources. M13's loopback "save page" handler calls `importFromHtml`; M13 adds nothing to the
  service here.
- Reuse the same dedup (T061) for extension captures — the loopback handler returns the same
  `"imported" | "duplicate"` outcome so the extension's UI can offer the same reuse/new-version
  choice.

Testing scope for M13 (flagged now so M12's seam is testable): the extension itself cannot be
driven by Playwright-Electron, so M13 will rely on (a) unit tests for the message-shaping +
the loopback request handler, (b) an integration test that POSTs to the loopback capture server
against a running Electron main and asserts the source lands via the M12 service, and (c) a
documented manual load-unpacked check. None of that works unless `UrlImportService` is the
clean, injectable, transport-agnostic seam specified above — so build it that way in M12.

---

## Exit criteria for M12

- T060 and T061 are `[x]` in [`../roadmap.md`](../roadmap.md) with commit refs + Progress-log
  entries (noting the local-first re-scope off T058/T059 and the new `@interleave/importers`
  package).
- A user can paste a URL into the inbox import strip and the **Electron app**, fully locally,
  fetches the page, runs Readability, stores `original.html` + sanitized `cleaned.html` in the
  asset vault, converts the article to constrained ProseMirror JSON with stable block ids, and
  creates an **inbox** source with full provenance (title/byline/originalUrl/canonicalUrl/
  accessedAt/snapshotKey) — through the existing transactional source pipeline, appending the
  right `operation_log` entries, with bytes in the vault and never in SQLite.
- Re-importing an already-imported URL (or the same article via a different/tracking-param URL,
  or identical bytes) is **detected** and offers **reuse-or-new-version** instead of silently
  duplicating; "new version" is an explicit user choice.
- All of it goes through the typed `window.appApi.sources.importUrl` bridge — no network, fs, or
  SQL in the renderer; no generic `db.query`; the fetch/clean/persist run main-side. Pure
  transforms live in `@interleave/importers` with fixture-driven unit tests; the orchestration is
  the injectable, transport-agnostic `UrlImportService` (so M13's loopback server can reuse it).
- Everything **survives an app restart** (proven by `tests/electron/url-import.spec.ts` against a
  local fixture HTTP server — no live network), and source lineage is preserved.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the Electron Playwright E2E are green in CI.

When M12 is complete, generate `tasks/M13-browser-extension.md` from the roadmap before starting
T062 — the milestone that builds the Manifest V3 extension + the token-protected loopback
capture server that CALLS this `UrlImportService`.
