# M15 — Rich media: video import, clip extraction & audio cards (T073–T075)

Detailed, buildable specs for the **media subset of M15** (T073–T075). T071 (image occlusion)
and T072 (formula & code cards) are the OTHER half of M15 and have their own spec file
([`M15-occlusion-formula.md`](./M15-occlusion-formula.md)); this file is the **video / audio**
lane and depends only on the M12 vault + runner infra (T058/T059) and the M7 FSRS review
substrate (T036).

After these three tasks the desktop app can take in **video sources** (a local file or a YouTube
URL), read them incrementally with a **timestamped read-point** + (when available) an on-device
**transcript**, **clip** a start/end span into a scheduled **`media_fragment`**, and build an
**audio review card** that loops a clip as its prompt/answer — all **100% on-device**:

- **T073** — the user imports a `.mp4`/`.webm`/`.m4a`/`.mp3` (or pastes a YouTube URL); the
  **Electron main process** streams the original media bytes into the filesystem asset vault
  (`assets/sources/<source_id>/original.<ext>`, via the T059 `AssetVaultService.importAsset`,
  `video`/`audio` kind), fetches metadata + a transcript **on-device** (oEmbed + available
  captions for YouTube, file metadata for a local file), builds a constrained ProseMirror
  document where the transcript is a run of **timestamp-tagged** paragraphs (one per cue, stable
  block ids), and creates an **inbox** `source` through the existing transactional pipeline. The
  reader plays the media via an HTML5 `<video>`/`<audio>` element, tracks a **timestamp read-point**,
  and degrades gracefully when no transcript exists.
- **T074** — selecting a **start/end timestamp** (or selecting transcript text whose cues carry
  timestamps) creates a scheduled **`media_fragment`** extract whose `source_locations` row carries
  the **start `timestamp_ms` + a clip `{ startMs, endMs }`** and whose body holds the transcript
  segment. It stores **timestamps + a reference to the original media** (NO re-encoding) and is
  **attention-scheduled** (NOT FSRS). Lineage back to the video source is preserved.
- **T075** — from a media fragment, an **audio card** plays a **looped clip** of the original media
  (between `startMs`/`endMs`) as its prompt and/or answer; it is a `card` element reviewed as
  **active recall through FSRS** (the existing review session + sibling burying), not a parallel
  system. The audio is the existing `card` model extended with an `audio`/`looped-fragment`
  presentation, NOT a new card table.

Everything obeys the established architecture (see [`../../CLAUDE.md`](../../CLAUDE.md) +
[`../architecture.md`](../architecture.md)): the React renderer (`apps/web`) calls the narrow typed
`window.appApi` bridge; the Electron main (`apps/desktop`) validates the IPC payload (Zod) and
routes to `packages/local-db` repositories + the pure `@interleave/importers` package; the
multi-table mutation runs in ONE SQLite transaction and appends `operation_log` entries; large
binaries (the original media file, an optional poster thumbnail) go to the filesystem vault via the
T059 `AssetVaultService` — **never SQLite, never an app-facing S3**; any network fetch (YouTube
metadata/captions) runs on-device in the Electron main or the T058 runner — **never a server**; the
renderer never touches Node, the network, the filesystem, or SQLite. Everything **survives an app
restart**.

> **Local-first (roadmap M15 header, lines ~261–262).** "image/video/audio bytes live in the **asset
> vault** (T059), transcoding/clipping runs on the **local background runner** (T058); no app-level
> S3, no server processing." These specs are built directly ON the infra that already shipped: the
> `UrlImportService`/`PdfImportService`/`EpubImportService` source-pipeline pattern, the
> `AssetVaultService` streamed importer (which already declares `video`/`audio` asset kinds), the
> `JobRunner` + `jobs` table + `job-worker.cjs` + the apply-handler registry, and the M6/M7 card +
> FSRS review substrate. Reuse them — do **not** rebuild a parallel import/runner/vault/card stack.

## Scope honesty — what this milestone deliberately does NOT do

Read this before estimating: media is a place where it is very easy to over-build. The local-first
constraint is a feature here, not a limitation.

- **No transcoding / re-encoding of media.** A clip is a **`{ startMs, endMs }` window onto the
  ORIGINAL file**, played by seeking the HTML5 element — never a cut/re-exported sub-file. This is
  the single most important scope decision: it means **no `ffmpeg` is bundled** (a ~70 MB native
  binary that would need `asarUnpack` + per-platform builds, dwarfing the whole app). The original
  media is the source of truth; clips and cards reference it by time. If a future task genuinely
  needs a standalone exported clip (none does today — backup/export ships the original + the
  manifest), that is a separate, justified `ffmpeg`/`ffmpeg.wasm` decision, NOT this milestone.
- **No video DOWNLOAD for YouTube.** Downloading a YouTube video (`yt-dlp`/`youtube-dl`) is brittle
  (breaks on every YouTube change), legally fraught, and heavyweight. T073 imports a YouTube URL as
  a **referenced/embedded** source (the canonical URL + the on-device-fetched metadata + transcript
  live in SQLite/the body), played via the YouTube IFrame embed in the reader — the bytes are NOT
  pulled into the vault. A **local** video file IS streamed into the vault (the user owns those
  bytes). The two cases are clearly distinguished by `mediaSource: "local" | "youtube"`.
- **No speech-to-text in this milestone.** A transcript comes from **existing captions** (YouTube's
  published caption track, or a sidecar `.vtt`/`.srt` the user picks alongside a local file) — NOT
  from running ASR (Whisper) on the audio. On-device ASR is a real future option (a `transcribe` job
  on the T058 runner, mirroring the `ocr` job), but it is out of scope for T073; the milestone must
  **degrade gracefully when no transcript exists** (a playable source with timestamp read-points and
  manual clip selection, no transcript pane). On-device ASR is noted as a clean downstream extension.
- **No new scheduler.** A `media_fragment` rides the EXISTING attention scheduler (T028); an audio
  card rides the EXISTING FSRS scheduler (T036). The two-scheduler split is preserved exactly — a
  media fragment never gets a `review_states` row; an audio card always does.

Read first:
- [`../architecture.md`](../architecture.md) — the asset-vault layout (`assets/media/<asset_id>/
  original.bin, thumbnail.webp`, `assets/sources/<source_id>/…`), the **"No large blobs in SQLite"**
  rule, the **on-device runner** note, and the planned `packages/importers/` import-logic home.
- [`../domain-model.md`](../domain-model.md) — `media_fragment` ("a timestamped/region clip (PDF
  region, **video/audio clip**, image)", line ~16); `source_locations` columns
  (`block_ids[], start_offset, end_offset, page, timestamp_ms, region, label, selected_text`, lines
  ~123 — note **`timestamp_ms` ALREADY EXISTS in the live schema**; T074 adds the clip
  `{ startMs, endMs }`); the `cards` columns (line ~127); the `assets` columns
  (`width, height, duration_ms`, line ~135 — `duration_ms` exists); the `operation_log` vocabulary
  (lines ~163–166, a closed set of 15).
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the FSRS-vs-attention table
  (cards = FSRS, sources/topics/extracts = attention); a `media_fragment` is an **attention** item.
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Electron runtime & security", "Asset vault", "SQLite rules",
  "Data rules", "Document/editor rules" (stable block ids, source locations, lineage), "Scheduling
  rules", "Review rules", "Card-quality rules".
- [`../design-system.md`](../design-system.md) — the `--el-media` (magenta) element color, the
  `SchedulerChip` split, the `screen-reader`/`screen-review` surfaces a media reader/card slots into.
- Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md) (REQUIRED shape). Format/depth exemplars:
  [`M2-capture-and-inbox.md`](./M2-capture-and-inbox.md), [`M6-cards.md`](./M6-cards.md) (the card
  model + `cards.create` + the two-scheduler split), [`M7-fsrs-review.md`](./M7-fsrs-review.md) (the
  review session + grade path), and the sibling [`M14-pdf-ocr.md`](./M14-pdf-ocr.md) (the
  `PdfImportService`/`PdfRegionService` source+region pattern T073/T074 mirror, the `source_locations`
  page/region precedent T074 follows for `timestamp_ms`/clip, the T059 vault + T058 runner).

## What already exists (confirmed by inspecting the repo — do NOT rebuild these)

- **`AssetVaultService.importAsset`** in
  [`../../apps/desktop/src/main/asset-vault-service.ts`](../../apps/desktop/src/main/asset-vault-service.ts)
  (`ImportAssetInput` ~line 74, `async importAsset` ~line 164): STREAM-writes a binary to the vault
  while hashing (no whole-file-in-memory), dedups on content hash, and records `AssetRepository`
  metadata in ONE transaction. It accepts `source: string | NodeJS.ReadableStream`, a `kind:
  AssetKind`, an optional `destRelativePath`, and **`width?`/`height?`/`durationMs?`** (~lines 89–91)
  — exactly the dimensions a video/audio asset needs. **The `"video"` and `"audio"` kinds ALREADY
  EXIST** in `ASSET_KINDS` ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts)
  ~lines 162–163). This is how a local media file reaches the vault — bytes never touch SQLite.
