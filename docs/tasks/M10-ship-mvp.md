# M10 — Keyboard, E2E & ship MVP as Electron desktop (T048–T050)

Detailed, buildable specs for the tenth and final Part-I milestone. M10 is **not three more
features** — it is the **convergence gate** that turns everything built in M1–M9 into a thing a
person can install and use every day. The three tasks line up as: make the whole loop
**mouse-free** (T048), prove the whole loop **survives an app restart** end to end (T049), then
**package and ship** it as an installable macOS desktop app (T050).

The dependency chain is the story: **T049 depends on T048 _and_ T047** (the backup), and **T050
depends on T049**. So the ship gate is **integration-level, not a feature check** — T049's single
Playwright spec walks the entire pipeline (`import → activate → read → set read-point → extract →
convert-to-card (Q&A + cloze) → review (grade) → reschedule → search → open original source →
backup → restart → verify persistence`), and T050 only succeeds if that loop, packaged into a
real `.app`/`.dmg`, behaves identically to the dev build.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and the
roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every mutation flows React UI → typed client wrapper
(`apps/web/src/lib/appApi.ts`) → preload bridge (`apps/desktop/src/preload/index.ts`) → validated
IPC (Zod) on the main side (`apps/desktop/src/main/ipc.ts`) → the `DbService`
(`apps/desktop/src/main/db-service.ts`) → `packages/local-db` repositories +
`packages/scheduler` services → SQLite + the filesystem asset vault. Every meaningful mutation
runs in **one transaction** and appends an **`operation_log`** row (the closed 15-op set in
`packages/core/src/operation-log.ts`); deletes are soft (`deleted_at`). **M10 adds no new mutation
paths and no new op types** — its whole point is that the existing surface is complete, keyboard-
driven, tested, and shippable.

> **The load-bearing M10 invariant (read before T048).** A keyboard shortcut and its UI button
> must call the **exact same** typed `window.appApi` command — there is **no separate mutation
> path for the keyboard**. The codebase already proves this pattern twice: `useProcessShortcuts`
> (`apps/web/src/pages/queue/useProcessShortcuts.ts`) and the review `1/2/3/4`/`Space` keys
> (`apps/web/src/review/ReviewScreen.tsx`) both delegate to the same handlers the on-screen
> buttons call, which route through `appApi.actOnQueueItem` / `appApi.reviewGrade` / etc. T048
> generalizes this, it does not duplicate logic into a new layer.

> **Convergence-dependency note (resolved — read before sequencing M10).** The roadmap's literal
> deps are `T048: T031,T037,T021`; `T049: T048,T047`; `T050: T049`. But T049's *flow text* names
> two steps whose features live in **M8**, which is unbuilt at the time this file is written:
> **search** (`T042`, with its FTS5 tables + a `search.*` `window.appApi` surface — neither
> exists yet, confirmed below) and **open original source** (the jump-to-source path is T022,
> already built; richer source/reference display is `T043`). **Build order, therefore:** M8
> (T041–T043) and M9 (T044–T047) **must be `[x]` before T049** — T049's spec assumes
> `appApi.searchQuery` (T042) and `appApi.createBackup`/`appApi.restoreBackup` (T047) exist. T048
> only needs M1–M7 surfaces (all present) plus whatever M8/M9 commands exist when it lands; it can
> be built as soon as T031/T037/T021 are done, but its command-palette catalogue + cheat sheet
> should be **extended** (not frozen) as M8/M9 commands land. This file specifies T048 against the
> **current** surface and flags the M8/M9 additions as "extend when present."

### What already exists (inspect before building — do not duplicate)

The shell + per-screen shortcuts + the full mutation surface are already in place; M10 is mostly
**wiring, an installer, and one big test**.

- **Shell keyboard chrome (T004) — present:**
  - `apps/web/src/shell/useShellShortcuts.ts` — the global handler: `⌘K`/`Ctrl+K` toggles the
    command palette, `?` toggles the cheat sheet, `g`+letter quick-navigates (700ms window),
    suppressed while typing in input/textarea/contenteditable. **This is the seam T048 extends.**
  - `apps/web/src/shell/CommandPalette.tsx` — the `⌘K` palette: filter, ↑/↓, Enter, Esc; runs a
    `CommandItem` by navigating to its route and optionally dispatching a `CustomEvent`
    (e.g. `NEW_SOURCE_EVENT` opens the inbox modal). **Catalogue is static config from `nav.ts`.**
  - `apps/web/src/shell/CheatSheet.tsx` + `apps/web/src/shell/nav.ts` — the `?` cheat sheet
    (`CHEAT_SHEET`), the `⌘K` catalogue (`COMMAND_ITEMS`), the `g`+letter map (`GOTO_MAP`), the
    sidebar nav (`PRIMARY_NAV`/`SECONDARY_NAV`). The cheat sheet **already lists most shortcuts as
    documentation** (Reading: `E`/`C`/`H`/`␣`/`M`; Review: `␣`/`1–4`/`E`/`O`/`S`; Triage:
    `1`/`2`/`3`/`4`/`6`) — T048 makes the **not-yet-wired** ones real and reconciles the doc with
    the implementation.
  - `apps/web/src/shell/Kbd.tsx` — the keycap renderer used across the shell + palette.
