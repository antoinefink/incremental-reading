# M15 — Image occlusion, formula & code cards (T071–T072)

Detailed, buildable specs for the **first two tasks of M15** (the rich-media-cards milestone).
After these two tasks the desktop app gains two new **card variants** that ride the existing
card/extract/review substrate (NOT a parallel system), both **100% on-device**:

- **T071** — from a **`media_fragment` image extract** (the figure/diagram T065 already crops out
  of a PDF page into the vault, `media/<asset_id>/original.bin`, mime `image/png`), the user draws
  **mask regions** over the image in a renderer canvas/SVG editor; the masks are stored **SEPARATELY
  from the base image** (a new `occlusion_masks` table — the crop bytes are NEVER mutated/baked into),
  and the diagram yields **multiple sibling cards** (`element_relations.siblingGroupId`), each an
  `image_occlusion`-kind `card` that, at review, reveals exactly **one** masked region while the
  others stay hidden. It is a new `card_type` (a `CARD_KINDS` member + a `cards`-CHECK migration),
  scheduled by **FSRS** like every card.
- **T072** — the constrained editor schema gains a **`math` node** (LaTeX, rendered with **KaTeX**)
  and a **`language` attribute on the existing `codeBlock`** (syntax-highlighted with **Shiki**),
  both carrying **stable block ids** and round-tripping through `buildSchema()`. Math + highlighted
  code render correctly in **SOURCE** (the Tiptap `SourceEditor`), **EXTRACT** (the same editor in
  the extract view), and **REVIEW** (the `CardFront`/`ReviewScreen` faces, which render plain strings
  today). A **code-specific card prompt** (fill-in-the-blank / predict-output) integrates the
  existing `cards.create` + card-quality (T035) path with no new card system.

Everything obeys the established architecture (see [`../../CLAUDE.md`](../../CLAUDE.md) +
[`../architecture.md`](../architecture.md)): the React renderer (`apps/web`) calls the narrow typed
`window.appApi` bridge; the Electron main (`apps/desktop`) validates the IPC payload (Zod) and routes
to `packages/local-db` repositories + services; every multi-table mutation runs in ONE SQLite
transaction and appends `operation_log` entries; image bytes live in the filesystem asset vault via
the T059 `AssetVaultService` — **never SQLite, never an app-facing S3**; the renderer never touches
Node, the network, the filesystem, or SQLite. Both card variants are scheduled by **FSRS** (cards
only); the originating `media_fragment` / source / extract stay on the **attention** scheduler — the
two schedulers are never crossed. Everything **survives an app restart**.

> **Local-first (roadmap M15 header, lines ~277–279).** "image/video/audio bytes live in the
> **asset vault** (T059), transcoding/clipping runs on the **local background runner** (T058); no
> app-level S3, no server processing." T071/T072 add NO video/audio/clip processing (that is
> T073–T075) and NO heavy runner job — they are pure renderer + schema + card-substrate work on
> the M14 image-extract + M6/M7 card-review infra that already shipped. Reuse it; do **not** rebuild
> a parallel card/extract/vault stack.

Read first:
- [`../architecture.md`](../architecture.md) — the asset-vault layout (`assets/media/<asset_id>/
  original.bin, thumbnail.webp, ocr.json`), the **"No large blobs in SQLite"** rule (line ~169), the
  layering rule (renderer → typed `window.appApi` → main → `local-db`).
- [`../domain-model.md`](../domain-model.md) — `card` ("an active-recall item (Q&A or cloze)", line
  ~13) + `media_fragment` ("a timestamped/region clip (PDF region, video/audio clip, image)", line
  ~16); the `cards` table (`element_id, kind, prompt, answer, cloze, source_location_id, …`, line
  ~127); `element_relations` (`sibling_group_id`, line ~125); `source_locations`
  (`…, page, …, region, label, selected_text`, line ~124); "Relationships & lineage — Lineage is
  sacred. A card must trace: `card → extract → source location → source metadata`" (lines ~65–67).
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the FSRS-vs-attention split:
  **cards are FSRS-only**; an image-occlusion / code card is a `card`, so it gets a `review_states`
  row and is FSRS-scheduled; siblings (same diagram / cloze group) must not appear back-to-back
  (T039 burying — image-occlusion siblings reuse the SAME mechanism).
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Core domain invariants" (card is a card variant, NOT a
  parallel system; `media_fragment` is a core element type), "Card-quality rules", "Document/editor
  rules" (stable block ids, the constrained schema grows only by an explicit reviewed change),
  "Architectural rules" (domain logic out of components — heuristics/parse live in `packages/core`),
  "Review rules", "SQLite rules" (CHECK constraints, transactions).
- [`../design-system.md`](../design-system.md) — the `screen-builder` (`Cloze`/`Q&A` tabs + the
  **disabled "Image occlusion" tab**, T071 enables it), the `screen-review` (`rcard`, `grades`,
  jump-to-source, `SchedulerChip` FSRS side), the element-type hues (`--el-card` green).
- Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md) (REQUIRED shape: Goal · Context to load first ·
  Dependencies · Deliverables · Tests · Done when · Notes/risks). Format/depth exemplars:
  [`M6-cards.md`](./M6-cards.md) (the card model + `CardService` + `cards.create` precedent T071's
  card variant mirrors EXACTLY), [`M7-fsrs-review.md`](./M7-fsrs-review.md) (the review face +
  `CardFront` T071/T072 render into), [`M14-pdf-ocr.md`](./M14-pdf-ocr.md) (T065 image extracts +
  the T059 vault + T058 runner T071 builds on).

What already exists (confirmed by inspecting the repo — **do not rebuild these**):
- **The card model + service** — `cards` table
  ([`../../packages/db/src/schema/cards.ts`](../../packages/db/src/schema/cards.ts)): `elementId`
  (PK, 1:1 with the `card` element), `kind` (`check("cards_kind_check", inList(table.kind,
  CARD_KINDS))`, ~line 60), `prompt`/`answer`/`cloze`, `sourceLocationId`, `sourceUri`, `isLeech`.
  `CardService.createFromExtract`
  ([`../../packages/local-db/src/card-service.ts`](../../packages/local-db/src/card-service.ts)
  ~line 146) composes `ReviewRepository.createCardWithin`, sibling grouping (`addRelationWithin`,
  `siblingGroupId`), source-anchor + tag + priority inheritance, in ONE transaction; it returns
  `{ element, card, siblingGroupId, sourceLocationId }`. `ReviewRepository.createCardWithin`
  ([`../../packages/local-db/src/review-repository.ts`](../../packages/local-db/src/review-repository.ts)
  ~line 182) writes the `card` element (stage `card_draft`), the `cards` row, and the un-due
  `review_states` row (`fsrsState: "new"`). **T071's `image_occlusion` cards go through THIS path.**
- **`CARD_KINDS`** ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts) ~line 118)
  `= ["qa", "cloze"] as const` + `CardKind`. **T071 adds `"image_occlusion"`** — and because
  `cards.kind` has a CHECK built from this tuple, that is a **migration** (the CHECK is rebuilt) +
  an enum-tuple change rippling into `CardKindSchema`, the contract `superRefine`, `CardFront`, and
  the seed.
- **T065 image extracts (the base the occlusion builds on)** —
  `PdfRegionService.extractRegion`
  ([`../../apps/desktop/src/main/pdf-region-service.ts`](../../apps/desktop/src/main/pdf-region-service.ts)
  ~line 116) crops a PDF region in the RENDERER (`<canvas>`), ships the size-capped PNG, and MAIN
  creates a **`media_fragment`** extract (`ExtractionService.createRegionExtract`) + streams the crop
  into the vault via `AssetVaultService.importAsset({ kind: "image", mime: "image/png" })` (the
  canonical `media/<asset_id>/original.bin` layout — bytes never in SQLite). The cropped image is a
  **clean base asset** (T065 Notes: "keep the region image a clean base asset (the crop, no baked-in
  annotations) so occlusion masks can be stored separately later" — that is THIS task).