- **`SourceRepository.createWithDocument` / `createWithDocumentWithin(tx, input)`** in
  [`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts):
  creates the `source` element + `sources` provenance row + `documents` body + stable
  `document_blocks` in ONE transaction (logging `create_element` + `create_source` +
  `update_document`). It accepts a **pre-built `conversion: PlainTextConversion`** (`{ doc, plainText,
  blocks }`) and a **pre-minted `id?: ElementId`** so the vault path is known before the row. **T073's
  video importer threads its transcript-doc `conversion` through this exact seam** — the same way the
  PDF/EPUB importers do.
- **`ExtractionService.createExtraction` + `createRegionExtract`** in
  [`../../packages/local-db/src/extraction-service.ts`](../../packages/local-db/src/extraction-service.ts)
  (`CreateExtractionInput` ~line 71 carries `page?` ~line 98; `createRegionExtract` ~line 261 mints a
  **`media_fragment`** element + a `source_locations` row with `page`+`region`). **T074's clip extract
  is the SAME shape as `createRegionExtract`** — a `media_fragment` whose `source_locations` carries
  `timestamp_ms` + a clip window instead of `page`+`region`. The `source_locations` table already has
  `timestampMs` ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts)
  ~line 71); T074 adds the clip column beside it.
- **`PdfRegionService`** in
  [`../../apps/desktop/src/main/pdf-region-service.ts`](../../apps/desktop/src/main/pdf-region-service.ts):
  the construction-time-injected (`{ db, repositories, extraction, assetVault }`) region-extract
  orchestrator — **the EXACT pattern `MediaClipService` (T074) mirrors** (mint element id up front →
  create the `media_fragment` in one transaction → optional asset import keyed by the now-existing id
  → soft-delete rollback on failure). T074 has NO image to import (a clip references the original),
  so it is *simpler* than `PdfRegionService` — one transaction, no asset step.
- **`PdfImportService`** in
  [`../../apps/desktop/src/main/pdf-import-service.ts`](../../apps/desktop/src/main/pdf-import-service.ts)
  + **`EpubImportService`** in
  [`../../apps/desktop/src/main/epub-import-service.ts`](../../apps/desktop/src/main/epub-import-service.ts):
  the construction-time-injected source-pipeline orchestrators (`importFromFile` → validate → stream
  into vault → parse → one transaction → `InboxItemSummary`; rollback removes the partial vault dir).
  **`MediaImportService` (T073) mirrors these.** The shared file picker `sources.pickImportFile`
  (`PickImportFileRequestSchema` ~line 946, kinds `epub`/`markdown`/`html`/`highlights`/`anki`) is the
  picker T073 EXTENDS with a `media` kind (and a `subtitles` kind for the optional sidecar transcript).
- **The card model + `CardService`** in
  [`../../packages/local-db/src/card-service.ts`](../../packages/local-db/src/card-service.ts)
  (`CardService.createFromExtract` ~line 146; its input `CreateCardFromExtractInput` ~line 70,
  `kind: CardKind`, `prompt`/`answer`/`cloze`, `siblingGroupId`) +
  `ReviewRepository.createCard`/`createCardWithin`
  ([`../../packages/local-db/src/review-repository.ts`](../../packages/local-db/src/review-repository.ts))
  + the `cards` table (`elementId`, `kind`, `prompt`, `answer`, `cloze`, `sourceLocationId`,
  `sourceUri`, `isLeech` — [`../../packages/db/src/schema/cards.ts`](../../packages/db/src/schema/cards.ts)).
  **T075's audio card is a `card` element with `kind` extended for audio + a clip reference** — NOT a
  new table. The `cards.create` IPC command (channel `cardsCreate`) is the seam to extend.
- **The FSRS review substrate** — `CardSchedulerService` (the `ts-fsrs` wrapper,
  [`../../packages/scheduler/src/card-scheduler.ts`](../../packages/scheduler/src/card-scheduler.ts)),
  `ReviewSessionService` (sibling burying,
  [`../../packages/local-db/src/review-session-service.ts`](../../packages/local-db/src/review-session-service.ts)),
  the `review.session.next`/`review.preview`/`review.grade` IPC (channels `reviewSessionNext`/
  `reviewPreview`/`reviewGrade`), the `ReviewCardView` contract type
  ([`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts) ~line 2251),
  the `ReviewScreen` + `CardFront` ([`../../apps/web/src/review/`](../../apps/web/src/review/)). **An
  audio card flows through this UNCHANGED** except for an audio prompt/answer renderer in `CardFront`
  and three new fields on `ReviewCardView`. The renderer does NO FSRS math.
- **The reader shell** — `SourceReader`
  ([`../../apps/web/src/pages/source/SourceReader.tsx`](../../apps/web/src/pages/source/SourceReader.tsx))
  swaps in a `PdfReader` body when `doc.sourceFormat === "pdf"` (~line 550). **T073 adds a
  `MediaReader` swapped in when `doc.sourceFormat === "video"`** (an HTML5 `<video>`/`<audio>` + a
  transcript pane + a timestamp read-point). The `DocumentsGetResult.sourceFormat` field
  ([`contract.ts`](../../apps/desktop/src/shared/contract.ts) ~line 1570, currently `"pdf" | null`)
  widens to `"pdf" | "video" | null`.
- **The read-point substrate** — `read_points` (block id + offset, NOT a `sources` column —
  [`../../packages/db/src/schema/relations.ts`](../../packages/db/src/schema/relations.ts) ~line 45) +
  `readPoints.get`/`readPoints.set` IPC. **A video read-point is a timestamp**, modeled by mapping the
  current playback time → the **transcript cue's stable block id** (so it reuses `read_points` unchanged
  when a transcript exists) and resuming the player at that cue's `document_blocks.timestamp_ms`. For a
  **transcript-less** video there is no cue block to key off, so the read-point keys off the **title
  heading block id** with the `read_points.offset` repurposed to carry the **raw second** (offset is an
  integer column already; store `floor(currentTimeMs)` there) — keeping the existing `read_points`
  table the single read-point store, with no new `sources` column. Document this offset-as-seconds
  convention for the transcript-less case in `MediaReader`.
- **The IPC seam** — channels
  [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts)
  (`sourcesImportPdf`, `sourcesImportEpub`, `sourcesPickImportFile`, `sourcesExtractRegion`,
  `sourcesGetRegionImage`, `cardsCreate`, `reviewSessionNext`/`reviewGrade`, …), contract
  [`contract.ts`](../../apps/desktop/src/shared/contract.ts), the router
  [`ipc.ts`](../../apps/desktop/src/main/ipc.ts), the DB service
  [`db-service.ts`](../../apps/desktop/src/main/db-service.ts) (its lazily-built service accessors +
  `open(dbPath, { migrationsDir, nativeBinding, assetsDir, allowLoopbackImport })`), the preload
  [`preload/index.ts`](../../apps/desktop/src/preload/index.ts), and the renderer client
  [`appApi.ts`](../../apps/web/src/lib/appApi.ts).
- **The inbox import strip** in
  [`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx)
  (`IMPORT_OPTS` declaration ~line 64, first chip ~line 71 — live `Paste URL`/`Paste text`/`Import
  PDF`/`Import file`/`Browser capture`/`Manual note` chips). **T073 adds an `Import media` chip** (a
  `media` action → the native
  picker) and the YouTube case rides the EXISTING **Paste URL** path (the `UrlImportService` detects a
  YouTube URL and routes to the media importer instead of Readability — see T073).

## What is missing and this milestone adds

- A `video`/`audio` **source format** end-to-end: a `MediaImportService` (mirrors
  `PdfImportService`/`EpubImportService`), `sources.importMedia` / a `media`+`subtitles` picker kind,
  and the `sourceFormat: "video"` flag on `documents.get`.
- On-device **YouTube metadata + transcript** fetch (oEmbed + the timedtext caption track) and a
  **sidecar `.vtt`/`.srt` parser** in `@interleave/importers` (pure, fixture-tested) for local files.
- A **transcript → ProseMirror** transform (timestamp-tagged paragraphs with stable block ids) and a
  **`document_blocks.timestamp_ms` column** (the cue→time map, mirroring T064's `document_blocks.page`).
- A **clip `media_fragment`** path: a `source_locations` **clip column** (`{ startMs, endMs }`) + a
  `MediaClipService` (mirrors `PdfRegionService`, no asset step) + `sources.extractClip`.
- An **audio card** variant: a `cards.media_ref` clip pointer (so the card knows which clip to loop) +
  a widened `CARD_KINDS`/card presentation + the `ReviewCardView` audio fields + a `CardFront` audio
  renderer + `cards.create` accepting a media-card request.
- A renderer **`MediaReader`** (HTML5 player + transcript pane + timestamp read-point + clip selection)
  and an **audio-card review** affordance (a looping `<audio>` in the card face).

Build order is the task order: **T073** (the video source) is the foundation; **T074** (clip
extraction) needs the playable source + transcript timestamps; **T075** (audio card) needs a clip to
loop + the FSRS review substrate (T036). T073 wires ONE real local video AND one YouTube URL
end-to-end; T074 and T075 extend it.

---

## T073 — Video import

- **Status:** `[ ]` not started  · **Depends on:** T059 (the `AssetVaultService` streamed importer —
  the original media bytes go through it; `video`/`audio` kinds already declared). In practice also
  T018 (the source reading-mode shell the media reader extends), T060/T064/T067 (the
  `createWithDocument` pre-built-`conversion` + pre-minted-`id` seam, the `@interleave/importers`
  package, the `UrlImportService`/`PdfImportService`/`EpubImportService` construction-time-injected
  source-service pattern + shared file picker — all shipped, so concrete deps even though the roadmap
  line predates them).
- **Roadmap line:** Done when YouTube/local video metadata + transcript (if available) + timestamped
  read-points create video sources resumable from a saved timestamp.

### Goal

A user imports a **local media file** (`.mp4`/`.webm`/`.mov`/`.m4a`/`.mp3`/`.wav`) OR pastes a
**YouTube URL**, and the app brings it in as an **inbox `source`**, fully on-device. For a local
file, the Electron **main process** streams the original bytes into the vault
(`assets/sources/<source_id>/original.<ext>`, via `AssetVaultService.importAsset`, `video` or `audio`
kind, with `durationMs`). For a YouTube URL, main fetches **oEmbed metadata** (title/author/thumbnail)
+ the **available caption track** on-device — the bytes are NOT downloaded (the source references the
canonical URL + embeds the player). Either way, when a **transcript** is available (YouTube captions,
or a sidecar `.vtt`/`.srt` the user optionally picks beside a local file), main builds a constrained
ProseMirror document where **each cue is a timestamp-tagged `paragraph`** with a stable block id; when
no transcript exists, the body is a single placeholder paragraph and the reader degrades to
plain-playback + manual timestamp read-points (no transcript pane). The `source` is created through
the existing transactional pipeline (`createWithDocument`, one transaction, `create_element` +
`create_source` + `update_document`). The `/source/$id` reader plays the media via an HTML5
`<video>`/`<audio>` element (or the YouTube IFrame embed for a YouTube source), tracks a **timestamp
read-point** (resume near the saved second on reopen), and the new video source appears in the inbox
immediately and survives an app restart. The renderer never reads the file, never fetches the
transcript, and never touches the vault.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) (vault layout + no-blobs rule + on-device
  runner), [`../domain-model.md`](../domain-model.md) (`media_fragment`, `source_locations.timestamp_ms`,
  `assets.duration_ms`, `raw_source`/`inbox`), [`../design-system.md`](../design-system.md) +
  `--el-media`.
- Existing code to inspect: `AssetVaultService.importAsset` (`video`/`audio` kinds, `durationMs`);
  `SourceRepository.createWithDocumentWithin` + `CreateSourceWithDocumentInput`; the widened
  `PlainTextConversion`/`ProseMirror*` types
  ([`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts));
  `buildSchema`/`newBlockId`/`shouldCarryBlockId`/`BLOCK_ID_NODE_TYPES`; the
  `PdfImportService`/`EpubImportService` pattern + their `runPipeline`/rollback discipline; the shared
  `PickImportFileRequestSchema`; the `documents.get`/`readPoints.*` contract + `SourceReader.tsx`; the
  `UrlImportService` ([`../../apps/desktop/src/main/url-import-service.ts`](../../apps/desktop/src/main/url-import-service.ts))
  — its **injectable `fetchImpl?: typeof fetch`** seam (`UrlImportServiceDeps` ~line 110, defaulting to
  the Node global `fetch`; `url-import-host.ts` is the SSRF host classifier the fetch composes, NOT the
  fetch itself); `AppPaths.assetsDir`; the inbox import strip; `document_blocks.page` precedent (T064).