- **Per-screen shortcut hooks (T031/T037) — present and exemplary:**
  - `apps/web/src/pages/queue/useProcessShortcuts.ts` — the process-loop keys (`n`/`→`/`␣` next,
    `p` postpone, `d` done, `x` dismiss, `⌫`/`Delete` delete, `+`/`=` raise, `-` lower, `o`/`Enter`
    open). Its doc comment **explicitly defers the full catalogue + palette wiring to T048**.
  - `apps/web/src/review/ReviewScreen.tsx` — reveal on `Space`, grade `1/2/3/4`, all delegating to
    `appApi.reviewGrade`; the repair row (`ReviewRepairBar.tsx`) → `appApi.updateCard`/`suspendCard`/
    `deleteCard`/`flagCard` (T038).
- **The full typed `window.appApi` mutation surface (M1–M7) — present** (`apps/web/src/lib/appApi.ts`
  + `apps/desktop/src/shared/{channels.ts,contract.ts}` + `preload/index.ts` + `main/ipc.ts` +
  `main/db-service.ts`). The commands a keyboard-first loop needs already exist:
  `importManualSource`, `triageInboxItem`, `createExtraction`, `createCard`, `setElementPriority`,
  `actOnQueueItem`/`undoQueueAction`, `reviewSessionNext`/`reviewPreview`/`reviewGrade`,
  `updateCard`/`suspendCard`/`deleteCard`/`flagCard`/`markLeechCard`, `getLineage`,
  `setReadPoint`/`getReadPoint`, `getInspectorData`, etc. **No new commands are needed for T048.**
- **The Electron shell + production renderer load (T007) — present:**
  - `apps/desktop/src/main/index.ts` — lifecycle (single-instance lock, `second-instance`,
    `activate`, `window-all-closed`, `will-quit`), migrations on startup, the `DbService` wiring.
  - `apps/desktop/src/main/window.ts` — the secure `BrowserWindow` (`contextIsolation: true`,
    `nodeIntegration: false`, `sandbox`, `enableRemoteModule: false`).
  - `apps/desktop/src/main/renderer-protocol.ts` — the **custom `app://` protocol** that serves the
    built renderer files in production (this is what makes the app **fully offline** — no
    `localhost`/network at runtime). Dev loads the Vite dev server via `VITE_DEV_SERVER_URL`.
  - `apps/desktop/src/main/paths.ts` — the app data dir + `assets/` + `backups/` vault skeleton
    (`~/Library/Application Support/<app>/`, overridable via `INTERLEAVE_DATA_DIR`).
  - `apps/desktop/build.mjs` — esbuild bundles `main.cjs` + `preload.cjs` and stages the Drizzle
    migrations; `scripts/vendor-native.mjs` vendors the **Electron-ABI `better-sqlite3`** binary
    (`native/` + `@electron/rebuild`). **This native-module handling is the single biggest
    packaging risk for T050 — the installer must ship the Electron-ABI binary, not the Node one.**
  - `apps/desktop/src/main/native-binding.ts` — passes `nativeBinding` to `better-sqlite3`.
- **Playwright Electron harness (T007) — present:** `tests/electron/launch.ts`
  (`ensureBuilt()` builds the renderer + `main.cjs`/`preload.cjs`; `makeDataDir()` allocates an
  isolated `INTERLEAVE_DATA_DIR`; `launchApp(dataDir, { seedOnEmpty })` launches the **built**
  app in production mode and is reused for the **restart** relaunch against the same data dir).
  `playwright.config.ts` has the `electron` project (`testDir: ./tests/electron`, serial).
  ~24 specs already cover each feature individually (`inbox`, `extraction`, `cards`, `review`,
  `review-edit`, `queue`, `process-queue`, `leech`, `lineage`, `read-points`, …). **T049 is the
  one spec that strings them into a single user journey + the canonical restart proof.**

### What M10 must add (the gaps)