- **`AssetVaultService.importAsset`**
  ([`../../apps/desktop/src/main/asset-vault-service.ts`](../../apps/desktop/src/main/asset-vault-service.ts)
  ~line 164) — STREAM-writes a binary to the vault while hashing, dedups on content hash, records the
  `AssetRepository` row. `ASSET_KINDS`
  ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts) ~line 148) already has
  `"image"` — **T071 needs NO new asset kind** (the base image is already an `image` asset; the masks
  are NOT bytes, they are vector regions in SQLite).
- **`getRegionImage` IPC (how the renderer reads an extract's image bytes WITHOUT a path)** —
  `sources.getRegionImage({ elementId }): { bytes: ArrayBuffer | null; mime: string | null }`
  ([`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts) ~line
  1233, `SourcesGetRegionImageResult`): MAIN resolves the owning `image` asset's vault path and
  returns the bytes. **T071's mask editor + review face read the base image through THIS command** —
  the renderer never resolves a vault path.
- **`RegionRect`** ([`../../packages/core/src/element.ts`](../../packages/core/src/element.ts)) =
  `{ x0, y0, x1, y1 }` (fractions 0–1) + `RegionRectSchema`
  ([`contract.ts`](../../apps/desktop/src/shared/contract.ts) ~line 1150, validated `0≤·≤1`,
  `x0<x1`, `y0<y1`). **T071's mask rects reuse this normalized-fraction convention** so a mask maps
  correctly at any render zoom.
- **The constrained editor schema** — `buildSchema()` / `buildExtensions()` / `ALLOWED_NODE_NAMES`
  (`…, "codeBlock", …` ~line 50 — **`codeBlock` already exists**, with NO language attr) /
  `ALLOWED_MARK_NAMES` (`["bold","italic","link","code"]` ~line 43 — **inline `code` already
  exists**) / `ALLOWED_HEADING_LEVELS`
  ([`../../packages/editor/src/schema.ts`](../../packages/editor/src/schema.ts)). The stable-block-id
  rules — `BLOCK_ID_NODE_TYPES` (~line 59) / `shouldCarryBlockId` (~line 85)
  ([`../../packages/editor/src/block-id.ts`](../../packages/editor/src/block-id.ts)), and
  `newBlockId` (the ULID minter — lives in
  [`../../packages/editor/src/block-ids.ts`](../../packages/editor/src/block-ids.ts) ~line 77,
  re-imported into `block-id.ts:49`) — the
  `roundtrip` test ([`../../packages/editor/src/schema.test.ts`](../../packages/editor/src/schema.test.ts)).
  **T072 adds a `math` node + a `codeBlock` `language` attr to THIS schema** (an explicit, reviewed,
  tested change — the schema's whole reason for being narrow).
- **`SourceEditor`** ([`../../packages/editor/src/SourceEditor.tsx`](../../packages/editor/src/SourceEditor.tsx))
  — the React Tiptap editor that renders the SOURCE body AND (reused) the EXTRACT body in
  `ExtractView`. **T072's math/code render here** (a Tiptap NodeView for math; a highlight decoration
  / NodeView for the code language).
- **The review faces** — `CardFront`
  ([`../../apps/web/src/review/CardFront.tsx`](../../apps/web/src/review/CardFront.tsx)) renders a
  card's front (a cloze card via `renderClozePrompt`, a Q&A card verbatim **as a plain string**);
  `ReviewScreen` ([`../../apps/web/src/review/ReviewScreen.tsx`](../../apps/web/src/review/ReviewScreen.tsx)
  ~line 483) renders `rcard__prompt` / `rcard__answer` (today: `(card.answer ?? "")` — a **plain
  string**). `ReviewCardView`
  ([`contract.ts`](../../apps/desktop/src/shared/contract.ts) ~line 2251) carries `kind`, `prompt`,
  `answer`, `cloze`, `schedulerSignals`, `siblingGroupId`. **T071 extends the review face to render
  the masked image; T072 makes the prompt/answer render math + highlighted code instead of a raw
  string.**
- **`renderClozePrompt` / cloze model** ([`../../packages/core/src/cloze.ts`](../../packages/core/src/cloze.ts))
  — the pattern T072's code-card "fill-in-the-blank" reuses (a code blank IS a cloze over code text);
  card-quality heuristics in
  [`../../packages/core/src/card-quality.ts`](../../packages/core/src/card-quality.ts)
  (`evaluateCardQuality`) — T072's code-card checks extend this same pure function.
- **The IPC seam** — channels
  ([`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts)),
  contract ([`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts)
  — the `cards` group ~line 3272 with `create(request)`, `CardsCreateRequest`/`CardSummary` ~line
  1988/2038), preload ([`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts)),
  router ([`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts)), DB service
  ([`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts)), renderer
  client ([`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts)). **T071 adds a
  `cards.generateOcclusion` command (mirroring `cards.create`); T072 needs NO new IPC** (math/code
  ride the existing document + `cards.create` shapes).
- **The card builder** —
  ([`../../apps/web/src/reader/CardBuilder.tsx`](../../apps/web/src/reader/CardBuilder.tsx)) the
  `Cloze`/`Q&A` tabs surface; the kit's THIRD (disabled) tab is "Image occlusion"
  ([`../../design/kit/app/screen-builder.jsx`](../../design/kit/app/screen-builder.jsx) line ~142:
  `<button className="tab" disabled … title="Coming later">Image occlusion</button>`). **T071 enables
  that tab** (the diagram-→-masks surface). T072's code-card authoring extends the Q&A tab with a
  "predict output / fill-in" affordance.

What is **missing** and this milestone adds:
- T071: `"image_occlusion"` in `CARD_KINDS` + the `cards.kind` CHECK migration; an `occlusion_masks`
  table + repository (masks stored SEPARATELY from the base image); an `OcclusionService` that
  generates N sibling `image_occlusion` cards from one image + its masks in one transaction; a
  `cards.generateOcclusion` IPC command; a renderer **mask editor** (canvas/SVG over the base image)
  + a **review face** that renders the base image with one region masked.
- T072: a **`math` node** (KaTeX) + a **`codeBlock` `language` attr** (Shiki) on the constrained
  schema (with schema-roundtrip + block-id coverage); the `SourceEditor` NodeViews/decorations that
  render them in source/extract; the `ReviewScreen`/`CardFront` body renderer that renders them in
  review; a code-card authoring affordance + card-quality coverage.

Build order is the task order: **T071 depends on T065** (it needs a `media_fragment` image extract +
the vault crop + `getRegionImage`); **T072 depends on T015** (the editor schema) **+ T032** (the
card model). They are independent of each other and can land in parallel.

---

## T071 — Image occlusion

- **Status:** `[ ]` not started  · **Depends on:** T065 (the `media_fragment` image extract — the
  vault crop `media/<asset_id>/original.bin` + `RegionRect` + `getRegionImage`). In practice also
  T032/T036 (the `CardService` + `ReviewRepository.createCardWithin` card-creation seam and the FSRS
  review state these `image_occlusion` cards reuse — all shipped, so concrete deps even though the
  roadmap line predates them).
- **Roadmap line:** Done when image-occlusion cards generate from image extracts with masks/regions
  stored separately from the base image; one diagram yields multiple sibling cards.

### Goal

Standing on a **`media_fragment` image extract** (the figure/diagram T065 cropped out of a PDF page
into the vault), the user opens the **occlusion editor** and draws one or more **mask regions** over
the image (a canvas/SVG rubber-band, each rect normalized to fractions 0–1 so it maps at any zoom).
Pressing **Generate cards** mints **one `image_occlusion` `card` per mask**, all grouped as
**siblings** (`element_relations.siblingGroupId`) — so a 6-label anatomy diagram yields 6 sibling
cards. The masks are stored in a new **`occlusion_masks` table** (vector regions in SQLite),
**SEPARATELY from the base image** — the cropped PNG in the vault is **never mutated** and the masks
are **not baked into** it. At review, an `image_occlusion` card renders the **base image with exactly
its one masked region hidden** (a solid box / blur over the rect) on the front; revealing shows the
hidden region (its label / the un-occluded image). Each card is a real `card` element — FSRS-scheduled
(a `review_states` row), with `card → media_fragment (extract) → source location (page+region) →
source` lineage intact — appearing in the inspector, lineage tree, and review session like any card,
and **surviving an app restart**. It is a new **`card_type`** (`image_occlusion`), NOT a parallel card
system. The mask editor + the review face read the base image through the typed `getRegionImage`
bytes command; the renderer never resolves a vault path, never writes bytes, never touches SQLite.

### Context to load first

- Reference: [`../domain-model.md`](../domain-model.md) (`card` + `media_fragment` element types; the
  `cards` table; `element_relations.sibling_group_id`; the `card → extract → source location →
  source` lineage), [`../scheduling-and-priority.md`](../scheduling-and-priority.md) (cards are
  FSRS-only; siblings bury — T039), [`../design-system.md`](../design-system.md) +
  [`../../design/kit/app/screen-builder.jsx`](../../design/kit/app/screen-builder.jsx) (the disabled
  "Image occlusion" tab T071 enables) + the `screen-review` `rcard` (the review face).
- Existing code to inspect: `CardService.createFromExtract` + `ReviewRepository.createCardWithin`
  (the card-creation + sibling-grouping seam to compose); `CARD_KINDS`/`CardKind`/`CardKindSchema`
  (the kind tuple to extend); `cards.kind` CHECK in
  [`../../packages/db/src/schema/cards.ts`](../../packages/db/src/schema/cards.ts);
  `PdfRegionService.extractRegion` + `ExtractionService.createRegionExtract` (the `media_fragment`
  image extract this builds on); `AssetVaultService.importAsset` + the `image` asset kind;
  `sources.getRegionImage` (the base-image-bytes command);
  `RegionRect`/`RegionRectSchema` (the normalized-rect convention to reuse); `CardFront` +
  `ReviewScreen` (the review face to extend); the inspector / `LineageTree`; the `cards.create`
  contract precedent (channel → schema → preload → handler → db-service → client).
- Invariants in play: lineage is sacred (`card → media_fragment → source location → source`); the
  whole generation is ONE transaction logging `create_card` (+ `add_relation` for siblings, `add_tag`);
  masks are stored SEPARATELY from the base image (the vault crop is immutable); image bytes live in
  the vault only (never SQLite — masks are vector regions, not bytes); each card is FSRS-scheduled
  (a `card` with a `review_states` row); the renderer never touches fs/SQL.

### The mask data model (specify concretely — "stored SEPARATELY, not baked in")

- A **mask is a normalized region** over the base image: `{ x0, y0, x1, y1 }` fractions 0–1 (reuse
  `RegionRect`/`RegionRectSchema`), plus an optional **`label`** (the text the hidden region stands
  for, e.g. "Hippocampus" — shown on reveal) and a stable **`maskId`** (ULID). The whole occlusion
  set belongs to ONE `media_fragment` image extract (the base).
- **Storage: a new `occlusion_masks` table** (NOT a column on `cards`, NOT baked into the image):
  `{ id (PK ULID), imageElementId (FK → elements, the media_fragment, onDelete cascade), cardElementId
  (FK → elements, the generated image_occlusion card that reveals THIS mask, nullable until generated,
  onDelete set null), region (TEXT JSON {x0,y0,x1,y1}), label (TEXT, nullable), order (INTEGER, draw
  order), createdAt }`, indexed by `imageElementId` (read all masks for a diagram) and a UNIQUE on
  `cardElementId` (one card reveals one mask). The base image asset (`media/<asset_id>/original.bin`)
  is **read-only** — masks NEVER alter it; the review face composites the mask over the base image at
  render time (a `<div>`/SVG box over an `<img>`), so the same clean crop powers every sibling card.
- **One card ↔ one mask.** Generating cards walks the masks for the image and creates one
  `image_occlusion` `card` per mask, setting that mask's `cardElementId`. The card's
  `cards.prompt`/`answer`/`cloze` are NOT the carriers of the image (the constrained doc schema has
  no image node) — the card's **identity is `kind: "image_occlusion"` + its `occlusion_masks` row**
  (which mask it hides). The card's `cards.answer` MAY hold the mask label (for search/preview); the
  authoritative reveal target is the mask's `label` + the un-occluded region.
- **Why not a column / a per-card image / a baked PNG:** baking the mask into a new PNG per card would
  duplicate the figure N times in the vault and lose the "edit a mask, regenerate" loop; a `cards`
  column cannot hold N masks; so the mask set is its own table keyed to the image, and the cards
  reference back into it. This keeps the base crop a single clean asset (the T065 invariant) and lets
  a future "add/remove a mask" re-run regeneration deterministically.

### Dependencies to add (concrete, justified)

- **NONE (renderer-native canvas/SVG; no new library).** The mask editor draws rubber-band rects over
  the base image in the **Chromium renderer** using native `<canvas>` / SVG overlay + pointer events —
  the SAME technique T065's `PdfReader` already uses for region selection (no library). The review
  face composites a mask box over an `<img>` with CSS/SVG. **No image-processing library, no native
  canvas, no `asarUnpack`** is needed: masks are vector regions stored as fractions, composited at
  render time — the base image bytes are never re-encoded. (Explicit non-goal: do NOT bake masked PNGs
  with a server/`@napi-rs/canvas` — that re-encodes the figure and violates "stored separately". If a
  future export needs a flattened PNG, that is a separate, justified task.)

### Deliverables

- [ ] **Extend `CARD_KINDS` with `"image_occlusion"` + the `cards.kind` CHECK migration.** Add
      `"image_occlusion"` to `CARD_KINDS`
      ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts) ~line 118). Because
      `cards.kind` has `check("cards_kind_check", inList(table.kind, CARD_KINDS))`
      ([`../../packages/db/src/schema/cards.ts`](../../packages/db/src/schema/cards.ts) ~line 60),
      the CHECK is rebuilt from the new tuple — run `pnpm db:generate` to emit the **next sequential
      migration** (nominally the next number after M14's last; **take whatever `db:generate`
      produces** — do not hand-number; SQLite rewrites the table to widen the CHECK) and commit the
      generated SQL **under `packages/db/drizzle/`** (the Drizzle `out` dir — `drizzle.config.ts`,
      where `0013_*.sql` already lives; NOT a `migrations/` folder). Update `CardKindSchema`
      ([`contract.ts`](../../apps/desktop/src/shared/contract.ts)) to accept the new kind. Pure
      widening — existing `qa`/`cloze` rows are unaffected; no backfill.
      > **Migration is required here (unlike M6).** M6's note "no migration for the card model" was
      > because `qa`/`cloze` already existed. Adding a THIRD kind changes a CHECK constraint built
      > from the enum tuple, so a Drizzle migration is mandatory (SQLite rebuilds the table for a
      > CHECK change). Keep it a single reviewable migration.
- [ ] **`occlusion_masks` table + migration.** Add the table above to `packages/db/src/schema/`
      (a new `occlusion.ts` module, exported from the schema index): `{ id, imageElementId (FK →
      elements onDelete cascade), cardElementId (FK → elements onDelete set null, UNIQUE), region
      (TEXT JSON), label (TEXT nullable), order (INTEGER notNull), createdAt }`, indexed by
      `imageElementId`. Run `pnpm db:generate` (it folds into / follows the `CARD_KINDS` migration —
      keep each schema concern in its own reviewable migration; take the generated numbers) and commit
      the SQL **under `packages/db/drizzle/`** (the Drizzle `out` dir, beside `0013_*.sql`). Add the
      auto-inferred `OcclusionMaskRow`/`NewOcclusionMaskRow` types.
- [ ] **`OcclusionMasksRepository`** in `packages/local-db/src/occlusion-masks-repository.ts` — typed,
      transactional access mirroring the existing repository shape: `replaceMasksForImage(tx,
      imageElementId, masks[])` (insert-or-replace the mask set for a diagram in one tx — the
      idempotent "edit the masks, regenerate" write), `listForImage(imageElementId)`,
      `findByCard(cardElementId)`, `setCardForMask(tx, maskId, cardElementId)`. Register it in the
      repository bag (`Repositories` / `createRepositories`, defined in
      [`../../packages/local-db/src/index.ts`](../../packages/local-db/src/index.ts)).
      Mask writes themselves add **no `operation_log` op** (they are card-authoring substrate); the
      CARD generation logs `create_card` (see below).
- [ ] **`OcclusionService`** in `packages/local-db/src/occlusion-service.ts` — composes
      `OcclusionMasksRepository` + `ReviewRepository.createCardWithin` + `ElementRepository`
      (sibling grouping + tag/priority inheritance) to **generate N sibling `image_occlusion` cards
      from one image + its masks in ONE transaction**, mirroring `CardService.createFromExtract`:
      1. resolve the `media_fragment` image extract via `ElementRepository.findById(imageElementId)`;
         derive lineage — `parentId = imageElementId`, `sourceId = image.sourceId ?? imageElementId`,
         `sourceLocationId = SourceRepository.findLocationForElement(imageElementId)?.id ?? null` (the
         page+region anchor the cards inherit — jump-to-source works in review);
      2. persist the mask set via `replaceMasksForImage(tx, …)` (overwriting a prior set so an
         edit-then-regenerate is deterministic);
      3. for EACH mask, mint a `siblingGroupId` ONCE (the first mask) and create the card via
         `ReviewRepository.createCardWithin(tx, { kind: "image_occlusion", title: mask.label ??
         "Region N", prompt: null, answer: mask.label ?? null, cloze: null, parentId, sourceId,
         sourceLocationId, priority: image.priority, stage: "card_draft" })` (`priority` is REQUIRED
         on `createCardWithin` — review-repository.ts:50 — so pass the image's inherited priority),
         then `setCardForMask(tx, mask.id, card.id)` and an
         `addRelationWithin(tx, { relationType: "sibling_group", siblingGroupId })` edge (logs
         `add_relation`); inherit the image's tags/priority (`addTagWithin`, logs `add_tag`);
      4. all of it in ONE `db.transaction` — a throw rolls back every card/mask/edge/tag row. Return
         `{ siblingGroupId, cards: CardSummary[], masks: {...}[] }`. Export from
         [`../../packages/local-db/src/index.ts`](../../packages/local-db/src/index.ts).
      > **Two-scheduler invariant (carry the M6 docblock).** Each generated card is `card_draft` with
      > an UN-DUE `review_states` row (`fsrsState: "new"`); M7's FSRS owns the first schedule + the
      > `card_draft → active_card` transition. Do NOT schedule the card here. The originating
      > `media_fragment` stays an **attention** item (never given a `review_states` row beyond what
      > the card creation makes for the CARD).
- [ ] **New `window.appApi` surface `cards.generateOcclusion`** across the six layers, mirroring
      `cards.create`:
      - channel `cardsGenerateOcclusion: "cards:generateOcclusion"`
        ([`channels.ts`](../../apps/desktop/src/shared/channels.ts));
      - `CardsGenerateOcclusionRequestSchema` + `CardsGenerateOcclusionResult`
        ([`contract.ts`](../../apps/desktop/src/shared/contract.ts)) — request: `imageElementId`
        (ElementId), `masks: z.array(z.object({ region: RegionRectSchema, label:
        z.string().trim().max(512).nullable().optional() })).min(1).max(50)` (cap the mask count so a
        runaway editor can't mint hundreds of cards), optional A/B/C/D `priority`. Result:
        `{ siblingGroupId: string; cards: CardSummary[] }` (CardSummary already exists, ~line 2038).
        Validate ≥1 mask and each rect via the reused `RegionRectSchema`;
      - preload method `cards.generateOcclusion`
        ([`preload/index.ts`](../../apps/desktop/src/preload/index.ts));
      - validated IPC handler on `IPC_CHANNELS.cardsGenerateOcclusion` calling
        `DbService.generateOcclusionCards` ([`ipc.ts`](../../apps/desktop/src/main/ipc.ts));
      - `DbService.generateOcclusionCards(request)` mapping the A/B/C/D label → numeric priority and
        calling `OcclusionService` ([`db-service.ts`](../../apps/desktop/src/main/db-service.ts));
      - the renderer client `cards.generateOcclusion` + a thin
        `appApi.generateOcclusionCards(request)` helper
        ([`appApi.ts`](../../apps/web/src/lib/appApi.ts)) + the `cards` group entry in the `AppApi`
        interface.
      The base-image bytes are NOT sent on this command (they already live in the vault); the renderer
      sends only the `imageElementId` + the vector masks.
- [ ] **Renderer occlusion editor** in `apps/web` — a `OcclusionEditor` surface (e.g.
      `apps/web/src/reader/OcclusionEditor.tsx`), opened from the **enabled "Image occlusion" tab**
      of the card builder ([`CardBuilder.tsx`](../../apps/web/src/reader/CardBuilder.tsx)) when the
      current element is a `media_fragment` image extract (else the tab stays disabled with a hint
      "Open an image extract to occlude"). It:
      - loads the base image bytes via `appApi.getRegionImage({ elementId: imageElementId })` (the
        existing T065 command) → an `<img>` / canvas sized to the image;
      - lets the user **draw rubber-band mask rects** over the image (native pointer events, like the
        T065 `PdfReader` region select), each normalized to `RegionRect` fractions; supports adding,
        selecting, **labeling** (a small inline text field per mask), and **deleting** masks; renders
        each mask as a translucent box with its label;
      - on **Generate cards**, calls `appApi.generateOcclusionCards({ imageElementId, masks,
        priority? })`; on success toasts "N occlusion cards created", refreshes the inspector +
        lineage so the N siblings appear under the `media_fragment`, and leaves the editor ready (an
        edit-then-regenerate re-runs `replaceMasksForImage`).
      Pure UI: it calls the typed commands only; no fs/SQL; renders a calm fallback when `!isDesktop()`.
- [ ] **Enable the kit's "Image occlusion" tab.** In
      [`../../design/kit/app/screen-builder.jsx`](../../design/kit/app/screen-builder.jsx) the tab is
      `disabled … title="Coming later"` (line ~142) — that file is the IMMUTABLE kit reference (do
      NOT edit it). In OUR rebuilt `CardBuilder.tsx`, **enable the third tab** ("Image occlusion") so
      it mounts the `OcclusionEditor` when the element is an image extract; keep it disabled (with a
      hint) otherwise. Use existing icons from
      [`../../apps/web/src/components/Icon.tsx`](../../apps/web/src/components/Icon.tsx) — do not
      invent an `IconName`; if a distinct occlusion glyph is wanted, ADD it to `Icon.tsx` +
      `design/icon-map.md` first as an explicit step.
- [ ] **Review face for `image_occlusion` cards.** Extend the review render so an `image_occlusion`
      card shows the **base image with its one masked region hidden**:
      - Extend `ReviewCardView`
        ([`contract.ts`](../../apps/desktop/src/shared/contract.ts) ~line 2251) so a card carries the
        occlusion data the face needs: `occlusion: { imageElementId: string; region: RegionRectInput;
        label: string | null; otherRegions: RegionRectInput[] } | null` (the card's own mask + the
        sibling masks so the front can optionally dim them too) — resolved MAIN-side from
        `occlusion_masks` when the card's `kind === "image_occlusion"`, `null` otherwise. Build it in
        the same review-card query that builds `ReviewCardView` today.
      - A `CardOcclusionFace` component (alongside `CardFront`) that loads the base image via
        `appApi.getRegionImage({ elementId: imageElementId })` and renders it with a **mask box over
        the card's `region`** (the hidden answer) on the FRONT; on reveal it removes/clears the mask
        box to show the region (and shows the `label` text). `ReviewScreen`
        ([`ReviewScreen.tsx`](../../apps/web/src/review/ReviewScreen.tsx) ~line 483) renders this face
        for `kind === "image_occlusion"` instead of the string prompt/answer (keep `qa`/`cloze`
        unchanged). The card is graded Again/Hard/Good/Easy like any FSRS card (no review-loop change).
      - Keep the masking presentational (a CSS/SVG box over the `<img>`); the renderer never re-encodes
        the image, never resolves a vault path.
- [ ] **Inspector / lineage.** An `image_occlusion` card already shows in the universal inspector +
      `LineageTree` via the element graph (it is a `card` under the `media_fragment`). Verify its
      detail/inspector reads correctly (kind `image_occlusion`, FSRS `SchedulerChip`, the `card →
      media_fragment → source location → source` lineage). No new inspector wiring beyond the kind
      label; the existing element-type→scheduler derivation already applies — an `image_occlusion`
      card is a `card` element, and `schedulerKindForType(type)`
      ([`../../packages/local-db/src/inspector-query.ts`](../../packages/local-db/src/inspector-query.ts)
      ~line 27: `type === "card" ? "fsrs" : "attention"`, mirrored in the `db-service` inspector
      query) already maps every `card` to the FSRS `SchedulerChip` side.
- [ ] **Seed/fixtures.** Extend `packages/testing` factories + the desktop seed so the demo collection
      includes ONE image-occlusion example: a `media_fragment` image extract (reuse the T065 fixture
      crop) + 2 masks + 2 generated sibling `image_occlusion` cards — so the editor + review face show
      a real example out-of-the-box and the E2E has a seeded target.
- [ ] **Tests (unit, core/db):**
      - `CARD_KINDS` includes `image_occlusion`; `CardKindSchema` accepts it and rejects `"xyz"`.
      - `OcclusionMasksRepository` round-trips a mask set (region JSON parse, `order`, `label`),
        `replaceMasksForImage` is idempotent (re-run overwrites, no dup rows), `findByCard` resolves.
      - The `0NNN_*` migration applies on an existing dev DB (the widened `cards.kind` CHECK now
        accepts `image_occlusion`; the `occlusion_masks` table exists).
- [ ] **Tests (domain, local-db)** — `packages/local-db/src/occlusion-service.test.ts` (in-memory DB):
      from a seeded `media_fragment` image extract with 3 masks, `generateOcclusion` creates exactly 3
      `image_occlusion` `card` elements (`stage: "card_draft"`, `parentId = imageElementId`, `sourceId
      = image.sourceId`), each with a `cards` row (`kind: "image_occlusion"`), each with an un-due
      `review_states` row (`dueAt = null`, `fsrsState = "new"`), all sharing ONE `siblingGroupId` (3
      `sibling_group` edges), each `occlusion_masks` row pointing at its card, inherited tags, and
      `operation_log` rows `create_card` (×3) + `add_relation` + `add_tag`. Assert a throw rolls
      everything back. Assert the `media_fragment` is unchanged (still an attention item; not given an
      FSRS row of its own). Assert the base image asset is untouched (the crop bytes unchanged — masks
      stored separately).
- [ ] **Tests (contract)** — extend
      [`../../apps/desktop/src/shared/contract.test.ts`](../../apps/desktop/src/shared/contract.test.ts):
      `CardsGenerateOcclusionRequestSchema` accepts a valid request, rejects 0 masks / >50 masks / an
      inverted rect; the result round-trips; `ReviewCardView.occlusion` round-trips.
- [ ] **Tests (component)** — `OcclusionEditor.test.tsx` (Vitest + Testing Library): drawing a rect
      adds a mask; labeling + deleting work; **Generate cards** calls `generateOcclusionCards` with the
      drawn masks. A `CardOcclusionFace.test.tsx`: the front renders the base image with the card's
      region masked; reveal clears the mask and shows the label.
- [ ] **Tests (E2E, Electron)** — `tests/electron/image-occlusion.spec.ts`: open the seeded (or a
      freshly region-extracted) `media_fragment` image extract → open the occlusion editor → draw 2
      masks + label them → Generate cards → 2 sibling `image_occlusion` cards appear under the
      extract in the lineage tree → enter review → an `image_occlusion` card shows the image with one
      region masked, reveal shows it, grade Good → after an **app restart** the cards, their masks,
      the sibling grouping, the base image, and the lineage all survive.
- [ ] **Docs** — check the T071 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line noting: the `image_occlusion` `CARD_KINDS` + `cards.kind` CHECK migration, the
      `occlusion_masks` table + repository, the `OcclusionService` + `cards.generateOcclusion` command,
      the renderer mask editor, and the review occlusion face.

### Done when

- From a **`media_fragment` image extract**, the user draws **mask regions** over the base image and
  **generates N sibling `image_occlusion` cards** (one per mask) via the typed
  `cards.generateOcclusion` command, in ONE transaction (`create_card` ×N + `add_relation` +
  `add_tag`), with `card → media_fragment → source location → source` lineage intact.
- The masks are stored in the **`occlusion_masks` table** as normalized vector regions, **SEPARATELY
  from the base image** — the cropped PNG in the vault is **never mutated or baked into**; the review
  face composites the mask over the clean base image at render time.
- Each generated card is a real **`card`** element — `kind: "image_occlusion"`, FSRS-scheduled (an
  un-due `review_states` row that M7's engine owns), appearing in the inspector + lineage tree +
  review session like any card; siblings bury (T039) via the shared `siblingGroupId`. It is a card
  VARIANT, not a parallel system.
- At review, an `image_occlusion` card renders the base image with **exactly its one masked region
  hidden** on the front, revealed on reveal; graded Again/Hard/Good/Easy.
- The mask editor + review face read the base image through the typed `getRegionImage` bytes command;
  the renderer never resolves a vault path, writes bytes, or touches SQLite (no `db.query`).
- The `cards.kind` CHECK + `occlusion_masks` migrations apply cleanly on an existing dev DB; an
  Electron E2E generates occlusion cards, reviews one, and — after an **app restart** — the cards,
  masks, sibling grouping, base image, and lineage all survive.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Card variant, not a parallel system.** `image_occlusion` is the THIRD `CARD_KINDS` member sharing
  the `cards`/`review_states`/`element_relations` substrate + `CardService`/`ReviewRepository` seam
  + the FSRS review loop. Do NOT build a separate occlusion-card table/queue/scheduler. The ONLY new
  storage is `occlusion_masks` (the vector masks the existing `cards` row can't hold).
- **Masks separate from the base image (load-bearing).** Never re-encode/bake masked PNGs into the
  vault — store fractions, composite at render. This keeps the T065 crop a single clean asset, makes
  "edit a mask, regenerate" deterministic, and keeps image bytes out of SQLite. A flattened-PNG export
  is a separate future task, not this one.
- **Normalized fractions (reuse `RegionRect`).** Store masks as 0–1 fractions so they map at any
  render zoom; validate `0≤·≤1`, `x0<x1`, `y0<y1` via the reused `RegionRectSchema`.
- **FSRS, not attention.** Each generated card is FSRS-scheduled (it is a `card`); the originating
  `media_fragment` / source stay on the attention scheduler. Never cross them.
- **Source of image extracts.** T065 currently produces image extracts from PDF regions. T071 occludes
  ANY `media_fragment` image extract — so a future image source (a pasted/imported image, if added)
  reuses the SAME editor. Keep `OcclusionService` keyed on "a `media_fragment` whose owning asset is an
  `image`", not "a PDF region" specifically.
- **Downstream:** T075 (audio review cards) is the next card variant on this substrate; keep the
  card-variant pattern (a `CARD_KINDS` member + a kind-specific review face) clean so it generalizes.

---

## T072 — Formula & code cards

- **Status:** `[ ]` not started  · **Depends on:** T015 (the constrained Tiptap editor schema the
  `math` node + `codeBlock` language attr extend), T032 (the card model the code-card prompt rides).
- **Roadmap line:** Done when MathJax/LaTeX, syntax-highlighted code, and code-specific prompts
  render correctly in source/extract/review.

### Goal

The constrained editor schema gains two capabilities, added by an **explicit, reviewed, tested**
schema change (the schema's whole reason for being narrow): a **`math` node** that stores a LaTeX
string and renders it (block + inline) via **KaTeX**, and a **`language` attribute on the existing
`codeBlock`** so a fenced code block carries its language and renders **syntax-highlighted** via
**Shiki**. Both carry **stable block ids** and round-trip through `buildSchema()` (the schema-roundtrip
test gains cases for them). Math + highlighted code then render correctly in all three surfaces that
share the editor/face stack: **SOURCE** (the Tiptap `SourceEditor` body), **EXTRACT** (the same editor
in `ExtractView`), and **REVIEW** (the `CardFront`/`ReviewScreen` faces, which render plain strings
today — they gain a body renderer that renders math/code). Finally, a **code-specific card prompt** —
fill-in-the-blank (a cloze over a code span) and predict-output — integrates the existing
`cards.create` + card-quality (T035) path, with code-aware quality checks, so a programmer can turn a
code extract into a recall card without a new card system. All on-device; no network; no AI.

### Context to load first

- Reference: [`../../CLAUDE.md`](../../CLAUDE.md) "Document/editor rules" (the constrained schema
  grows only by an explicit reviewed change; stable block ids; marks re-anchor by block id),
  "Card-quality rules" (minimum information; the warn/prevent list T035 owns); [`../domain-model.md`](../domain-model.md)
  (`cards`, the cloze/code distillation); [`../design-system.md`](../design-system.md) (`--font-mono`
  Plex Mono for code; the reader/card faces; the `code` styling).
- Existing code to inspect: `buildSchema`/`buildExtensions`/`ALLOWED_NODE_NAMES`/`ALLOWED_MARK_NAMES`
  ([`../../packages/editor/src/schema.ts`](../../packages/editor/src/schema.ts) — `codeBlock` + inline
  `code` already present); `BLOCK_ID_NODE_TYPES`/`shouldCarryBlockId`
  ([`../../packages/editor/src/block-id.ts`](../../packages/editor/src/block-id.ts)) +
  `newBlockId` ([`../../packages/editor/src/block-ids.ts`](../../packages/editor/src/block-ids.ts),
  the plural sibling module); the
  schema-roundtrip test ([`../../packages/editor/src/schema.test.ts`](../../packages/editor/src/schema.test.ts));
  `SourceEditor` ([`../../packages/editor/src/SourceEditor.tsx`](../../packages/editor/src/SourceEditor.tsx))
  + the reader-decorations plumbing
  ([`../../packages/editor/src/reader-decorations.ts`](../../packages/editor/src/reader-decorations.ts));
  the serialization helpers ([`../../packages/editor/src/serialize.ts`](../../packages/editor/src/serialize.ts)
  — the `toPlainText(doc)` serializer ~line 89 that emits the search/preview `plainText` mirror;
  math/code nodes must flatten to LaTeX/code text here); `CardFront`
  ([`../../apps/web/src/review/CardFront.tsx`](../../apps/web/src/review/CardFront.tsx)) +
  `ReviewScreen` ([`../../apps/web/src/review/ReviewScreen.tsx`](../../apps/web/src/review/ReviewScreen.tsx)
  ~line 483, where `prompt`/`answer` are rendered as plain strings today); the cloze model
  ([`../../packages/core/src/cloze.ts`](../../packages/core/src/cloze.ts) — the pattern a code
  fill-in reuses); `evaluateCardQuality`
  ([`../../packages/core/src/card-quality.ts`](../../packages/core/src/card-quality.ts)); the card
  builder ([`../../apps/web/src/reader/CardBuilder.tsx`](../../apps/web/src/reader/CardBuilder.tsx)).
- Invariants in play: the schema grows ONLY by an explicit change that round-trips through
  `buildSchema()`/`toDOM`/`parseDOM` + gains schema-roundtrip coverage; new nodes carry stable block
  ids; math/code render identically in source/extract/review (one renderer, three surfaces); rendering
  is on-device (no MathJax/Shiki CDN — bundle the assets); card-quality stays a pure `packages/core`
  function; no new card system (code cards are `qa`/`cloze` with code bodies).

### Dependencies to add (concrete, justified)

- **`katex`** (`^0.16.x`) — **CHOSEN over MathJax** for math rendering. KaTeX renders LaTeX to HTML+CSS
  **synchronously** (no async typesetting pass, no global mutation of the page), is **fully offline**
  (it ships a single CSS + font files; no CDN/network), is small, and is the standard for fast
  inline-+-block math in editors. MathJax is heavier, async, and its v3 startup/typeset model is
  awkward inside a Tiptap NodeView re-render; KaTeX's `katex.renderToString(latex, { displayMode })`
  is a perfect fit for a NodeView and a review face. Add it to `apps/web` (the renderer) and
  `packages/editor` (the NodeView). **Bundle the fonts/CSS** (import `katex/dist/katex.min.css` in the
  renderer; Vite serves the fonts as renderer assets — NO CDN). Justification over alternatives:
  MathJax = heavier + async + global; rendering server-side = violates local-first; a hand-rolled LaTeX
  renderer = absurd. KaTeX is the on-device, synchronous, bundled choice.
  > **Render math on a TRUSTED local string only.** KaTeX with `throwOnError: false` renders a
  > parse-error span (never throws); the LaTeX is user-authored local content, rendered to a sandboxed
  > KaTeX HTML subset — do NOT pass user LaTeX to `innerHTML` via any path other than
  > `katex.renderToString` (which emits a fixed, safe markup shape).
- **`shiki`** (`^1.x`) — **CHOSEN over highlight.js** for code highlighting. Shiki uses real TextMate
  grammars + VS Code themes for accurate highlighting, runs **fully on-device** (a JS-RegExp or bundled
  WASM-oniguruma engine + bundled grammars/themes — no network), and its **fine-grained bundle**
  (`shiki/core` +
  `createHighlighterCore` + explicit `import` of only the languages/themes we ship + an explicit engine
  choice — see the engine note below) keeps the renderer bundle bounded. highlight.js is simpler but
  markedly less accurate and themeable; Shiki's output is a
  styled `<pre><code>` HTML string ideal for both the NodeView and the review face. Add it to `apps/web`
  (the renderer). **Bundle a bounded language set** (e.g. `js`/`ts`/`python`/`json`/`bash`/`sql`/`rust`
  + `css`/`html` — a documented list) + one light + one dark theme (matching `design/tokens.css`); load
  via `createHighlighterCore` with explicit dynamic imports (NO `getHighlighter` auto-loading
  everything, NO CDN). A language outside the bundled set degrades gracefully to a plain
  `<pre><code>` (no highlight, no crash). Justification: accuracy + theming + offline + bounded
  bundle; highlight.js trades accuracy for size, Shiki's fine-grained core keeps size in check while
  being correct.
  > **Pick the regex engine explicitly — the one real packaging wrinkle (no CDN).** Shiki's TextMate
  > grammars need a regex engine. There are two on-device options; choose ONE and state it so the
  > builder never hits a runtime "failed to load `onig.wasm`" by accidentally fetching the WASM over a
  > CDN: **(preferred) the JavaScript RegExp engine** — `createHighlighterCore({ engine:
  > createJavaScriptRegexEngine() })` (`shiki/engine/javascript`) — which needs **NO WASM asset at
  > all** (it compiles the grammars to native JS RegExp; the small accuracy gap is irrelevant for our
  > bounded language set); **OR** the WASM oniguruma engine — `createOnigurumaEngine(import('shiki/wasm'))`
  > — in which case the `onig.wasm` MUST be bundled as a **renderer asset Vite serves locally** (a
  > `?url`/asset import of `shiki/onig.wasm`, never a CDN fetch). Default to the JS RegExp engine to
  > avoid the WASM asset-handling step entirely; if oniguruma is needed for fidelity, bundle the WASM
  > as a local Vite asset. Either way: NO network, NO CDN.
  > **Async-highlight caveat.** Shiki highlighting is async (it loads grammars/themes, plus the WASM if
  > the oniguruma engine is chosen). The NodeView /
  > review face must render the **raw code text first** (a plain `<pre><code>`) and swap in the
  > highlighted HTML when ready (a small `useEffect` + state), so a slow first highlight never blocks
  > paint and an unsupported language stays plain. Initialize ONE shared highlighter (a module
  > singleton) so every code block reuses it.

### The schema extension (specify concretely — an explicit reviewed change)

- **`math` node** (a new ALLOWED node): a leaf/atom node storing `attrs: { latex: string; display:
  boolean; blockId }` — `display: true` is a block formula (its own row, block-id-bearing), `display:
  false` an inline formula inside a paragraph. `toDOM`/`parseDOM` serialize a `<span data-math
  data-display="…">…latex…</span>` (the LaTeX in a data attr / text content, NOT pre-rendered HTML —
  the rendered KaTeX is a NodeView/decoration at display time, so stored JSON stays a clean latex
  string the extract/review can re-render). Add `"math"` to `ALLOWED_NODE_NAMES` and, for the BLOCK
  form, to `BLOCK_ID_NODE_TYPES` (an inline math node does not carry a row block id; the containing
  paragraph does). The `plainText` mirror (`serialize.ts`) emits the LaTeX (e.g. `$E=mc^2$`) so search
  + preview work.
- **`codeBlock` `language` attribute** (extend the EXISTING node, do not add a new one): add a
  `language: string | null` attr to `codeBlock` via a `StarterKit` `codeBlock` config /
  `extendNodeSchema` so `toDOM` emits `<pre><code class="language-…">` and `parseDOM` reads the
  language off the `<code class>` / `data-language` (the standard Markdown/HTML code-fence convention,
  so T068's Markdown/HTML import round-trips the language). `codeBlock` is ALREADY in
  `ALLOWED_NODE_NAMES` + `BLOCK_ID_NODE_TYPES` — only the attr is new. The stored JSON keeps the raw
  code + the language string; highlighting is a render-time concern (Shiki), never baked into the JSON.
- **Both changes are an explicit, reviewed schema growth** — `ALLOWED_NODE_NAMES` gains `"math"`, the
  `codeBlock` attrs gain `language`, and the **`schema.roundtrip` test gains cases** asserting a doc
  with a block formula, an inline formula, and a `language`-tagged code block round-trips through
  `buildSchema()`/`Node.fromJSON`/`toJSON` with stable block ids and no disallowed node/mark. This is
  the ONLY sanctioned way the schema grows (CLAUDE.md "Document/editor rules").

### Deliverables

- [ ] **`math` node + `codeBlock` language attr in the constrained schema.** In
      [`../../packages/editor/src/schema.ts`](../../packages/editor/src/schema.ts): add `"math"` to
      `ALLOWED_NODE_NAMES`; register a framework-agnostic `Math` Tiptap node (a new
      `packages/editor/src/nodes/math.ts`, schema-only `toDOM`/`parseDOM` with the `latex`/`display`
      attrs, NO React) in `buildExtensions`; extend `codeBlock` with a `language` attr (via the
      StarterKit `codeBlock` config or a small `extendNodeSchema`). Add `"math"` (block form) to
      `BLOCK_ID_NODE_TYPES`
      ([`../../packages/editor/src/block-id.ts`](../../packages/editor/src/block-id.ts)). Keep
      `schema.ts` React-free (the NodeView that pulls KaTeX lives in the React `SourceEditor`, not the
      schema). Update the `toPlainText(doc)` serializer
      ([`../../packages/editor/src/serialize.ts`](../../packages/editor/src/serialize.ts) ~line 89 —
      this is the function that produces the stored `documents.plainText` mirror) so a `math` node
      flattens to its LaTeX and a `codeBlock` flattens to its code text.
- [ ] **KaTeX math NodeView (render in source + extract).** In `packages/editor` (the React side, e.g.
      `packages/editor/src/nodes/MathNodeView.tsx`) add a Tiptap `ReactNodeViewRenderer` (or a
      decoration) that renders the `math` node's `latex` via `katex.renderToString(latex, { displayMode:
      display, throwOnError: false })` into a NodeView span/div; it shows a parse-error indicator (not a
      crash) for bad LaTeX, and an inline edit affordance (click → edit the latex string) is optional/
      nice-to-have for v1 (authoring math can be a textarea in the builder). Install it in
      `SourceEditor` so SOURCE + EXTRACT bodies render math. Import `katex/dist/katex.min.css` once in
      the renderer.
- [ ] **Shiki code highlighting (render in source + extract).** A `codeBlock` NodeView (or a
      reader-decoration over `codeBlock`) in `SourceEditor` that highlights the block's text with the
      shared Shiki highlighter for the block's `language` (falling back to plain `<pre><code>` for an
      unbundled/absent language), swapping the highlighted HTML in asynchronously (render raw first).
      A `<select>`/inline control to set the block's `language` attr is a nice-to-have; at minimum the
      language is read from the stored attr (set on import via T068 / on authoring in the builder).
      Initialize ONE module-singleton highlighter (`createHighlighterCore` with the bounded
      language/theme set); theme tracks `data-theme` (light/dark) via `design/tokens.css`.
- [ ] **Review face renders math + code.** Today `CardFront` + `ReviewScreen` render `prompt`/`answer`
      as plain strings. Add a small **shared body renderer** (e.g. `apps/web/src/review/CardBody.tsx`,
      or fold into `CardFront`) that, given a card's prompt/answer text, renders **inline `$…$` / block
      `$$…$$` math via KaTeX and fenced ```lang code via Shiki** — so a Q&A card whose answer is a
      formula or a code snippet renders correctly in REVIEW, not as raw LaTeX/source. Reuse the SAME
      KaTeX/Shiki render path as the editor NodeViews (a shared `packages/editor` or
      `apps/web/src/lib` render helper) so source/extract/review look identical. Keep cloze masking
      intact (a cloze over code still masks `{{cN::…}}` then renders the revealed code highlighted).
      > **Wire BOTH render sites — the Q&A answer is a SEPARATE call site from `CardFront`.** In
      > `ReviewScreen` ([`ReviewScreen.tsx`](../../apps/web/src/review/ReviewScreen.tsx) ~line 493) the
      > Q&A **answer** is rendered inline as the raw string `(card.answer ?? "")` — it does NOT go
      > through `CardFront` (the prompt + the cloze body do). So the new `CardBody`/math+code renderer
      > must be wired into **both** `CardFront` (prompt + cloze) **and** that inline Q&A-answer branch
      > in `ReviewScreen`, or the prompt will render math/code while the answer stays raw LaTeX/source.
      > Replace BOTH the `CardFront` faces and the `(card.answer ?? "")` answer string with the shared
      > body renderer.
- [ ] **Code-specific card prompts.** Extend the card builder
      ([`CardBuilder.tsx`](../../apps/web/src/reader/CardBuilder.tsx)) so a code extract can become:
      - a **fill-in-the-blank** code card — a **cloze over a code span** (reuse the T034 cloze model:
        wrap a code token/line in `{{c1::…}}`; the front masks it, the back reveals the highlighted
        code). This is `kind: "cloze"` with a code body — NO new kind; the existing `cards.create`
        cloze path stores it.
      - a **predict-output** code card — a `kind: "qa"` card whose prompt is the code (rendered
        highlighted) and answer is the expected output. The existing `cards.create` Q&A path stores it;
        the builder offers a "Predict output" template that pre-seeds the prompt from the code extract.
      No new IPC/schema for these — they are `qa`/`cloze` cards with code/math bodies authored through
      the existing `cards.create`.
- [ ] **Code-aware card-quality checks.** Extend `evaluateCardQuality`
      ([`../../packages/core/src/card-quality.ts`](../../packages/core/src/card-quality.ts)) with
      pure, code-aware checks that DON'T false-fire on legitimate code (the existing length thresholds
      would over-warn on code): when the prompt/answer is detected as code (a fenced block / a
      `language`), apply a **line-count** threshold instead of a char/word threshold (e.g. warn when a
      code answer exceeds ~12 lines — "card spans too much code, narrow it") and **skip the
      ambiguous-pronoun heuristic** for code bodies (it is meaningless there). Keep the checks pure +
      unit-tested + threshold constants exported; the builder renders them via the existing `qc`
      checklist (T035) with no heuristic logic in the component.
- [ ] **Import round-trip (verify, light touch).** T068's Markdown/HTML import/export should preserve
      the code-fence **language** and math (e.g. `$$…$$`). Verify the importer maps a fenced
      ```` ```python ```` block to a `codeBlock` with `language: "python"` and a `$$…$$` to the `math`
      node; export emits them back. If T068's importer drops the language today, add the mapping (a
      small, in-scope fix — it is the same schema this task widens). Math import can be minimal (a
      `$$…$$` → `math` node) — document the supported delimiters.
- [ ] **Seed/fixtures.** Add to the desktop seed + `packages/testing` factories ONE source with a
      block formula + an inline formula + a `language`-tagged code block, plus a code fill-in cloze
      card and a math Q&A card — so source/extract/review show real math + highlighted code
      out-of-the-box and the E2E has seeded targets.
- [ ] **Tests (unit, editor):**
      - `schema.test.ts` (the roundtrip): a doc with a BLOCK formula (`math` `display:true`,
        block-id-bearing), an INLINE formula (`math` `display:false` inside a paragraph), and a
        `codeBlock` with `language: "ts"` round-trips through `buildSchema()`/`Node.fromJSON`/`toJSON`
        with stable block ids; `ALLOWED_NODE_NAMES` now contains `"math"`; no disallowed node/mark
        leaks.
      - A KaTeX render unit test (the latex → HTML helper renders `E=mc^2`, returns a parse-error span
        for bad LaTeX without throwing).
      - A Shiki highlight unit test (a `ts` block highlights; an unbundled language returns plain
        `<pre><code>` with the code intact; the singleton is reused).
      - `serialize.test.ts`: `toPlainText(doc)` emits the LaTeX + code text for a math/code doc
        (the search/preview `plainText` mirror).
- [ ] **Tests (unit, core)** — `card-quality.test.ts`: a long code answer warns on the LINE threshold
      (not the char threshold); the ambiguous-pronoun check is skipped for a code body; a normal
      short code card returns `ok`; thresholds match the exported constants.
- [ ] **Tests (component)** — a `CardBody`/`CardFront` test: a Q&A card with a `$$…$$` answer renders a
      KaTeX node; a card with a ```` ```python ```` answer renders a highlighted (or plain-fallback)
      code block; a code cloze masks `{{cN::…}}` then reveals highlighted code. A `SourceEditor`/extract
      render test that a math block + a code block render in the body.
- [ ] **Tests (E2E, Electron)** — `tests/electron/formula-code-cards.spec.ts`: open the seeded source →
      see a rendered block formula + a highlighted code block in the READER → open an extract of a code
      snippet → author a **fill-in code cloze** + a **math Q&A** card → enter review → the math card
      renders the formula (not raw LaTeX) and the code card renders highlighted (or plain) code on
      reveal, grade Good → after an **app restart** the source body, the cards, and their rendered
      math/code all survive.
- [ ] **Docs** — check the T072 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line noting: the `math` node + `codeBlock` `language` schema extension, KaTeX +
      Shiki as the chosen libs, the source/extract/review render path, and the code-card prompts +
      quality checks.

### Done when

- The constrained editor schema renders **math** (KaTeX, block + inline) and **syntax-highlighted
  code** (Shiki, per the `codeBlock` `language` attr) correctly in **SOURCE** (the reader editor),
  **EXTRACT** (the same editor in the extract view), and **REVIEW** (the card faces — the prompt/answer
  body renderer renders math + code, not raw strings).
- The schema growth is an **explicit, reviewed, tested** change: `ALLOWED_NODE_NAMES` gains `"math"`,
  `codeBlock` gains a `language` attr, both carry **stable block ids**, and the `schema.roundtrip` test
  asserts a math + code doc round-trips through `buildSchema()` with no disallowed node/mark.
- **Code-specific card prompts** (fill-in-the-blank cloze over code; predict-output Q&A) integrate the
  **existing `cards.create`** path (no new kind / IPC / schema) and the **existing card-quality** path
  (with code-aware, pure, unit-tested checks that don't false-fire on code).
- Rendering is **100% on-device** — KaTeX CSS/fonts + the Shiki grammars/themes (+ the `onig.wasm`
  only if the WASM engine is chosen) are bundled as local Vite assets, NO
  CDN/network; an unsupported code language degrades gracefully to plain code; bad LaTeX shows a
  parse-error indicator, never a crash.
- An Electron E2E renders math + highlighted code in the reader, authors a code cloze + a math Q&A,
  reviews them, and — after an **app restart** — the body + cards + rendered math/code survive.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass; any schema
  migration (only if a stored-shape change is unavoidable — math/code are JSON-attr changes that need
  NO table migration) applies cleanly. **Note:** the `math` node + `codeBlock` `language` attr are
  changes to the ProseMirror document JSON shape stored in the existing `documents`/`document_blocks`
  columns — they need **NO Drizzle migration** (the document body is a JSON/text column); only the
  schema definition + renderers change. (Contrast T071, which DOES migrate because it touches a CHECK
  + a new table.)

### Notes / risks

- **KaTeX over MathJax; Shiki over highlight.js — both bundled, offline.** The roadmap line says
  "MathJax/LaTeX" — KaTeX renders the SAME LaTeX, faster + synchronously + offline, and is the better
  fit for NodeViews. Justify the substitution in the Progress-log. Bundle KaTeX CSS/fonts + a bounded
  Shiki language/theme set as renderer assets — NEVER a CDN (local-first, no network).
- **One render path, three surfaces.** Math/code MUST render identically in source, extract, and
  review — share the KaTeX/Shiki render helpers between the editor NodeViews and the review face so the
  three surfaces never drift. A card whose body renders one way in the builder and another in review is
  a bug.
- **Store the latex/code as clean text, render at display time.** The stored document JSON keeps the
  raw LaTeX string + the raw code + language — NEVER pre-rendered HTML — so a re-render (theme change,
  re-import, future engine swap) is clean and search/`plainText` works. Highlighting + typesetting are
  render-time concerns.
- **Schema discipline.** This is the schema's intended growth path (an explicit reviewed change with a
  roundtrip test) — do NOT smuggle in tables/images/other nodes alongside it; add ONLY `math` + the
  `codeBlock` language attr. The narrow schema is load-bearing for block-id/mark/extraction logic.
- **Async highlight, never block paint.** Render raw code first, swap highlighted HTML when Shiki is
  ready; an unbundled language stays plain. Initialize one shared highlighter singleton.
- **Code cards are `qa`/`cloze`, not a new kind.** A code card is a Q&A or cloze card with a code body
  — it reuses `cards.create`, the cloze model, and the card-quality function. The ONLY new card kind in
  M15 is T071's `image_occlusion`; code/formula add NO kind.
- **Downstream:** T073–T075 (video/audio) reuse the review-face body-render pattern this task
  establishes; keep the body renderer composable so an audio/media card face can reuse it.

---

## Exit criteria for the M15 occlusion/formula subset (T071–T072)

- T071 + T072 are `[x]` in [`../roadmap.md`](../roadmap.md) with commit refs + Progress-log lines.
- A user can stand on a **`media_fragment` image extract**, draw **mask regions**, and generate
  **N sibling `image_occlusion` cards** (masks stored separately from the immutable base image),
  reviewed with the base image one-region-masked — a new **card variant** on the existing
  card/review/FSRS substrate, surviving an **app restart**.
- **Math** (KaTeX) + **syntax-highlighted code** (Shiki, `codeBlock` `language` attr) render correctly
  in **source, extract, AND review**, via an explicit, reviewed, roundtrip-tested schema extension with
  stable block ids; **code-specific card prompts** (code cloze fill-in, predict-output Q&A) ride the
  existing `cards.create` + card-quality path with code-aware checks — no new card system.
- Both are **100% on-device**: image bytes in the vault (T059), masks as vector regions in SQLite,
  KaTeX/Shiki assets bundled — NO app-level S3, NO CDN, NO server, NO AI.
- Every new mutation runs in **one transaction**, appends the correct **existing** `operation_log` op
  (`create_card` + `add_relation` + `add_tag` for occlusion generation; `update_document` for an edited
  math/code body), and reaches the renderer **only** through the typed `window.appApi` (the new
  `cards.generateOcclusion` for T071; the reused document + `cards.create` shapes for T072) — **no raw
  DB/filesystem access in the renderer, no `db.query`**.
- The T071 migrations (`cards.kind` CHECK widening + the `occlusion_masks` table) apply cleanly; T072
  needs **no** table migration (document-JSON-shape change only).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the T071/T072 Playwright specs (occlusion generate +
  review + restart; math/code render in source/extract/review + restart) are green.

The media subset (T073–T075) is specified in the sibling file
[`M15-media.md`](./M15-media.md) — build it from there (it depends only on the M12 vault/runner +
M7 FSRS substrate, not on T071/T072, so the two lanes can land in either order or in parallel).