- Invariants in play: renderer never touches fs/network/SQL; the file read + media-metadata/transcript
  fetch + vault write run **main-side**; the multi-table mutation is one transaction + logged; source
  lineage is preserved (a video source is a clean lineage root with a transcript body + the original
  media snapshot/reference); asset bytes live in the vault (never SQLite); the produced transcript doc
  validates against the constrained schema with stable block ids; a video source is
  **attention-scheduled** (a topic-like source), NOT FSRS; new material defaults to a **non-dominating**
  priority (`C`).

### Dependencies to add (concrete, justified)

- **`subsrt-ts`** (`^2.x`, MIT) — a tiny, dependency-free, pure-TS subtitle parser that reads **both
  WebVTT and SRT** (the two formats YouTube captions + sidecar files ship in) into a typed cue list
  `{ start: ms, end: ms, text }`. Add it to `packages/importers` `dependencies` (main-side parse only;
  it is pure JS and bundles into `main.cjs` via esbuild). **Justification over alternatives:** writing
  a VTT/SRT parser by hand is error-prone (cue timing edge cases, `\r\n`, styling tags); `node-webvtt`
  is VTT-only and heavier; `subtitle` (npm) is stream-based and awkward for a one-shot parse.
  `subsrt-ts` is the smallest correct option that handles both formats with one call. (If a review
  prefers zero new deps, a ~60-line VTT/SRT parser in `@interleave/importers` is acceptable — but it
  MUST be fixture-tested against the cue-timing edge cases below; prefer the library.)