- **No central shortcut catalogue / registry** — shortcuts live in three disconnected places
  (`useShellShortcuts`, `useProcessShortcuts`, the review screen's inline `onKey`), and `nav.ts`'s
  `CHEAT_SHEET` is **hand-maintained documentation that can drift** from them. T048 adds a single
  source of truth so the cheat sheet, the `⌘K` palette, and the real handlers cannot disagree, and
  wires the **still-missing** global actions (next-item, extract, cloze, postpone, done, delete,
  raise/lower, search, open-parent, open-source).
- **No `search.*` `window.appApi` surface** — confirmed: `SearchRepository`
  (`packages/local-db/src/search-repository.ts`) exists but is **not exposed** over IPC, and there
  are **no FTS5 tables** (`packages/db/src/schema/index.ts` notes "FTS5 tables … arrive with search
  later"). This is **M8/T042**, a **prerequisite of T049's search step** — not built in M10.
- **No `backups.*` `window.appApi` surface** — confirmed: only filesystem `backupsDir` *paths*
  exist (`apps/desktop/src/main/paths.ts`); there is no `backups.create`/`restore` command and no
  `backup` group in `appApi.ts`. This is **M9/T047**, a **prerequisite of T049's backup step** —
  not built in M10.
- **No native application menu / global shortcuts** — confirmed: no `Menu`/`globalShortcut` usage
  in `apps/desktop/src/main/`. T048 optionally adds a minimal native menu (with a Help →
  "Keyboard shortcuts" item opening the cheat sheet) and native accelerators for the universal
  actions (Cmd-K, Cmd-F, etc.); T050 adds the standard macOS app menu polish.
- **No packager / installer of any kind** — confirmed: no `electron-builder`, `@electron-forge`,
  `electron-packager`, `dmg`, `notarize`, or `codesign` anywhere in the repo. `apps/desktop` only
  bundles `main.cjs`/`preload.cjs` for **dev/test launch**; there is no `.app`/`.dmg` build. **T050
  adds the packager** (choice + justification below) — this is the single largest deliverable in
  M10 and the literal definition of "ship."
- **No onboarding / first-run / backup-reminder polish** — there is no empty-state first-run flow,
  no "create your first backup" prompt, no "no backup in N days" reminder. T050 adds the minimal
  shippable version of these (backed by T047's backup command + the `settings` table).

Build order: **T048 first** (needs only M1–M7, all present), then — **after M8 (T041–T043) and M9
(T044–T047) are `[x]`** — **T049**, then **T050**. Generate `tasks/M8-organize-search.md` and
`tasks/M9-safety-analytics-backup.md` from the roadmap before building those milestones; this M10
file is generated ahead per the orchestration loop and treats T042/T043/T044/T047 as named
prerequisites it consumes.

Read first:
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"UX rules"** (keyboard-first; frequent actions need
  shortcuts + command-palette access), **"Testing expectations"** (the MVP E2E flow + "a feature
  is not complete unless it works after **app restart**"), **"MVP boundaries"** (ships as a
  **local-first Electron desktop app**, macOS at minimum — not a PWA), and the **"Definition of
  done"** (the ship checklist: SQLite persists, assets persist, backup works, survives restart, no
  raw DB/FS exposed to the renderer).
- [`../design-system.md`](../design-system.md) — the `⌘K` palette + `CheatSheet`; the keyboard-
  first ethos; the shell chrome these shortcuts drive.
- [`../architecture.md`](../architecture.md) — the layering the "same command for key + button"
  rule enforces; the Electron security posture the packaged app must preserve.
- Existing code (the seams above): `apps/web/src/shell/{useShellShortcuts.ts,CommandPalette.tsx,
  CheatSheet.tsx,nav.ts,Kbd.tsx,Shell.tsx}`; `apps/web/src/pages/queue/useProcessShortcuts.ts`;
  `apps/web/src/review/ReviewScreen.tsx`; `apps/web/src/lib/appApi.ts`; `apps/desktop/src/main/
  {index.ts,window.ts,renderer-protocol.ts,paths.ts}`; `apps/desktop/build.mjs` +
  `scripts/{dev.mjs,vendor-native.mjs}`; `tests/electron/launch.ts` + `playwright.config.ts`.
- Design kit (immutable reference): the prototype's command palette + `CheatSheet` + `g`+letter
  nav in `design/kit/app/shell.jsx` (the source T004 rebuilt from). Match its visual output.

---

## T048 — Keyboard shortcuts & command palette

- **Status:** `[ ]`  · **Depends on:** T031, T037, T021
- **Roadmap line:** Done when: shortcuts exist for next-item, extract, cloze, postpone, done,
  delete, raise/lower priority, search, open-parent, open-source, and command palette; the main
  workflow is mouse-free. Shortcuts invoke commands through the **same typed `window.appApi`
  path** as the UI buttons (no separate mutation path).

### Goal

The entire core loop becomes **mouse-free**. Every frequent action has a keyboard shortcut and a
command-palette entry, and **every shortcut/palette command invokes the exact same typed
`window.appApi` command as its on-screen button** — there is no second mutation path for the
keyboard. The `⌘K` palette (extended from T004) gains real **action** commands (not just route
navigation), the `?` cheat sheet is driven from a **single shortcut registry** so it can never
drift from the real handlers, and the still-unwired global actions — next-item, extract, cloze,
postpone, done, delete, raise/lower priority, search, open-parent, open-source — are bound. After
T048 a user can import, triage, read, extract, build a card, review, reschedule, and search
without touching the mouse.

### Context to load first

- Reference: `CLAUDE.md` "UX rules" (keyboard-first; frequent actions need shortcuts + palette
  access); `design-system.md` (the palette + `CheatSheet`).
- Existing code to inspect: `apps/web/src/shell/useShellShortcuts.ts` (the global handler to
  extend), `apps/web/src/shell/nav.ts` (`COMMAND_ITEMS`/`CHEAT_SHEET`/`GOTO_MAP` — the catalogue +
  doc to unify into a registry), `apps/web/src/shell/CommandPalette.tsx` (runs a `CommandItem` —
  extend `CommandItem` to carry an **action** as well as a route), `apps/web/src/shell/
  CheatSheet.tsx`; the two **exemplar** per-screen hooks `apps/web/src/pages/queue/
  useProcessShortcuts.ts` + `apps/web/src/review/ReviewScreen.tsx` (the pattern to generalize, NOT
  duplicate); `apps/web/src/reader/{SelectionToolbar.tsx,useTextSelection.ts}` (Extract/Cloze keys
  source from the same selection→`appApi.createExtraction`/`createCard` path); `apps/web/src/
  reader/navigateToLocation.ts` + `apps/web/src/components/inspector/LineageTree.tsx`
  (open-parent/open-source navigation) ; `apps/web/src/lib/appApi.ts` (the only mutation surface
  the keys may call).
- Invariants in play: **one command per action** (key + button + palette all call the same
  `appApi.*`); shortcuts are suppressed while typing in input/textarea/contenteditable and must not
  hijack `⌘K`/`Cmd-F`/native chords; no domain logic in the shortcut layer — handlers only
  *dispatch* an existing `appApi` call or a navigation.

### Deliverables

- [ ] **A single shortcut registry** (e.g. `apps/web/src/shell/shortcuts.ts`) — the **one source
      of truth** that the cheat sheet, the `⌘K` palette, and the real key handlers all read.
      Each entry: `{ id, label, keys: string[], group, scope: "global" | "reader" | "review" |
      "queue", when?: (ctx) => boolean }`. The cheat sheet (`CHEAT_SHEET`) and palette action
      entries are **derived from this registry**, not hand-written — so the doc cannot drift.
      Migrate the existing hand-maintained `CHEAT_SHEET`/`COMMAND_ITEMS` content into it (keep the
      same labels/keys the kit shows). Add a Vitest test asserting **every registry entry that
      claims a `scope` is actually bound** by the matching hook (catch drift in CI).
- [ ] **Global / cross-screen shortcuts wired** through the SAME `appApi` commands as the buttons,
      added to `useShellShortcuts` (or a small composed set of scope hooks it mounts), each
      suppressed while typing:
      - **next-item** (`n` / `→` / `␣` in a loop context) → the active screen's "next" (already in
        `useProcessShortcuts`; ensure the review session's "next card" honours the same key where
        it has no answer-reveal conflict).
      - **extract** (`E`) and **cloze** (`C`) → when a reader selection exists, call the SAME
        `appApi.createExtraction` / `appApi.createCard` the `SelectionToolbar` buttons call (reuse
        `useTextSelection` — do **not** add a second selection→extract path).
      - **postpone** (`p`), **done** (`d`), **delete** (`⌫`/`Delete`) → the active item's
        `appApi.actOnQueueItem` / `extracts.postpone` / `deleteCard` etc. (the exact command the
        on-screen button uses for that element type).
      - **raise / lower priority** (`+`/`=` and `-`) → `appApi.setElementPriority` (the universal
        priority write — same as the inspector/queue buttons).
      - **search** (`Cmd-F` / `/`) → focus the command bar / open search (route to `/search`;
        when the M8 `search.*` surface exists, the palette also runs an inline query — see
        "extend when present").
      - **open-parent** (`u` "up") and **open-source** (`o`) → navigate the lineage: open-parent
        uses the element's parent from `appApi.getLineage`/the inspector; open-source reuses the
        **T022** `navigateToLocation` (jump to the originating paragraph) — do **not** build a
        second jump path.
- [ ] **Command-palette ACTION entries** — extend `CommandItem` (`apps/web/src/shell/nav.ts`) so an
      entry can carry an `action` (an `appApi`-backed handler) in addition to / instead of a `to`
      route, and extend `CommandPalette.tsx`'s `runItem` to run it. Add palette commands for the
      universal actions above that make sense context-free (e.g. "New manual note…" already exists;
      add "Extract selection", "Make cloze", "Raise/Lower priority", "Postpone", "Open source",
      "Open parent", "Start review", "Search…"). Context-scoped actions show only when applicable
      (use the registry's `when`).
- [ ] **Reconcile the cheat sheet with reality** — every key the `CHEAT_SHEET` documents must be
      bound (or removed); every bound global key must appear in the cheat sheet. After T048 the
      `?` sheet is a true reflection of the registry.
- [ ] **(Optional but recommended) a minimal native menu** in `apps/desktop/src/main/` (new
      `menu.ts`, installed from `index.ts`): the standard macOS app menu + Edit (copy/paste/select-
      all so editor shortcuts work) + a **Help → "Keyboard shortcuts" (⌘/)** item that messages the
      renderer to open the cheat sheet (a one-way IPC event the shell listens for). Keep
      accelerators consistent with the in-app keys. This is also a T050 polish item — landing the
      skeleton here is fine.
- [ ] **Tests (Vitest, renderer):** the registry-vs-handlers drift test (above); a `CommandPalette`
      test that an **action** entry runs its handler (mock `window.appApi`); a `useShellShortcuts`
      (or scope-hook) test that `E`/`C` with a live selection call
      `appApi.createExtraction`/`createCard`, `p`/`d`/`⌫` call the right `appApi` action, `+`/`-`
      call `appApi.setElementPriority`, and `o` invokes `navigateToLocation` — i.e. **the key and
      the button hit the same mock**. Confirm typing in an input suppresses all of them and `⌘K`
      still wins.
- [ ] **Playwright E2E** in `tests/electron/` (e.g. `tests/electron/keyboard.spec.ts`): drive a
      **mouse-free** mini-loop entirely by keyboard — open `⌘K`, run an action command; in the
      reader, select text and press `E` → an extract is created (assert via the bridge); press `C`
      → a cloze card; in the queue, `p`/`d`/`+`/`-` mutate the right item; `o` opens the source at
      the right paragraph; `?` shows the cheat sheet. Assert each keyboard action wrote the **same**
      `operation_log` op its button does. **Survives app restart** (the mutations persist).

### Done when

- Shortcuts exist and are bound for **next-item, extract, cloze, postpone, done, delete,
  raise/lower priority, search, open-parent, open-source, and the command palette**; the core loop
  (import → triage → read → extract → card → review → reschedule → search) is fully operable
  **without the mouse**.
- **Every shortcut and palette command invokes the same typed `window.appApi` command as its UI
  button** — verified by a test where the key and the button hit the same mock and write the same
  `operation_log` op. No new mutation path, no new op type, no domain logic in the shortcut layer.
- The `?` cheat sheet and `⌘K` palette are **derived from the single shortcut registry** and
  cannot drift from the real handlers (drift test green).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the keyboard Playwright spec pass; mutations
  survive app restart.

### Notes / risks

- **Do not reimplement existing key logic.** `useProcessShortcuts` and the review screen already
  delegate to the right commands — T048 *generalizes the pattern into a registry* and *fills the
  gaps*, it does not move logic. Prefer composing small per-scope hooks that all read the registry
  over one mega-handler.
- **Keep `⌘K`/`Cmd-F` and editor chords sacred.** The shell handler already lets `⌘K` through while
  typing and ignores chorded keys for single-letter actions; preserve that. Editor shortcuts
  (Tiptap bold/italic/link) must keep working — single-letter actions must remain suppressed inside
  the editor/contenteditable.
- **`search` and `open-source`/`open-parent` have partial backends today.** `navigateToLocation`
  (T022) is fully built — wire `o`/`u` now. The inline **search query** needs the M8 `search.*`
  surface (T042); until that lands, `Cmd-F`/`/` routes to `/search` and the palette "Search…" item
  navigates — **extend it to run an inline query when `appApi.searchQuery` exists** (leave a
  clearly-marked TODO). This is the only T048 deliverable that is route-only until M8.
- **Layout-aware keys (Dvorak/Vim):** the T011 `keyboardLayout` setting exists; the MVP can ship
  QWERTY bindings and note layout remapping as a later refinement (do not block T048 on it).
- The native menu is optional for T048's "mouse-free" definition (the in-renderer keys satisfy it)
  but pays off in T050; if time-boxed, ship the registry + in-renderer keys here and the menu in
  T050.

---

## T049 — MVP end-to-end tests

- **Status:** `[ ]`  · **Depends on:** T048, T047
- **Roadmap line:** Done when: Playwright runs against the **Electron app** where feasible and
  covers import → activate → read → extract → convert-to-card → review → reschedule → search →
  backup, plus a **restart-app → verify-persistence** step proving data survives an app restart.

### Goal

**One Playwright/Electron spec that walks the entire MVP as a single user journey** and proves the
whole thing is durable: it launches the real built desktop app against a fresh, isolated data dir,
then `import → activate → read → set read-point → extract → convert-to-card (Q&A + cloze) →
review (grade) → reschedule → search → open original source → backup`, **restarts the app against
the same data dir**, and verifies every artifact (the source, read-point, extract + lineage, both
cards, review logs + advanced due dates, the search index, the source location, and the backup
bundle) **survived the restart**. This is the canonical proof that the MVP works after an app
restart — the charter's hard gate ("a feature is not complete unless it works after app restart").

### Context to load first

- Reference: `CLAUDE.md` "Testing expectations" (the exact MVP E2E flow + the restart+verify step)
  and "Definition of done" (survives app restart; data written to SQLite remains after restart).
- Existing code to inspect: `tests/electron/launch.ts` (`ensureBuilt`/`makeDataDir`/`launchApp` —
  **the harness; reuse `launchApp(sameDataDir)` for the restart**), `playwright.config.ts` (the
  `electron` project), and the **existing per-feature specs to lift assertions from**, in flow
  order: `inbox.spec.ts` (import + triage/activate), `read-points.spec.ts` + `source-reader.spec.ts`
  (read + read-point), `extraction.spec.ts` + `lineage.spec.ts` (extract + lineage),
  `cards.spec.ts` (convert-to-card Q&A + cloze), `review.spec.ts` + `review-edit.spec.ts`
  (review/grade/reschedule), the **M8** search spec (T042, lift its search assertions), and the
  **M9** backup spec (T047, lift its bundle assertions). The `review.spec.ts` `AS_OF` clock trick
  (drive a fixed future `asOf` so the seeded due card reads as due) is the pattern for making
  review deterministic.
- Invariants in play: the spec drives the app **only through the UI + the `window.appApi` bridge**
  (no DB pokes — reads go through `appApi.getInspectorData`/`getLineage`/`reviewSessionNext`/
  `searchQuery`); the restart reuses the **same `INTERLEAVE_DATA_DIR`**; assertions check
  **persistence**, **lineage** (`card → extract → source location → source`), and the
  **`operation_log`** where it's the clearest proof.

### Deliverables

- [ ] **`tests/electron/mvp-flow.spec.ts`** — the single end-to-end journey, `test.describe.
      configure({ mode: "serial" })`, one isolated `dataDir` shared across the whole describe,
      stepping through (each step asserting its artifact via UI **and** a bridge read):
      1. **Import** — open `/inbox`, "New source", paste a multi-paragraph article (title + body) →
         it appears in the inbox (via UI + `appApi.listInbox`).
      2. **Activate** — triage the source into active learning (`appApi.triageInboxItem`) → it
         leaves the inbox / becomes active.
      3. **Read + set read-point** — open `/source/$id`, scroll/select, set the read-point (`␣`) →
         `appApi.getReadPoint` returns it; reopening resumes near it.
      4. **Extract** — select a paragraph, press `E` (or the toolbar) → a child `extract` is created
         with a source location; `appApi.getLineage` shows `source → extract`.
      5. **Convert to card (both kinds)** — from the extract, build a **Q&A** card and a **cloze**
         card (`appApi.createCard`) → both appear with lineage back to the extract.
      6. **Review (grade) + reschedule** — open `/review` (with the fixed-future `asOf` trick so a
         card reads as due), reveal, grade → `appApi.reviewGrade` writes a `review_logs` row and
         advances `review_states.due_at` (assert reschedule per rating; cover at least one grade,
         ideally Again + Good to show interval ordering).
      7. **Search** — run a query for a word from the source/extract/card (via the M8 `appApi.
         searchQuery` once T042 lands; through the `/search` UI) → the source/extract/card are
         returned.
      8. **Open original source** — from a card/extract, "open source" (`o`) → lands on the
         originating paragraph in `/source/$id` (the T022 jump-to-source flash), proving lineage is
         navigable end to end.
      9. **Backup** — trigger a backup (the M9 `appApi.createBackup`, T047) → a `backups/<ts>/`
         bundle (`app.sqlite` + `assets/` + `manifest.json`) is written; assert the manifest +
         integrity hashes via the bridge / filesystem.
      10. **RESTART** — close the Electron app and `launchApp(sameDataDir)` again.
      11. **Verify persistence** — after restart, re-read through the bridge: the source, its
          read-point, the extract + its source location + lineage, both cards, the review logs +
          advanced due dates, search still finds the content, and the backup bundle is still on
          disk. **Nothing was lost across the restart.**
- [ ] **Determinism + isolation:** reuse `makeDataDir()` (a per-run temp `INTERLEAVE_DATA_DIR`) so
      the spec never touches the developer's real data; use the fixed-future `asOf` clock for the
      review step; do **not** depend on the dev seed (the flow *creates* its own data so the test
      proves the real authoring path, not just seeded reads) — though it may start from an empty DB.
- [ ] **CI wiring:** the spec runs in the existing `electron` Playwright project; ensure it is part
      of the `pnpm e2e` run gated in CI. (It is the heaviest spec — keep it serial; the harness
      already builds artifacts once via `ensureBuilt`.)
- [ ] **Docs:** check the T049 box in `roadmap.md` with the commit ref; note in the progress log
      that the canonical MVP-flow + restart proof exists.

### Done when

- A single Playwright/Electron spec drives the **full MVP flow** against the real built app —
  `import → activate → read → set read-point → extract → convert-to-card (Q&A + cloze) → review
  (grade) → reschedule → search → open original source → backup` — and then **restarts the app and
  verifies every artifact persisted** (source, read-point, extract + lineage, both cards, review
  logs + due dates, search index, source location, backup bundle).
- The spec uses only the UI + the typed `window.appApi` bridge (no raw DB access), reuses the
  existing `launch.ts` harness, and is green in CI under `pnpm e2e --project=electron`.
- `pnpm typecheck`, `pnpm test`, and `pnpm lint` remain green.

### Notes / risks

- **Hard prerequisites (build first):** T049's *search* step needs **T042** (`appApi.searchQuery` +
  FTS5 tables — neither exists today) and its *backup* step needs **T047** (`appApi.createBackup`/
  the `backups.*` surface — does not exist today). The roadmap lists `T049: deps T048,T047` but the
  flow text also requires search; **M8 (T041–T043) and M9 (T044–T047) must be `[x]` before T049**.
  If a builder reaches T049 with M8/M9 incomplete, **stop and build them** — do not fake search or
  backup.
- **Reuse, don't rewrite.** Lift the per-step assertions from the existing feature specs
  (`inbox`/`extraction`/`cards`/`review`/search/backup) rather than re-deriving selectors; the
  value of T049 is the **single uninterrupted journey + the restart**, not new coverage of each
  feature.
- **Open source = T022.** The "open original source" step exercises the existing
  `navigateToLocation` jump — do not add a parallel path.
- **Restart is the point.** The whole spec exists to prove durability; the relaunch
  (`launchApp(sameDataDir)`) and the post-restart re-reads are the load-bearing assertions —
  budget the most care there.
- This spec is the **gate for T050** — if it is flaky, T050's "shippable" claim is unfounded.
  Prefer bridge reads (deterministic) over scraping rendered text for the persistence assertions.

---

## T050 — Ship MVP as a local-first Electron desktop app

- **Status:** `[ ]`  · **Depends on:** T049
- **Roadmap line:** Done when: the app builds and runs as an Electron desktop app on macOS at
  minimum — SQLite persists in the app data directory, assets persist in the vault, backup works,
  the core loop works, the app survives restart, and no raw DB/filesystem APIs are exposed to the
  renderer; backup prompts and onboarding are polished; one person can use it daily for a week with
  no manual DB edits.

### Goal

Turn the dev-only Electron shell into a **real, installable macOS desktop application**. Today the
app only runs via `electron .` against a dev bundle (`apps/desktop/build.mjs` produces
`main.cjs`/`preload.cjs` for the Playwright harness) — there is **no packager**. T050 adds a
packager that produces a distributable `.app` (+ a `.dmg` for install), correctly bundling the
**Electron-ABI `better-sqlite3`** native module and the staged Drizzle migrations, loading the
renderer **fully offline** from the `app://` protocol, persisting SQLite + the asset vault in the
real macOS app data directory, and surfacing **backup prompts + first-run onboarding** so a
non-developer can install it and use the core loop daily for a week with no manual DB edits.

### Context to load first

- Reference: `CLAUDE.md` "MVP boundaries" (ships as a local-first **Electron desktop app**, macOS
  at minimum — not a PWA) + "Definition of done" (the ship checklist) + "Asset vault" + "SQLite
  rules" (the real app data dir + pragmas the packaged app must honour).
- Existing code to inspect: `apps/desktop/build.mjs` (the esbuild bundle that stages
  `main.cjs`/`preload.cjs` + `dist/drizzle`; the packager wraps **around** this, it does not
  replace it), `apps/desktop/scripts/vendor-native.mjs` + `apps/desktop/native/` +
  `apps/desktop/src/main/native-binding.ts` (the **Electron-ABI `better-sqlite3`** handling —
  **the packaged app must ship this exact binary, not the Node-ABI one**), `apps/desktop/src/main/
  {index.ts (lifecycle/migrations), window.ts (secure window), renderer-protocol.ts (the offline
  `app://` loader), paths.ts (the real `~/Library/Application Support/<app>/` data dir + `assets/`
  + `backups/`)}`, `apps/desktop/package.json` (`main: dist/main.cjs`; add the packager + its
  scripts here), the **M9 backup surface** (T047 `appApi.createBackup`/`restoreBackup`).
- Invariants in play: the packaged app keeps the **full Electron security posture**
  (`contextIsolation`/no `nodeIntegration`/`sandbox`/no remote module; renderer loads via `app://`,
  never `http`); **no raw DB/filesystem APIs reach the renderer**; SQLite + the vault live in the
  app data dir and survive restart; the production app **runs offline** (no dev server, no network).

### Deliverables

- [ ] **Choose and add a packager: `electron-builder`** (recommended — justification below). Add it
      as a devDependency of `apps/desktop` and an `electron-builder.yml` (or a `build` block in
      `apps/desktop/package.json`) producing a **macOS `.app` + `.dmg`** (`arm64` at minimum; a
      universal/`x64`+`arm64` build is a nice-to-have). Add a root + `apps/desktop` script
      (`pnpm --filter @interleave/desktop dist` / a root `pnpm dist`) that: (1) builds the renderer
      (`@interleave/web build`), (2) runs `apps/desktop/build.mjs` to produce `main.cjs`/`preload.cjs`
      + staged migrations, (3) runs `electron-builder` to package.
  - **Packager choice + justification:** **`electron-builder`** over `@electron-forge`. The repo
    already does its **own esbuild bundling + native-module vendoring** (`build.mjs` +
    `vendor-native.mjs` + `native-binding.ts`) and has a custom `app://` protocol loader.
    `electron-builder` is a **packaging-only** tool that wraps an already-built `main.cjs` —
    it slots cleanly **around** the existing pipeline (point `electron-builder` at the `dist/` +
    `node_modules` and let it produce the `.app`/`.dmg`), with first-class `asarUnpack` for native
    modules and built-in `dmg`/notarization config. `@electron-forge` is more opinionated about
    *owning* the build (its own webpack/vite plugins + bundling lifecycle), which would **fight**
    the existing esbuild/`build.mjs` + custom protocol setup and the bespoke `better-sqlite3`
    vendoring. `electron-builder` is the lower-friction, less-rewrite choice for this codebase.