- **YouTube metadata/transcript — NO new dependency.** oEmbed
  (`https://www.youtube.com/oembed?url=…&format=json`) returns title/author/thumbnail as plain JSON —
  a single keyless GET, the reliable part. The **transcript is materially more fragile**: there is no
  stable, documented caption endpoint, so discovering the `timedtext` URL means GETting the **watch
  page** and parsing its `ytInitialPlayerResponse` (`captionTracks[].baseUrl`) before a second GET for
  the caption XML — and YouTube increasingly returns bot-checks / empty bodies for server-side
  watch-page fetches. So treat it as **two reliable steps for metadata (oEmbed) and a best-effort,
  parse-the-watch-page discovery for captions**, NOT three guaranteed plain GETs. Both are fetched with
  the **existing main-side fetch** the
  `UrlImportService` already exposes (its injectable `fetchImpl: typeof fetch`, defaulting to the Node
  global `fetch`) — no `googleapis`/`ytdl` package. **Justification:** `ytdl-core`/`youtube-dl` pull megabytes of
  brittle scraping logic; the API-key'd YouTube Data API violates
  local-first (a key + a quota'd Google call). oEmbed + watch-page-discovered timedtext are keyless,
  on-device, and **degrade gracefully** — a discovery/parse/fetch failure on the caption track is just
  the `transcript: null` path (the source imports as a transcript-less embedded video), never a crash
  and never a failed import. Treat the transcript fetch as **best-effort** — a failure NEVER fails the
  import; the load-bearing decision is the graceful transcript-less degrade, not the discovery method.
- **NO `ffmpeg`, NO `ytdl`, NO ASR.** See "Scope honesty" — clips are time windows on the original; a
  YouTube import references the URL; transcripts come from captions, not speech-to-text. Pulling any
  of these is out of scope and must be justified as a separate task if ever needed.

### The transcript-mapping model (specify concretely)

A transcript has no semantic blocks, so the importer imposes a deterministic, lineage-stable structure
(mirroring T064's page-mapping model):

- **One `heading` (level 2) with the media title** opens the body, followed by **one `paragraph` per
  caption cue**. Each cue paragraph carries a stable `blockId` (via `newBlockId`, injectable for tests)
  and its **start `timestampMs`** in the parallel `blocks` list (→ a new `document_blocks.timestamp_ms`
  column — the canonical block→time map the read-point + clip paths read). A cue's text is the cue
  string with inline styling tags stripped.
- **No transcript** (a transcript-less local file, or a YouTube video with captions disabled) → a VALID
  doc with the title heading + ONE placeholder paragraph ("No transcript available — play the media and
  set timestamp read-points; clip by selecting a start/end time.") and `plainText` = the title. The
  source is never lost; T074 still works via manual timestamp selection. `document_blocks.timestamp_ms`
  is `null` for the placeholder.
- `plainText` is the cue texts joined with spaces (timestamp-prefixed, e.g. "[0:42] …") for
  search/preview — the SAME `plainText` mirror the other importers produce.
- **Cue timing edge cases the parser MUST handle** (fixture-tested): overlapping cues, a cue with no
  end time, `\r\n` line endings, an empty/whitespace cue (dropped), a cue with `<c>`/`<i>` styling tags
  (stripped to text), SRT comma-millisecond vs VTT dot-millisecond, and a BOM-prefixed file.

### Deliverables

- [ ] **`document_blocks.timestamp_ms` column + migration.** Add a nullable `timestampMs:
      integer("timestamp_ms")` to the `documentBlocks` table
      ([`../../packages/db/src/schema/documents.ts`](../../packages/db/src/schema/documents.ts)) — the
      canonical block→time map for media sources; `null` for non-media bodies (a pure widening, no
      backfill needed). Run `pnpm db:generate` to produce the next Drizzle migration (nominally
      `0014_*` — the latest committed is `0013`; **take whatever number `db:generate` emits**); commit
      the generated SQL **under `packages/db/drizzle/`** (the Drizzle `out` dir, beside `0013_*.sql`).
      Update the block mapper / any block reader that constructs `document_blocks`
      inserts to forward the per-block `timestampMs`.
      > **Migration numbering + location.** `pnpm db:generate` always emits the next sequential number
      > in build order, writing the SQL into **`packages/db/drizzle/`** (the Drizzle `out` dir set in
      > `packages/db/drizzle.config.ts`, where `0013_*.sql` already lives — NOT a `migrations/` folder).
      > T073/T074/T075 add migrations on top of `0013`; the numbers here (`0014`/`0015`/`0016`)
      > are nominal — keep each task's schema change in its own reviewable migration committed under
      > `packages/db/drizzle/`, and rebase to the generated number; do NOT hand-renumber.
- [ ] **Widen `PlainTextConversion` blocks with an optional `timestampMs`.** In
      [`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts), add an
      optional `readonly timestampMs?: number | null` to the `ProseMirrorBlock` (alongside the `page`
      T064 added). Backward-compatible (existing converters omit it). `createWithDocumentWithin` then
      writes `timestampMs: block.timestampMs ?? null` into each `document_blocks` insert. Add a unit
      test that a `conversion` with per-block timestamps stores them and an HTML conversion stores
      `null`.
- [ ] **Pure transcript transforms in `@interleave/importers`:**
  - [ ] **`parseTranscript(text: string, format: "vtt" | "srt" | "auto"): TranscriptCue[]`** in
        `packages/importers/src/transcript.ts`, where `TranscriptCue = { startMs: number; endMs:
        number | null; text: string }`. Wraps `subsrt-ts` (or the hand-rolled parser), strips styling
        tags, drops empty cues, sorts by `startMs`, and handles the cue-timing edge cases above. No
        `fs`, no Electron, no network — string in, structured cues out.
  - [ ] **`transcriptToProseMirrorDoc(input: { title: string; cues: TranscriptCue[] }, mint?:
        BlockIdMinter): PlainTextConversion`** in `packages/importers/src/transcript-to-prosemirror.ts`.
        Walks `cues` into the SAME `{ doc, plainText, blocks }` shape per the transcript-mapping model:
        a `heading` (level 2) title + one `paragraph` per cue, each row-bearing node minted a stable
        `blockId` (default `newBlockId`, injectable) and tagged with its **`timestampMs`** in the
        parallel `blocks` list. NO transcript → the title heading + ONE placeholder paragraph. The
        output MUST validate against `buildSchema()` (assert `Node.fromJSON(buildSchema(), doc)` does
        not throw; every node ∈ `ALLOWED_NODE_NAMES`, every mark ∈ `ALLOWED_MARK_NAMES`).
  - [ ] **`fetchYouTubeMetadata(url, fetch): Promise<YouTubeMeta>`** in
        `packages/importers/src/youtube.ts` — `YouTubeMeta = { videoId: string; title: string; author:
        string | null; thumbnailUrl: string | null; canonicalUrl: string; transcript: TranscriptCue[]
        | null }`. Takes an **injected `fetch: typeof fetch`** (so it is pure/testable — the caller
        passes `UrlImportService`'s `fetchImpl`; no Node `fetch` import in the pure module) and:
        normalizes the URL → videoId, GETs oEmbed for metadata, then **best-effort discovers the
        caption track by GETting the watch page and parsing `ytInitialPlayerResponse` →
        `captionTracks[].baseUrl`, then GETs that timedtext URL** → `parseTranscript`. Treat the whole
        caption path as best-effort: a missing player response, a bot-check/empty body, a missing
        track, or a fetch/parse failure ALL return `transcript: null` (the graceful transcript-less
        path), never an exception; only a failure on **oEmbed** throws a
        typed `YouTubeImportError` the importer maps. Add a `isYouTubeUrl(url): boolean` helper.
  - [ ] Export all from `packages/importers/src/index.ts`. Add `subsrt-ts` to
        `packages/importers/package.json` dependencies.
- [ ] **Main-side `MediaImportService`** in `apps/desktop/src/main/media-import-service.ts`, mirroring
      `PdfImportService`/`EpubImportService` (construction-time injection: `{ db, repositories,
      assetsDir, assetVault, fetchImpl }` — the `AssetVaultService` for the local-file vault stream; the
      injected `fetchImpl: typeof fetch` (`UrlImportService`'s, defaulting to the Node global `fetch`)
      for YouTube). Two public entry points:
  - [ ] **`importFromFile(input: { filePath: string; subtitlesPath?: string | null; title?: string |
        null; priority?: PriorityLabel; reasonAdded?: string | null }): Promise<MediaImportResult>`.**
        Steps (mirror the PDF importer): (1) **validate** the file — confirm a media extension/MIME +
        a **size cap** (e.g. 2 GB via `fs.stat`; reject larger with a typed `MediaImportError { code:
        "too_large" }`); decide `video` vs `audio` from the extension; (2) **mint the source id** up
        front; (3) **stream the original bytes into the vault** via `assetVault.importAsset({
        owningElementId: sourceId, kind: "video" | "audio", source: filePath, mime, destRelativePath:
        "sources/<source_id>/original.<ext>", durationMs })` (the absolute `filePath` makes
        `importAsset` `createReadStream` it — no whole-file read); (4) **parse the transcript** if
        `subtitlesPath` was supplied (`parseTranscript(read(subtitlesPath), "auto")`) else
        `cues: []` → `transcriptToProseMirrorDoc`; (5) **create the source** via `createWithDocument`
        (status `inbox`, stage `raw_source`, the pre-minted id, the title (explicit → file metadata →
        filename stem), the pre-built `conversion`, `snapshotKey: "sources/<id>/original.<ext>"`,
        priority `C`). Return `{ id, item: InboxItemSummary }`. **Ordering + rollback** exactly as
        `PdfImportService` (create the source row, import the asset keyed by the now-existing id;
        best-effort `rmSync` the partial `sources/<id>/` dir on any failure).
  - [ ] **`importFromYouTube(input: { url: string; priority?: PriorityLabel; reasonAdded?: string |
        null }): Promise<MediaImportResult>`.** Steps: (1) `fetchYouTubeMetadata(url, this.fetch)` →
        title/author/transcript; (2) **no vault stream** (the bytes are NOT downloaded — the canonical
        URL is the reference); (3) `transcriptToProseMirrorDoc({ title, cues: meta.transcript ?? [] })`;
        (4) **create the source** via `createWithDocument` with `status: "inbox"`, `stage: "raw_source"`,
        the title, the transcript body, **`canonicalUrl`/`originalUrl` = the YouTube watch URL**,
        `author = meta.author`, `media_kind: "youtube"` (the provenance discriminator — see the
        provenance deliverable below), `snapshotKey: null` (no local bytes), priority `C`. Return
        `{ id, item }`. A YouTube
        import that yields no transcript still creates a playable embedded source (the reader uses the
        IFrame embed). The `MediaImportError` codes: `not_media` / `too_large` / `unreadable` /
        `youtube_unavailable`.
- [ ] **Distinguish local vs YouTube media on the source provenance — one explicit nullable column.**
      A media source must record (a) it IS a media source and (b) whether it is local-file or YouTube,
      so `documents.get` can return `sourceFormat: "video"` and the reader can reliably pick `<video>`
      vs the YouTube IFrame embed. **Add ONE nullable `media_kind: text("media_kind")` column to the
      `sources` table** ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts))
      in the T073 migration, storing the values `"video"` / `"audio"` (a local media file) and
      `"youtube"` (a referenced YouTube embed); `null` for every non-media source (a pure widening, no
      backfill). The `MediaImportService` sets it at create time (`importFromFile` → `"video"`/`"audio"`
      from the extension; `importFromYouTube` → `"youtube"`). **This column — not a derivation — is the
      authoritative media discriminator**: `documents.get` returns `sourceFormat: "video"` ⇐
      `media_kind != null`, plus a `mediaSource: "local" | "youtube"` (`media_kind === "youtube"` →
      `"youtube"`, else `"local"`) and `mediaKind: "video" | "audio"` (for a local source). **Why an
      explicit column, not a derivation** (decided up front): the `sourceFormat: "pdf"` derivation keys
      off the `.pdf` `snapshotKey`, but a **transcript-less YouTube source has neither a vault asset NOR
      a distinctive `snapshotKey`** — a pure derivation would rest entirely on `isYouTubeUrl(canonicalUrl)`,
      which is fragile precisely where the reader must choose `<video>` vs IFrame. One nullable column
      removes that ambiguity for all four cases (local video / local audio / YouTube-with-transcript /
      YouTube-without-transcript). (The duration lives on `assets.duration_ms` already; expose it on the
      result.)
- [ ] **Extend the shared file picker** — add `"media"` (and `"subtitles"`) to the
      `PickImportFileRequestSchema` `kind` enum
      ([`contract.ts`](../../apps/desktop/src/shared/contract.ts) ~line 946) + the main-side picker's
      extension filters (`.mp4`/`.webm`/`.mov`/`.mkv`/`.m4a`/`.mp3`/`.wav` for `media`;
      `.vtt`/`.srt` for `subtitles`). The renderer picks the media file (and optionally a sidecar
      subtitle file) through this EXISTING command — no new picker.
- [ ] **IPC contract + channels + handlers:**
  - `sources.importMedia(request: { path: string; subtitlesPath?: string | null; priority?:
    PriorityLabel; reasonAdded?: string | null }): Promise<SourcesImportMediaResult>` (channel
    `sourcesImportMedia`) — the renderer has the chosen path(s) from the picker; MAIN reads the bytes
    main-side. `SourcesImportMediaResult = { status: "imported"; id: string; item: InboxItemSummary }`.
  - **YouTube rides the EXISTING `sources.importUrl` path** with a routing fork: in
    `UrlImportService`/the import host, if `isYouTubeUrl(url)` route to `MediaImportService.importFromYouTube`
    instead of Readability. (Keep ONE "Paste URL" entry point; the service decides article-vs-video.)
    Document this fork in `UrlImportService`.
  - `sources.getMediaData(request: { elementId }): Promise<{ bytes: ArrayBuffer | null; mime: string |
    null; mediaSource: "local" | "youtube"; youtubeId: string | null; durationMs: number | null }>`
    (channel `sourcesGetMediaData`) — for a **local** source MAIN reads the vault bytes (capped to the
    import size; or, preferred for large video, register a privileged `media://` protocol via
    `protocol.handle` that streams the vault file by element id so the `<video>` element seeks without
    buffering the whole file over IPC — see Notes); for a **YouTube** source it returns
    `mediaSource: "youtube"` + the video id (the renderer uses the IFrame embed, no bytes). Async,
    Zod-validated handlers mirroring `sources.getPdfData`.
- [ ] **DB-service accessors + methods** in
      [`db-service.ts`](../../apps/desktop/src/main/db-service.ts): a lazily-built `get
      mediaImportService(): MediaImportService` (constructed once with the open DB + repos + `assetsDir`
      + `assetVaultService` + `UrlImportService`'s `fetchImpl`, like `pdfImportService`),
      `importMedia(input)`,
      `getMediaData(input)`, and the `sourceFormat: "video"` mapping in the `documents.get` builder
      (read off `sources.media_kind != null`; currently the builder only emits `"pdf"`), plus the
      `mediaSource`/`mediaKind`/`durationMs` fields on the result. Throws a clear error if `assetsDir`
      was not provided.
- [ ] **Preload + renderer client** — add `sources.importMedia` / `sources.getMediaData` to
      [`preload/index.ts`](../../apps/desktop/src/preload/index.ts) and mirror
      `appApi.importMediaSource(...)` / `appApi.getMediaData(...)` in
      [`appApi.ts`](../../apps/web/src/lib/appApi.ts). Widen the `DocumentsGetResult.sourceFormat`
      mirror to `"pdf" | "video" | null`.
- [ ] **Renderer `MediaReader`** in `apps/web/src/pages/source/MediaReader.tsx` — a body component the
      `SourceReader` swaps in when `doc.sourceFormat === "video"` (~the `PdfReader` swap site, line
      ~550). It:
  - For a **local** source: an HTML5 `<video controls>` (or `<audio>` for an audio source) whose `src`
    is the `media://<elementId>` privileged-protocol URL (or a blob URL from the fetched bytes for the
    capped path). For a **YouTube** source: the YouTube **IFrame embed** (`https://www.youtube.com/embed/<id>`)
    — no bytes, on-device-rendered iframe, with `enablejsapi` so the reader can read/seek the current
    time (or, simpler, the native embed controls + a manual "Set read-point at current time" that the
    user enters; prefer the IFrame Player API `getCurrentTime()` when wired, degrade to manual).
  - A **transcript pane** beside/below the player (when the body has cue paragraphs): clicking a cue
    seeks the player to that cue's `timestampMs`; the currently-playing cue is highlighted (derived
    from `currentTime` → the nearest `document_blocks.timestamp_ms`). When there is no transcript, show
    the placeholder paragraph + the manual read-point/clip affordances only.
  - A **timestamp read-point**: a "Set read-point" press persists the current cue's stable block id via
    `readPoints.set` (so a transcript-backed video reuses `read_points` exactly); for a transcript-less
    video it persists the **title-heading block id with `offset = floor(currentTimeMs)`** (the
    offset-as-seconds convention — see the read-point substrate note above), so the single `read_points`
    table serves both cases with NO new `sources` column. Reopening seeks the `<video>` to the saved cue
    time (or the saved second). Reuse the existing read-point bar.
  - Renders gracefully when `!isDesktop()` (mirror the existing desktop-only fallback). Pure UI: typed
    commands only; no fs/fetch/parse/SQL in the renderer.
- [ ] **Renderer "Import media" affordance** — add a LIVE entry to the `IMPORT_OPTS` array (declared
      ~line 64 in [`InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx)) `{ icon:
      "play"|"media", label: "Import media", hint: "Video / audio, watched incrementally", action:
      "media" }` (use an **existing** `IconName`
      — `"play"` if present in [`Icon.tsx`](../../apps/web/src/components/Icon.tsx) + the icon map, else
      add one explicitly: a lucide import + a `design/icon-map.md` entry; do NOT name a key that fails
      `IconName` typecheck). The chip drives `sources.pickImportFile({ kind: "media" })` → (optionally a
      second `kind: "subtitles"` pick) → `appApi.importMediaSource(...)`, shows a busy spinner while
      main reads + parses, surfaces a friendly error on a `MediaImportError` (mapping its `code`), and
      on success refreshes the inbox + selects the new source. The YouTube case needs **no new chip** —
      it rides the existing "Paste URL" chip (the service auto-routes).
- [ ] **Tests (unit, importers — fixtures)** in `packages/importers/src/transcript*.test.ts` +
      `youtube.test.ts` against committed `.vtt`/`.srt` fixtures + a recorded oEmbed/timedtext JSON
      fixture (an **injected fake fetch** — no live network in tests):
  - `parseTranscript` handles each cue-timing edge case (overlap, no-end, `\r\n`, empty cue dropped,
    styling stripped, SRT-comma vs VTT-dot ms, BOM) and sorts by `startMs`.
  - `transcriptToProseMirrorDoc`: cues map to one heading + one paragraph per cue, each block tagged
    with its `timestampMs`; **every node ∈ `ALLOWED_NODE_NAMES`, `Node.fromJSON(buildSchema(), doc)`
    does not throw**; each row-bearing node has a unique `blockId`; an empty cue list maps to the
    title + ONE placeholder paragraph (no crash).
  - `fetchYouTubeMetadata` (fake fetch): a normal video → title/author + transcript cues; captions
    disabled → `transcript: null` (graceful); oEmbed 404 → throws `YouTubeImportError`; `isYouTubeUrl`
    accepts `youtube.com/watch?v=`/`youtu.be/` and rejects a non-YouTube URL.
- [ ] **Tests (domain, local-db)** — `createWithDocumentWithin` with a timestamp-tagged `conversion`
      stores `document_blocks.timestamp_ms`; the HTML/text path stores `null` (unchanged).
  - [ ] **Read-point dual-meaning round-trip (the offset-as-seconds convention).** Assert BOTH
        read-point paths persist + resolve correctly so `read_points.offset`'s two meanings can't
        silently regress: (a) a **transcript-backed** media source sets a read-point on a cue's stable
        block id and resumes at that block's `document_blocks.timestamp_ms` (the normal char-offset path
        is irrelevant — the resume keys off the cue's time); (b) a **transcript-less** media source sets
        the read-point on the **title-heading block id with `offset = floor(currentTimeMs)`** and, on
        re-read, round-trips that integer back as the resume second (the title heading's
        `document_blocks.timestamp_ms` is `null`, so the resume logic must special-case "offset is
        seconds, not a char offset" purely by the media `sourceFormat`/`media_kind`). One stored value,
        two interpretations — both asserted.
- [ ] **Tests (integration, main-side service)** in
      `apps/desktop/src/main/media-import-service.test.ts` against a real temp-file SQLite DB + temp
      `assetsDir` (the `db-service.test.ts` pattern), pointing `importFromFile` at a **tiny fixture
      media file** (a few-KB silent `.mp3`/`.webm` committed under fixtures) + a `.vtt` sidecar, and
      `importFromYouTube` at the **fake fetch**:
  - a successful local import writes `sources/<id>/original.<ext>` under the vault, records a
    `video`/`audio` asset row whose `contentHash` matches the file + `durationMs` set, creates an
    `inbox` source whose `sources.media_kind` is `"video"`/`"audio"` and whose body parses to the
    transcript heading/paragraphs with per-block timestamps, and appends `create_source` +
    `update_document` ops; `documents.get` reports `sourceFormat: "video"` + `mediaSource: "local"`;
  - a YouTube import (fake fetch) creates an `inbox` source with the canonical YouTube URL,
    `sources.media_kind = "youtube"` (so `documents.get` reports `mediaSource: "youtube"`), the
    transcript body, and NO vault asset (no bytes downloaded);
  - **restart-persistence**: re-open the DB (new repositories on the same file) and assert the source +
    provenance + transcript body + timestamp-tagged blocks + (local) the media asset are still present
    and `original.<ext>` still exists on disk;
  - error paths: a non-media / oversize file throws the typed `MediaImportError` with the right `code`
    and writes NO source row and NO partial vault dir (clean rollback); a YouTube import whose oEmbed
    fails throws `youtube_unavailable`.
- [ ] **Tests (contract)** — extend `contract.test.ts`: `SourcesImportMediaRequestSchema`
      accepts/rejects; the `media`/`subtitles` picker kinds round-trip; the `imported` result and the
      `getMediaData` result round-trip.
- [ ] **Tests (E2E, Electron)** — `tests/electron/media-import.spec.ts`: drive the real Electron app,
      import a fixture media file (stub the picker to return the fixture path via an env override —
      mirror `INTERLEAVE_PDF_IMPORT_PATH`, e.g. `INTERLEAVE_MEDIA_IMPORT_PATH` + an optional
      `INTERLEAVE_SUBTITLES_PATH`), see the source in the inbox, open it in the `MediaReader` (the
      `<video>`/`<audio>` element mounts, the transcript pane shows cues), set a timestamp read-point,
      and — after an **app restart** against the same data dir — the source, its body, its
      `original.<ext>`, and the read-point all survive. (YouTube import is covered by the
      fake-fetch integration test; the E2E avoids live network.)
- [ ] **Fixtures/seed** — the fixture media + `.vtt`/`.srt` + the recorded YouTube JSON are the new
      test data. Optionally add ONE small seeded media source so the reader shows a real video
      out-of-the-box (nice-to-have).
- [ ] **Docs** — check the T073 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line noting: the `subsrt-ts` dep, the `document_blocks.timestamp_ms` migration, the
      `@interleave/importers` transcript + YouTube transforms, the `MediaImportService` +
      `sources.importMedia` command + the YouTube fork on `sources.importUrl`, and the renderer
      `MediaReader`.

### Done when

- Importing a **local media file** (via the inbox "Import media" chip → the picker) OR pasting a
  **YouTube URL** (via the existing "Paste URL" chip) brings it in as an **inbox `source`** fully
  on-device: a local file streams `original.<ext>` into the vault (content-hashed `video`/`audio`
  asset, `durationMs`, bytes never in SQLite); a YouTube URL fetches oEmbed metadata + captions
  on-device (no bytes downloaded) and references the canonical URL; both build a constrained
  ProseMirror transcript doc with **stable block ids + per-block timestamps** (or a graceful
  placeholder when no transcript) and create the source via `createWithDocument` in one transaction.
- The `/source/$id` reader plays the media (HTML5 `<video>`/`<audio>` for local; the YouTube IFrame
  embed for YouTube), shows the transcript pane (when present), and tracks a **timestamp read-point**
  (reopening resumes near the saved second).
- The file read + media-metadata/transcript fetch + vault write run **main-side**; the renderer reaches
  it only through the typed `window.appApi` (no fs/fetch/parse/SQL in React, no generic `db.query`).
- A transcript-less media source imports without crashing (a placeholder body + manual read-points) —
  leaving a clean target for T074.
- An Electron E2E imports a fixture media file, plays it, sets a timestamp read-point, and — after an
  **app restart** — the source, body, `original.<ext>`, and read-point all survive.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass; the migration
  applies cleanly on an existing dev DB.

### Notes / risks

- **Streaming large video to the renderer.** A multi-hundred-MB video must NOT cross IPC as one
  ArrayBuffer. Prefer a privileged `media://<elementId>` **custom protocol** (`protocol.handle` in
  main) that streams the vault file with **HTTP Range support** so the `<video>` element seeks without
  buffering the whole file. The capped single-ArrayBuffer path (like `getPdfData`) is acceptable only
  for small audio; document the chosen path. Either way the renderer passes ONLY an element id — main
  owns the vault path.
- **YouTube fragility + ToS.** oEmbed + timedtext are keyless and on-device but can change; treat both
  as **best-effort** (a failure degrades to a transcript-less embedded source, never a crash). Do NOT
  download the video (out of scope + ToS); the YouTube source is a referenced embed. Note for the
  reviewer: the IFrame embed loads `youtube.com` in a sandboxed iframe — this is the ONE on-device
  network surface in the reader; the embed honors the user's own YouTube/network policy.
- **A video source is attention-scheduled, not FSRS.** It is a `source` element processed
  incrementally — the existing topic/extract scheduler applies. Do not route a media source through
  review scheduling.
- **On-device ASR is a clean downstream extension (NOT this task).** A `transcribe` job on the T058
  runner (Whisper WASM, mirroring the `ocr` job: main extracts the audio track / passes the media path,
  the worker runs ASR, main persists a transcript layer) would give transcript-less media a transcript
  later — keep the transcript doc + `document_blocks.timestamp_ms` shape so ASR slots in without a
  reshape. Out of scope for T073 (captions only).
- **Downstream:** T074 (clip extraction) needs the playable source + the cue timestamps this task
  ships; T075 (audio card) needs a clip to loop. Both build on T073 without changing its source/vault/
  transcript shapes.

---

## T074 — Video/audio clip extraction

- **Status:** `[ ]` not started  · **Depends on:** T073 (the playable media source + the cue-timestamp
  substrate + the timestamp read-point).
- **Roadmap line:** Done when selecting start/end timestamps creates a scheduled `media_fragment`
  storing transcript segment + clip metadata + source timestamp.

### Goal

In the media reader the user **selects a start/end timestamp** (drag a range on the player scrubber, or
select transcript cues whose `timestamp_ms` bound the range); the app creates a scheduled
**`media_fragment`** extract whose `source_locations` row carries the **start `timestamp_ms` + a clip
window `{ startMs, endMs }`** and whose body holds the **transcript segment** (the cue text spanning the
range, when a transcript exists). It is its own **attention-scheduled** topic, with lineage preserved
back to the source + clip. The clip stores **timestamps + a reference to the original media** — **NO
re-encoding, NO sub-file** (the player seeks the original between `startMs`/`endMs`). The clip create +
location write run **main-side**; the renderer ships only the `{ startMs, endMs }` + the source id +
the (optional) transcript-segment text.

### Context to load first

- Reference: [`../domain-model.md`](../domain-model.md) (`media_fragment` = "a timestamped/region clip
  (… video/audio clip, image)", line ~16; `source_locations … timestamp_ms`, line ~123),
  [`../scheduling-and-priority.md`](../scheduling-and-priority.md) (a `media_fragment` is an
  **attention** item — NOT FSRS), [`../../CLAUDE.md`](../../CLAUDE.md) (extraction stores parent/source/
  blockIds/offsets/timestamp/selected-text; lineage sacred; `media_fragment` is a core element type).
- Existing code to inspect: **`PdfRegionService`**
  ([`pdf-region-service.ts`](../../apps/desktop/src/main/pdf-region-service.ts)) — the EXACT
  orchestration pattern (mint id → create `media_fragment` in one tx → optional asset → soft-delete
  rollback); **`ExtractionService.createRegionExtract`**
  ([`extraction-service.ts`](../../packages/local-db/src/extraction-service.ts) ~line 261) +
  `CreateRegionExtractInput` (the `media_fragment` + `source_locations` page+region precedent T074
  mirrors for timestamp+clip); `source_locations.timestampMs`
  ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts) ~line 71) +
  `ElementLocation` ([`../../packages/core/src/element.ts`](../../packages/core/src/element.ts) ~line
  80) + `rowToSourceLocation` ([`../../packages/local-db/src/mappers.ts`](../../packages/local-db/src/mappers.ts));
  the `source-location-label` derivation ([`source-location-label.ts`](../../packages/local-db/src/source-location-label.ts));
  the T073 `MediaReader` + `document_blocks.timestamp_ms`; the inspector + `LineageTree`.
- Invariants in play: the clip create + location write run **main-side**; the extract is an independent
  scheduled element (a `media_fragment`, NOT a highlight, NOT an inline node) with full lineage
  (parent = source, `derived_from` the source, `source_locations` anchoring the timestamp + clip); NO
  bytes are cut/encoded/stored (the clip references the original media); one transaction +
  `create_extract` op; lineage preserved; the fragment is **attention-scheduled** (inherits the source
  priority), never FSRS.

### The clip model (specify concretely)

- A clip is a **`{ startMs: number; endMs: number }` window onto the ORIGINAL media** (validated
  `0 ≤ startMs < endMs ≤ durationMs`). It is NOT a cut file — the player (reader + the T075 card) seeks
  the original between the two times. This keeps the milestone `ffmpeg`-free (see "Scope honesty").
- The `source_locations` row stores `timestamp_ms = startMs` (the existing column — the clip's start
  is the location's timestamp) + a new **`clip`** column = the JSON `{ startMs, endMs }`. `selectedText`
  is the transcript segment under the range (the cue texts whose `timestampMs ∈ [startMs, endMs)`)
  when a transcript exists, else a generated label ("Clip 0:42–1:15"). `blockIds` is the first cue's
  stable block id (so the clip anchors to a transcript row and jump-to-source lands there); for a
  transcript-less source it is the placeholder block id.
- The extract element is type **`media_fragment`**, `stage: "raw_extract"`, attention-scheduled
  (inherits the source priority), parent = the source, body = the transcript segment as paragraphs
  (or a caption paragraph "Clip 0:42–1:15" when transcript-less). NO image/audio asset is created (the
  clip is a time window on the existing media asset — T075 loops the SAME original file).

### Deliverables

- [ ] **`source_locations.clip` column + migration.** Add a nullable `clip: text("clip")` (JSON
      `{ startMs, endMs }`) to the `sourceLocations` table
      ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts), beside
      `timestampMs`/`region`); add `clip: ClipWindow | null` to `ElementLocation`
      ([`element.ts`](../../packages/core/src/element.ts), beside `region: RegionRect | null`) with a
      `ClipWindow = { startMs: number; endMs: number }` type; update `rowToSourceLocation`
      ([`mappers.ts`](../../packages/local-db/src/mappers.ts), beside the `region` parse) to parse it,
      and `createExtractWithin` to insert it. Run `pnpm db:generate` → the migration (nominally
      `0015_*`; take the generated number); commit the SQL **under `packages/db/drizzle/`** (the Drizzle
      `out` dir, beside `0013_*.sql`). Pure widening, no backfill.
- [ ] **Extend `CreateRegionExtractInput`/the extract seam with a clip path.** Add a
      **`createClipExtract(input)`** method to `ExtractionService` (mirroring `createRegionExtract`)
      that, given `{ elementId?, sourceElementId, startMs, endMs, anchorBlockId, transcriptSegment?,
      priority, caption? }`, creates a **`media_fragment`** element + a `source_locations` row carrying
      `timestampMs = startMs`, `clip = { startMs, endMs }`, `blockIds = [anchorBlockId]`, `selectedText
      = transcriptSegment ?? "Clip <startMs>–<endMs>"`, and a label "Clip M:SS–M:SS" — all in ONE
      transaction (`create_element` + `create_extract` ops), attention-scheduled. (Reuse the
      `createRegionExtract` internals; the only deltas are the location fields + the label.) Add a unit
      test that a clip extract creates a `media_fragment` + a `source_locations` row with the timestamp
      + clip window.
- [ ] **Update the source-location label derivation** so a media source's clip label reads
      "Clip M:SS–M:SS" (mm:ss formatted from `startMs`/`endMs`); keep the existing "¶N"/"Page N · ¶M"
      for text/PDF. Add a unit test (clip set → "Clip 0:42–1:15"; clip null → the existing label).
- [ ] **Main-side `MediaClipService`** in `apps/desktop/src/main/media-clip-service.ts`, mirroring
      `PdfRegionService` but **simpler** (no asset import — the clip references the original media). DI:
      `{ db, repositories, extraction }`. Public: `extractClip(input: { sourceElementId; startMs; endMs;
      anchorBlockId; transcriptSegment?: string | null; caption?: string | null; priority?:
      PriorityLabel }): Promise<ExtractClipResult>`. Steps: (1) resolve the source (throw if
      missing/deleted), inherit its numeric priority (or the override); (2) validate `0 ≤ startMs <
      endMs ≤ source.durationMs` (read `durationMs` off the media asset); (3) `extraction.createClipExtract({…})`
      in ONE transaction; (4) return `{ id, element: <summary>, location: <clip summary> }`. There is
      NO vault step, so NO rollback-of-an-asset (the single transaction is atomic). Document why this is
      asset-free (the clip is a time window, not a file).
- [ ] **IPC contract + channel + handler.** `sources.extractClip(request: { sourceElementId:
      ElementId; startMs: number; endMs: number; anchorBlockId: string; transcriptSegment?: string |
      null; caption?: string | null; priority?: PriorityLabel }): Promise<SourcesExtractClipResult>` —
      validate `startMs >= 0`, `endMs > startMs`, both `int`, `transcriptSegment` length-capped (e.g.
      ≤ 8000 chars), `caption` ≤ 512. Channel `sourcesExtractClip: "sources:extractClip"`; an async
      handler mirroring `sourcesExtractRegion`. `SourcesExtractClipResult = { id; element:
      ClipExtractSummary; location: ClipLocationSummary }` (mirror the region result shapes).
- [ ] **DB-service accessor + method** — a lazily-built `get mediaClipService()` + `extractClip(request)`
      mapping the A/B/C/D label → numeric priority and delegating.
- [ ] **Preload + renderer client** — `sources.extractClip` → `appApi.extractClip(request)`.
- [ ] **Renderer clip-select UI in `MediaReader`** — a "Clip" mode: the user sets an **in/out point**
      on the player (an `[`/`]` keyboard pair or drag-handles on a range strip over the scrubber), the
      reader shows a small confirm popover ("Clip this segment as a topic" with the auto-filled
      transcript segment as an editable caption + a priority), then calls `extractClip` with the
      `{ startMs, endMs }`, the **anchor block id** (the first cue in range, or the placeholder), and
      the transcript segment (derived from the cues in range). On success it toasts, marks the clip on
      the scrubber (a light range overlay), and refreshes the inspector so the new `media_fragment`
      shows under the source's children. Transcript-cue selection is the alternate entry: selecting a
      run of cue paragraphs pre-fills the in/out from the first/last cue's `timestampMs`. Pure UI; no
      fs/SQL.
- [ ] **Inspector / lineage display.** A `media_fragment` clip must render in the universal inspector +
      `LineageTree` like any extract (it already will via the element graph), and its detail view should
      show a **mini player** that loops the clip (the same `media://<sourceId>` source seeked to
      `startMs`, stopping at `endMs`) + the "Clip M:SS–M:SS" source location with a jump-to-source
      affordance (open the media reader scrolled/seeked to the clip start). Reuse the jump-to-source
      mechanism (a `?t=<startMs>` param on the reader route). A clip's "open source" seeks the player.
- [ ] **Tests (unit)** — the `clip` mapper round-trips a window; `createClipExtract` creates the right
      `media_fragment` + location (timestamp + clip); rejecting an inverted/out-of-range window; the
      clip label format.
- [ ] **Tests (integration, main-side)** — `apps/desktop/src/main/media-clip-service.test.ts`: given an
      imported media source (from the T073 fixture) + a clip request, the service creates a
      `media_fragment` extract with a `source_locations` row carrying the start timestamp + clip window
      + the transcript segment, appends `create_extract`, the fragment is **attention-scheduled** (has
      an `elements.due_at`, NO `review_states` row), and the whole thing survives a DB re-open
      (restart-persistence). A clip whose `endMs > durationMs` is rejected.
- [ ] **Tests (E2E, Electron)** — extend `media-import.spec.ts` (or a new `media-clip.spec.ts`): in the
      media reader, set an in/out point on a fixture video, confirm the clip, see a `media_fragment`
      appear under the source with the transcript segment + the "Clip M:SS–M:SS" location + a looping
      mini player in the inspector; after an **app restart**, the clip fragment + location survive.
- [ ] **Docs** — check the T074 box with the commit ref + a Progress-log line noting the
      `source_locations.clip` migration, the `media_fragment` clip-extract path (no re-encoding), and
      the reader clip-select UI.

### Done when

- Selecting a start/end timestamp (a scrubber range or a transcript-cue selection) in the media reader
  creates a scheduled **`media_fragment`** whose `source_locations` row carries the **start
  `timestamp_ms` + the clip window `{ startMs, endMs }`** and whose body holds the **transcript segment**
  — its own **attention-scheduled** topic with lineage back to the source + clip.
- The clip stores **timestamps + a reference to the original media** — **NO re-encoding, NO sub-file**;
  the player (reader + the inspector mini player) seeks the original between `startMs`/`endMs`.
- The clip create + location write run **main-side** in ONE transaction (`create_extract`); the renderer
  reaches it only through the typed `window.appApi`.
- The `media_fragment` shows in the inspector + lineage, its detail view loops the clip, and "open
  source" seeks the reader to the clip start.
- The `source_locations.clip` migration is included and applies cleanly; everything survives an **app
  restart**.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **No re-encoding (load-bearing).** A clip is a `{ startMs, endMs }` window; do NOT cut/export a
  sub-file (that needs `ffmpeg`, explicitly out of scope). The original media asset is the single source
  of bytes; every clip + audio card references it by time. This keeps the app `ffmpeg`-free.
- **Timestamp fidelity.** Store `startMs`/`endMs` as integer milliseconds; format mm:ss only for
  display. Validate against the media `durationMs` (off the asset) so a clip cannot exceed the media.
- **The clip is an attention item, not a card.** A `media_fragment` is NEVER given a `review_states`/
  FSRS row (the two-scheduler split). T075 turns a clip INTO a card (a separate `card` element); the
  clip fragment itself stays attention-scheduled.
- **Downstream:** T075 (audio card) loops the SAME clip window on the SAME original media — keep the
  `{ startMs, endMs }` + the source/media reference clean (no baked-in audio) so the card can reference
  it by time.

---

## T075 — Audio review cards

- **Status:** `[ ]` not started  · **Depends on:** T074 (a clip `media_fragment` to loop), T036 (the
  FSRS card scheduler + the review session — an audio card is reviewed as active recall).
- **Roadmap line:** Done when audio prompt/answer/looped-fragment cards can be reviewed as active recall.

### Goal

From a clip `media_fragment` (T074), the user builds an **audio card**: a `card` element whose **prompt
and/or answer is a looped audio clip** of the original media (between `startMs`/`endMs`), reviewed as
**active recall through FSRS** (the existing review session + reveal → grade → advance + sibling
burying). Examples: a language-learning card whose prompt loops a spoken phrase and whose answer is the
written translation; a music-theory card whose prompt is a written question and whose answer loops the
audio example. The audio card is the **existing `card` model extended with an audio presentation +
a clip reference**, NOT a parallel card system — it flows through `cards.create`, `review.session.next`,
`review.grade`, `CardFront`, sibling burying, leech detection, and card-quality checks UNCHANGED except
for the audio render + three carrier fields. The audio plays by **seeking the original media** (no
re-encoding), so the milestone stays `ffmpeg`-free.

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) (cards = FSRS),
  [`../../CLAUDE.md`](../../CLAUDE.md) "Review rules" (reveal/grade/edit/open-source/suspend; sibling
  burying), "Card-quality rules", [`../design-system.md`](../design-system.md) (`rcard`, `grades`,
  `SchedulerChip` FSRS side, `cardprev`).
- Existing code to inspect: the `cards` table
  ([`cards.ts`](../../packages/db/src/schema/cards.ts) — `kind`, `prompt`, `answer`, `cloze`,
  `sourceLocationId`) + `CARD_KINDS` ([`enums.ts`](../../packages/core/src/enums.ts) ~line 118);
  `CardService.createFromExtract` ([`card-service.ts`](../../packages/local-db/src/card-service.ts)
  ~line 146; its input type is `CreateCardFromExtractInput` ~line 70)
  + `ReviewRepository.createCard`/`createCardWithin`
  ([`review-repository.ts`](../../packages/local-db/src/review-repository.ts)); the `cards.create` IPC
  (channel `cardsCreate`, `CardsCreateRequestSchema` in `contract.ts`); the FSRS substrate
  (`CardSchedulerService`, `ReviewSessionService`, `review.session.next`/`review.preview`/`review.grade`);
  the `ReviewCardView` contract type (~line 2251) + `ReviewScreen` + `CardFront`
  ([`../../apps/web/src/review/`](../../apps/web/src/review/)); the T073 `media://` protocol /
  `getMediaData`; the T074 clip `{ startMs, endMs }` + the `media_fragment` source location;
  `card-quality` ([`card-quality.ts`](../../packages/core/src/card-quality.ts)).
- Invariants in play: an audio card is a `card` element with a `review_states` row scheduled by FSRS
  ONLY (the two-scheduler split); lineage is sacred (`card → media_fragment clip → source location →
  media source`); the renderer does NO FSRS math (the review session + grade path are unchanged); the
  audio plays by seeking the original media (no re-encoding); a media card is created at `card_draft`
  un-due, like every card (M6), and activates into FSRS like every card (M7).

### The audio-card model (specify concretely — extend, do NOT fork)

An audio card is the existing card with a **media presentation** added. Two carriers:

- **`cards.media_ref`** (new nullable column, T075 migration): JSON `{ sourceElementId: string;
  startMs: number; endMs: number; on: "prompt" | "answer" | "both" }` — which clip to loop and on which
  face. `sourceElementId` is the **media `source`** (the original asset to seek), `startMs`/`endMs` the
  clip window (copied from the originating `media_fragment`'s `source_locations.clip` at create time so
  the card is self-contained), and `on` says whether the loop is the prompt, the answer, or both. `null`
  for a non-audio card (every existing card). The card's TEXT (`prompt`/`answer`/`cloze`) is unchanged —
  an audio card can ALSO carry a written prompt/answer (e.g. audio prompt + written answer); the
  `media_ref.on` decides which face also plays audio.
- **`CARD_KINDS` stays `["qa","cloze"]`; the audio-ness is `media_ref != null`, NOT a new `kind`.** An
  audio Q&A card is `kind: "qa"` with `media_ref`; an audio cloze is `kind: "cloze"` with `media_ref`.
  This keeps every `kind`-switched code path (cloze parsing, card-quality, sibling burying) working
  unchanged. (Document this decision: "audio is a presentation modifier on a card, not a card kind" — it
  is why no `CARD_KINDS` migration is needed and why the review/sibling/leech logic needs no special
  case.) Lineage: the card's `parentId` = the clip `media_fragment`, `sourceId` = the media source, and
  `sourceLocationId` = the clip's `source_locations` id — so jump-to-source seeks the media reader to the
  clip.

### Deliverables

- [ ] **`cards.media_ref` column + migration.** Add a nullable `mediaRef: text("media_ref")` (the JSON
      above) to the `cards` table ([`cards.ts`](../../packages/db/src/schema/cards.ts)). Run `pnpm
      db:generate` → the migration (nominally `0016_*`; take the generated number); commit the SQL
      **under `packages/db/drizzle/`** (the Drizzle `out` dir, beside `0013_*.sql`).
      Update `CardWithElement`/the card mapper to surface a parsed `mediaRef: MediaRef | null`. Add a
      `MediaRef`/`MediaRefSchema` type+Zod in `@interleave/core` (`media-ref.ts`) with validation
      (`startMs >= 0`, `endMs > startMs`, `on ∈ {prompt,answer,both}`). Pure widening, `null` for all
      existing cards.
- [ ] **`CardService` accepts a media ref.** Extend `CreateCardFromExtractInput` (and the
      `ReviewRepository.createCard`/`createCardWithin` input) with an optional `mediaRef?: MediaRef |
      null`, written to `cards.media_ref` in the same card-creation transaction (no new op —
      `create_card` already covers it). When the originating element is a clip `media_fragment`,
      `CardService` **derives `media_ref` from the clip's `source_locations.clip` + the media
      `sourceId`** (so the builder can pass just "make this clip the prompt/answer" and the service fills
      the window) — OR the renderer passes an explicit `media_ref`. Document the derivation. The card's
      `sourceLocationId` inherits the clip's location (jump-to-source seeks the clip).
- [ ] **`cards.create` IPC carries the media ref.** Extend `CardsCreateRequestSchema` (`contract.ts`)
      with an optional `mediaRef: MediaRefSchema.nullable().optional()` and surface `mediaRef` on the
      `CardSummary`/the create result. Validate it (the Zod refine on the window). No new channel — the
      existing `cardsCreate` carries it.
- [ ] **`ReviewCardView` carries the audio fields.** Add to the `ReviewCardView` contract type
      (~line 2251) three fields: `mediaRef: MediaRef | null`, and (so the renderer can play without a
      second round-trip) the resolved `mediaSource: "local" | "youtube"` + `youtubeId: string | null`
      (derived from the media source, like `getMediaData`). The review read path
      (`review.session.next`/`review.card`) populates them from the card's `media_ref` + its media
      source. `null`/text-only for every existing card.
- [ ] **`CardFront` audio renderer.** Extend `CardFront`
      ([`../../apps/web/src/review/CardFront.tsx`](../../apps/web/src/review/CardFront.tsx)) so a card
      with `media_ref` on the current face renders a **looping audio player**: an `<audio>` (for a local
      source, `src = media://<mediaRef.sourceElementId>`, seeked to `startMs`, looping the
      `[startMs, endMs)` window by seeking back to `startMs` at `endMs`) — or,
      for a YouTube source, a hidden/visual IFrame Player seeking the window. The front shows the loop on
      `media_ref.on ∈ {prompt, both}`; the reveal shows it on `{answer, both}`. The audio NEVER leaks
      the answer before reveal (an audio-answer card's front plays nothing / only its written prompt).
      Keep the text rendering (`prompt`/cloze mask) intact — an audio card can be audio-only OR audio +
      text. A play/replay button + a "loop" affordance; respects the review keyboard (Space reveals,
      1–4 grade) — the audio play does not steal the grade keys.
      > **Loop boundary granularity — do NOT gate the loop on `timeupdate` alone.** `HTMLMediaElement`'s
      > `timeupdate` event fires only ~4×/sec (every ~200–250 ms), so seeking back to `startMs` only
      > when a `timeupdate` reports `currentTime >= endMs` can overrun `endMs` by up to a quarter
      > second before looping — audible on tight language/music clips. Use a **tighter loop mechanism**:
      > a `requestAnimationFrame`-driven time check, or a scheduled `setTimeout(endMs - startMs)`
      > (re-armed each loop) for a precise boundary, with `timeupdate` only as a coarse safety net. The
      > YouTube IFrame Player path has the same coarseness — apply the same rAF/scheduled re-seek there.
- [ ] **The review session is otherwise UNCHANGED.** `review.session.next`/`review.preview`/
      `review.grade`, sibling burying (`ReviewSessionService`), leech detection, and the FSRS math all
      operate on the audio card with NO special case (it is a `card` with a `review_states` row). Verify
      (a test) an audio card is selected, revealed, graded, rescheduled, and sibling-buried exactly like
      a text card. The renderer does NO FSRS math.
- [ ] **Card builder: "Make audio card" from a clip.** In the clip `media_fragment`'s detail/extract
      view (T074), add a **"Create audio card"** action that opens the card builder pre-seeded with the
      clip as the audio prompt (default `on: "prompt"`), with a toggle for prompt/answer/both, plus the
      normal written prompt/answer fields (so the user adds the written side) + the A/B/C/D priority +
      the FSRS `SchedulerChip` + the `qc` checklist. On Create it calls `appApi.createCard({ extractId:
      clipFragmentId, kind: "qa", prompt, answer, mediaRef, priority })`. Reuse the existing
      `CardBuilder` surface (M6) — add the audio toggle + a mini clip player, do NOT build a parallel
      builder.
- [ ] **Card-quality: audio-aware.** Extend `evaluateCardQuality`
      ([`card-quality.ts`](../../packages/core/src/card-quality.ts)) so a card with `media_ref` is not
      mis-flagged: an audio-prompt card with an empty TEXT prompt is NOT "empty prompt" (the audio IS the
      prompt) — pass a `hasMediaPrompt`/`hasMediaAnswer` signal so the empty-prompt/empty-answer `block`
      checks consider the audio face. Add a check: a media card whose clip is very long (e.g. > 30 s) →
      a `warn` ("long audio clip — consider a shorter span") per the minimum-information principle. Keep
      it a pure function; unit-test the audio cases.
- [ ] **Tests (unit)** — `MediaRefSchema` accepts/rejects (window validation, `on` enum); `CardService`
      creates a card with a `media_ref` derived from a clip fragment (the window + media source copied);
      `evaluateCardQuality` does NOT flag an audio-prompt card with empty text prompt and DOES warn on a
      30s+ clip.
- [ ] **Tests (domain/integration, local-db + db-service)** — a `cards.create` with a `media_ref`
      round-trips through `DbService` (stored on `cards.media_ref`, surfaced on `ReviewCardView`); the
      card is created `card_draft` un-due (the two-scheduler split holds — a `media_fragment` clip is
      NOT given a `review_states` row, but the AUDIO CARD is); an audio card is selected/graded/
      rescheduled by the FSRS path exactly like a text card and the grade writes a `review_logs` row +
      `add_review_log` op. Sibling burying: two audio cards from one clip set share a `siblingGroupId`
      and don't appear back-to-back.
- [ ] **Tests (component)** — `CardFront.test.tsx`: an audio-prompt card renders a looping `<audio>` on
      the front (mock the element) and NO audio answer before reveal; a `qa` card with no `media_ref`
      renders unchanged; reveal shows the audio on an audio-answer card.
- [ ] **Tests (E2E, Electron)** — `tests/electron/audio-card.spec.ts`: import a fixture media source →
      clip a span (T074) → "Create audio card" with a written answer → the card appears in the lineage
      under the clip with the FSRS `SchedulerChip` → open `/review` (drive the fixed clock so the card
      reads due) → the card front mounts a looping `<audio>`/player, reveal shows the answer, grade Good
      → the card reschedules + a `review_logs` row is written → after an **app restart**, the audio card,
      its `media_ref`, its lineage, and its FSRS state survive.
- [ ] **Docs** — check the T075 box with the commit ref + a Progress-log line noting the
      `cards.media_ref` migration, the audio-card-as-card-presentation decision (no new `kind`, no
      parallel system), the `CardFront` audio loop renderer, and that the FSRS review session is reused
      unchanged.

### Done when

- From a clip `media_fragment`, "Create audio card" creates a `card` element whose prompt and/or answer
  is a **looped audio clip** of the original media (via `cards.media_ref`), with optional written
  prompt/answer, inherited lineage (`card → clip → location → media source`), a `card_draft` stage, and
  an un-due `review_states` row — through the existing `cards.create` command, NO new card kind, NO
  parallel system.
- The audio card is reviewed as **active recall through FSRS** (the existing `/review` session: reveal →
  grade Again/Hard/Good/Easy → reschedule → advance), with sibling burying + leech detection + card
  quality all working unchanged; the `CardFront` loops the clip on the right face (and never leaks the
  answer before reveal); the audio plays by **seeking the original media** (no re-encoding).
- The two-scheduler split holds: the audio card has a `review_states`/FSRS row; the originating clip
  `media_fragment` does NOT (it stays attention-scheduled).
- The `cards.media_ref` migration is included and applies cleanly; the audio card + its FSRS state +
  lineage survive an **app restart** (proven by the Electron E2E).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Extend, do NOT fork (load-bearing).** An audio card is a `card` with a `media_ref` presentation, not
  a new `kind` or a parallel table — this is what keeps the FSRS review session, sibling burying, leech
  detection, and card-quality logic working with NO special case. Resist adding an `audio` `CARD_KIND`
  or an `audio_cards` table; the `kind`-switched code (cloze parsing especially) would all need new
  branches for no benefit.
- **Looping the clip without re-encoding.** Loop `[startMs, endMs)` by seeking the original media element
  back to `startMs` when it reaches `endMs` — no sub-file, no `ffmpeg`. Drive the boundary with a
  **`requestAnimationFrame` time check or a scheduled `setTimeout(endMs - startMs)`** rather than the
  coarse `timeupdate` event alone (which fires only ~4×/sec and can overrun a short clip by up to
  ~250 ms — see the `CardFront` deliverable); use `timeupdate` only as a coarse safety net.
  For a YouTube source, the IFrame Player API's `seekTo`/`playerStateChange` does the same, with the
  same coarseness caveat — apply the same tight re-seek.
- **Never leak the answer.** An audio-answer card must play NOTHING audio (and show no answer text)
  before reveal — the front only plays a `media_ref.on ∈ {prompt, both}` clip. Mirror the strict
  reveal-gating the existing `sourceRef`/`answer` already enforce in `ReviewScreen`.
- **Card quality for audio.** The minimum-information principle still applies — warn on an over-long
  clip; do NOT mis-flag an audio-only card as "empty prompt/answer". Pass the media signals into
  `evaluateCardQuality` so the `block`/`warn` checks are audio-aware.
- **Downstream:** on-device ASR (a future `transcribe` job) would let an audio card auto-suggest a
  written transcript for its clip; and image-occlusion/formula cards (T071/T072, the other M15 lane)
  share this "a card variant is a presentation on the existing model" pattern — keep `media_ref` as the
  clean precedent (masks/regions/audio are all presentation carriers, not parallel systems).

---

## Exit criteria for the M15 media subset (T073–T075)

- T073, T074, T075 are `[x]` in [`../roadmap.md`](../roadmap.md) with commit refs + Progress-log
  entries (noting: `subsrt-ts` for VTT/SRT, on-device oEmbed+timedtext for YouTube — no `ytdl`, no
  download; the `document_blocks.timestamp_ms` / `source_locations.clip` / `cards.media_ref` migrations;
  that media bytes stream into the T059 vault and clips/cards reference the original by time — **no
  `ffmpeg`, no re-encoding, no S3, no server**).
- A user can import a local video/audio file or a YouTube URL, watch/listen incrementally with a
  transcript (when available) + timestamp read-points, clip a span into a scheduled `media_fragment`
  topic (timestamps + original reference, no re-encoding), and build an audio card that loops the clip
  and is reviewed as active recall through FSRS — with sibling burying, leech, and card quality all
  reused unchanged.
- All of it goes through the typed `window.appApi` — no fs/fetch/parse/SQL in the renderer; media
  parsing + vault writes + the YouTube fetch run main-side. Pure transforms (transcript parse, YouTube
  metadata, transcript→PM) live in `@interleave/importers` with fixture tests; orchestration is the
  injectable `MediaImportService`/`MediaClipService` + the reused `CardService`/FSRS substrate.
- The **two-scheduler split holds**: video sources + clip `media_fragment`s are attention-scheduled
  (never an FSRS row); audio cards are FSRS-scheduled (always a `review_states` row); the two are never
  crossed.
- Everything **survives an app restart** (proven by the Electron E2Es), and source lineage (media source
  → clip fragment → audio card) is preserved.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the Electron Playwright E2Es are green in CI.

The other M15 lane (T071 image occlusion, T072 formula & code cards) extends this same
card-variant-as-presentation pattern and is specified in the sibling file
[`M15-occlusion-formula.md`](./M15-occlusion-formula.md) — build it from there (occlusion = masks
stored separately from the base image extract on a `media_fragment`; formula/code = the constrained
editor schema widened for math + code-language, KaTeX/Shiki render in source/extract/review). The
two lanes are independent and can land in either order.