- [ ] **Native module + migrations in the package:** configure the packager so the **Electron-ABI
      `better-sqlite3`** binary (from `vendor-native.mjs`/`native/`) is unpacked from the asar
      (`asarUnpack`) and loadable at runtime via `native-binding.ts`, and the staged Drizzle
      migrations (`dist/drizzle`) ship inside the app and run on first launch (`index.ts` already
      runs migrations on startup). **Verify the packaged app opens SQLite and migrates** — this is
      the #1 packaging failure mode for `better-sqlite3` Electron apps.
- [ ] **Offline production load verified:** the packaged app loads the renderer from the `app://`
      protocol (`renderer-protocol.ts`) with **no dev server and no network**; assert it launches
      with networking unavailable. (Dev keeps loading the Vite server; production must not.)
- [ ] **Persistence in the real app data dir:** the packaged app writes `app.sqlite` (+ `-wal`/
      `-shm`), `assets/`, and `backups/` under the real macOS app data dir (`paths.ts`, no
      `INTERLEAVE_DATA_DIR` override in production) and **all of it survives quit + relaunch**.
- [ ] **Onboarding + backup polish (the "usable daily for a week" deliverables):**
  - a minimal **first-run / empty-state onboarding** (a welcome panel or empty-state in
    `/inbox`/`/queue` guiding "import your first source") — reuse the kit's `EmptyState`; persist a
    "seen onboarding" flag in the `settings` table.
  - **backup prompts:** a "Create a backup now" affordance (calls T047 `appApi.createBackup`) and a
    gentle **"no backup in N days" reminder** (read the last-backup timestamp from `settings`/the
    `backups/` dir; threshold a setting). Wire a **Backup** entry into the command palette + cheat
    sheet (T048 registry) and, if the T048 native menu landed, a File → Back up… menu item.
  - a standard **macOS application menu** (File/Edit/View/Window/Help) with the Help → "Keyboard
    shortcuts" item (finish the T048 menu skeleton); set the app name/icon/`productName`.
- [ ] **App identity:** app icon, `productName`/bundle id, version wired from `package.json`; the
      `.dmg` mounts and the app installs to /Applications by drag. (Code-signing + notarization for
      *distribution* is **deferred** — see Notes; an **unsigned local build that installs and runs**
      satisfies the MVP "macOS at minimum" bar.)
- [ ] **A "shippable" verification checklist** (in the PR / a short `apps/desktop/RELEASE.md` or the
      progress log) demonstrating each Definition-of-Done item on the **packaged** app:
      installs from the `.dmg`, launches offline, completes the **T049 core loop manually**, creates
      a backup, **survives quit+relaunch**, exposes **no raw DB/FS** to the renderer (spot-check
      `window.appApi` has no `db.query`), and a one-person **week of daily use with zero manual DB
      edits** (the human acceptance gate).
- [ ] **CI (best-effort):** add a `dist` build step (macOS runner) that at least **produces the
      `.app`/`.dmg` artifact** so packaging breakage is caught; full notarized release is out of
      scope. Keep the T049 E2E gate green.

### Done when

- The app **builds and runs as an installable Electron desktop app on macOS** (a `.app` packaged
  into a `.dmg` via `electron-builder`): it installs, launches **offline** from the `app://`
  protocol, and the **packaged** app opens + migrates SQLite via the Electron-ABI `better-sqlite3`.
- On the packaged app: **SQLite persists** in the real app data dir, **assets persist** in the
  vault, **backup works** (T047), the **core loop works** (the T049 journey, run manually), and
  **everything survives quit + relaunch**.
- **No raw DB/filesystem APIs are exposed to the renderer** (the packaged `window.appApi` is the
  narrow typed surface only — no `db.query`); the full Electron security posture is intact in the
  package.
- **Backup prompts + first-run onboarding are present and polished** enough that **one person can
  use the app daily for a week with no manual DB edits** (the human acceptance gate is met).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the T049 MVP-flow Playwright spec pass; the
  packager produces the `.app`/`.dmg`.

### Notes / risks

- **`better-sqlite3` in a packaged Electron app is the top risk.** The dev harness already vendors
  the Electron-ABI binary (`vendor-native.mjs` + `native-binding.ts`); the packager must
  `asarUnpack` that binary so it's loadable from inside the `.app`. **Test the packaged app, not
  just `electron .`** — a build that works unpacked often fails packed due to native-module paths.
- **Code-signing + notarization are deferred.** A distributable, notarized macOS build (Apple
  Developer ID + `notarytool`) is **out of scope for the MVP** ("macOS at minimum" = installs and
  runs locally). Leave clearly-marked `electron-builder` config stubs (`mac.identity`, `afterSign`
  notarize hook) for a later release task. Unsigned builds will show Gatekeeper warnings — note
  this in `RELEASE.md`.
- **Windows/Linux are deferred.** `electron-builder` can target them later; the MVP ships macOS
  only. Keep the config factored so adding targets is config, not code.
- **Auto-update is deferred** (no `electron-updater` / update server in the MVP). Note it as a
  later task.
- **Don't break the dev/test path.** `electron .` (dev) and the Playwright `launch.ts` harness
  (built `main.cjs` + `INTERLEAVE_DATA_DIR` override) must keep working unchanged; the packager is
  **additive** around `build.mjs`. The production app must **not** honour `INTERLEAVE_DATA_DIR` /
  `VITE_DEV_SERVER_URL` (those are dev/test-only).
- **The "week of daily use" gate is human, not automated.** T049 proves the loop programmatically;
  T050's final acceptance is a real person living in the packaged app for a week. Treat it as the
  honest definition of "shipped MVP," not a checkbox to fake.

---

## Exit criteria for M10 (and Part I — the MVP)

- All of T048–T050 are `[x]` in [`../roadmap.md`](../roadmap.md).
- **The core loop is fully keyboard-operable.** Every frequent action — next-item, extract, cloze,
  postpone, done, delete, raise/lower priority, search, open-parent, open-source, command palette —
  has a shortcut **and** a `⌘K` entry, **both invoking the same typed `window.appApi` command as
  the on-screen button** (no separate mutation path, no new op type). The `?` cheat sheet and `⌘K`
  palette are derived from a single shortcut registry and cannot drift from the handlers.
- **The whole MVP is proven durable by one E2E.** A single Playwright/Electron spec walks
  `import → activate → read → set read-point → extract → convert-to-card (Q&A + cloze) → review
  (grade) → reschedule → search → open original source → backup`, then **restarts the app and
  verifies every artifact persisted** — against the real built app, through the UI + the typed
  bridge only.
- **It ships.** The app is packaged with `electron-builder` into an installable macOS `.app`/`.dmg`
  that launches **offline** from the `app://` protocol, opens + migrates SQLite via the
  Electron-ABI `better-sqlite3`, persists SQLite + the asset vault in the real app data dir,
  performs backups, and survives quit + relaunch — with **no raw DB/filesystem APIs exposed to the
  renderer** and the full Electron security posture intact.
- **It's usable.** First-run onboarding + backup prompts are polished enough that **one person can
  use the app daily for a week with no manual DB edits** — the honest definition of a shipped MVP.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M10 Playwright specs (the keyboard mini-loop +
  the full MVP-flow + restart) are green in CI.

> **Prerequisite reminder (resolved).** T049 consumes **M8/T042** (`appApi.searchQuery` + FTS5 —
> not yet built) and **M9/T047** (`appApi.createBackup` — not yet built). Build M8 (T041–T043) and
> M9 (T044–T047) before T049; generate `tasks/M8-organize-search.md` and
> `tasks/M9-safety-analytics-backup.md` from the roadmap first. T048 needs only M1–M7 (all present)
> and can land earlier, with its palette/cheat-sheet catalogue **extended** as M8/M9 commands
> arrive.

When M10 is complete, **Part I (the MVP, T001–T050) is done** — a genuinely useful single-person,
local-first incremental-reading desktop app. Part II (T051+) begins with the backend/sync
foundations; do not start T051 until the MVP has been used daily for a week per T050's acceptance
gate.
