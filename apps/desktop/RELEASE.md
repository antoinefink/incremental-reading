# Interleave — macOS desktop release & verification checklist (T050)

Interleave ships as a **local-first Electron desktop app for macOS** (arm64). This
document is the "shippable" verification checklist: how to build the installable
`.app`/`.dmg`, and the Definition-of-Done items demonstrated against the **packaged**
app (not just `electron .`).

## Build the installer

The packager is **additive** around the existing pipeline (`build.mjs` +
`vendor-native.mjs` + the custom `app://` protocol). `electron-builder` is
packaging-only; it wraps the already-built `dist/`.

```sh
# From the repo root (native pnpm — Docker is NOT used for the desktop app):
pnpm --filter @interleave/desktop dist        # → release/Interleave-<ver>-arm64.dmg + release/mac-arm64/Interleave.app

# Faster, no .dmg (CI / constrained envs):
INTERLEAVE_DIST_DIR_ONLY=1 pnpm --filter @interleave/desktop dist   # → release/mac-arm64/Interleave.app

# Re-package an existing dist/ without rebuilding the renderer/bundle:
INTERLEAVE_DIST_SKIP_BUILD=1 pnpm --filter @interleave/desktop dist
```

`pnpm dist` runs, in order: (1) `@interleave/web build` (renderer), (2)
`vendor-native.mjs` (Electron-ABI `better_sqlite3.node`, if missing), (3) `build.mjs`
(bundles `main.cjs`/`preload.cjs`, stages `dist/drizzle` + `dist/renderer`), (4)
`electron-builder` (`.app` + `.dmg`).

## Architecture notes that make packaging work (read before changing the config)

- **No `@interleave/*` production deps.** The five workspace packages are
  **devDependencies** (`package.json`) — esbuild already inlines them into
  `main.cjs`. If they were production deps, pnpm would symlink them into
  `node_modules/@interleave/*` → `../../packages/*`, and electron-builder's
  production-dependency collector would walk **outside** the app dir and abort
  asar-packing a `.turbo/turbo-build.log` whose relative path escapes the app
  (`… must be under …/apps/desktop/`). Keeping them devDeps is what makes packing
  succeed.
- **`better-sqlite3` JS is bundled into `main.cjs`** (only `electron` +
  better-sqlite3's never-reached `bindings`/`prebuild-install` are external). So the
  packaged app needs **no runtime `node_modules`** at all. The native addon is loaded
  by absolute path via `nativeBinding`, so the JS wrapper's own `require('bindings')`
  is never evaluated.
- **The native addon is `asarUnpack`ed** to `app.asar.unpacked/native/better_sqlite3.node`
  (a `.node` cannot be `dlopen`ed from inside an asar). `native-binding.ts` rewrites
  the in-asar path to the `.unpacked` sibling at runtime.
- **Fonts are self-hosted** (`@fontsource/ibm-plex-*`, imported in
  `apps/web/src/styles.css`; the Google Fonts `@import` in `design/tokens.css` is
  disabled). The packaged renderer makes **zero font network requests** — required for
  the fully-offline `app://` load.
- **Dev/test paths are unchanged.** `electron .` (dev) and the Playwright `launch.ts`
  harness still build + run the same `main.cjs`; the packaged app **ignores**
  `INTERLEAVE_DATA_DIR` / `VITE_DEV_SERVER_URL` (`paths.ts` / `index.ts`).

## Deferred (out of scope for the MVP — clearly stubbed)

- **Code-signing + notarization** (`mac.identity: null`, `hardenedRuntime: false` in
  `electron-builder.yml`). An unsigned build shows a Gatekeeper warning on first
  launch — open it with **right-click → Open** (or `xattr -dr com.apple.quarantine
  /Applications/Interleave.app`). Add a Developer ID `identity` + an `afterSign`
  notarize hook for a real distribution release.
- **App icon** — the default Electron icon is used (`mac.icon` stub left in the
  config). Drop a real `build/icon.icns` for the final release.
- **Windows / Linux targets**, **auto-update** (`electron-updater`), and a
  **universal (x64+arm64)** build — all later-only; adding them is config, not code.

## Definition-of-Done — verified on the PACKAGED app

Verified against `release/mac-arm64/Interleave.app` (arm64), built by `pnpm dist`:

- [x] **Builds + installs as an Electron desktop app on macOS.** `electron-builder`
      produces `release/Interleave-0.0.0-arm64.dmg` (~112 MB) and
      `release/mac-arm64/Interleave.app`. The `.dmg` mounts and shows
      `Interleave.app` + a drag-to-`/Applications` link (the standard install layout).
- [x] **Launches offline from the `app://` protocol.** The packaged app opens its
      window and creates renderer (`WEB_PAGE`) contexts with **no dev server and no
      remote network requests** — verified by launching with `--v=1` and confirming
      zero `https://` `NotifyBeforeURLRequest` to any external host (Google-Fonts
      requests are gone now that fonts are self-hosted).
- [x] **Opens + migrates SQLite via the Electron-ABI `better-sqlite3`.** On first
      launch the packaged app opens `app.sqlite` and runs the Drizzle migrations
      (`dist/drizzle`, shipped inside the asar) — verified by reading the resulting DB:
      **37 tables** present, including `__drizzle_migrations`, the core element tables,
      `operation_log`, `settings`, and the FTS5 search tables. The `asarUnpack`ed
      native addon path works (no `dlopen` failure).
- [x] **SQLite + the asset vault persist in the real app data dir.** The packaged app
      (no `INTERLEAVE_DATA_DIR` override) writes `app.sqlite` (+ `-wal`/`-shm`),
      `assets/`, `exports/`, and `backups/` under
      `~/Library/Application Support/Interleave/`, and they survive quit + relaunch.
- [x] **Backup works.** "Create a backup now" (the in-app prompt, the ⌘B shortcut, the
      ⌘K palette "Create a backup", and the native File → "Back up…" item all call the
      SAME `appApi.createBackup()` — T047) produces a `backups/<timestamp>/` bundle + a
      portable `.zip`, and records `ui.lastBackupAt`. Covered by `backup.spec.ts` +
      `onboarding.spec.ts` (the prompt path) in `pnpm e2e`.
- [x] **The core loop works + survives restart.** The single `mvp-flow.spec.ts`
      Playwright/Electron journey (`import → activate → read → set read-point → extract
      → convert-to-card (Q&A + cloze) → review (grade) → reschedule → search → open
      original source → backup`) runs against the built app and then **restarts it and
      verifies every artifact persisted**. Green under `pnpm e2e`.
- [x] **No raw DB/filesystem APIs exposed to the renderer.** `window.appApi` is the
      narrow typed surface only — there is **no `db.query`** (asserted by
      `contract.test.ts`), and the full Electron security posture is intact
      (`contextIsolation: true`, `nodeIntegration: false`, `sandbox`, no remote module;
      renderer loads via `app://`, never `http`).
- [x] **First-run onboarding + backup prompts are present.** A first-run welcome
      overlay appears once on an empty collection and persists `ui.seenOnboarding` in
      the `settings` table (survives restart); a gentle "no backup in N days" reminder
      (threshold `ui.backupReminderDays`, default 7) surfaces the one-click backup.
      Both proven by `onboarding.spec.ts`.

## Automated gates (native pnpm)

All green at release time:

- `pnpm typecheck` — 10/10 projects.
- `pnpm lint` — Biome clean (315 files).
- `pnpm test` — Vitest 798 passing (73 files), including the new `BackupPrompt`,
  `Onboarding`, `useShellShortcuts` (⌘B), and `contract` (the `menu:createBackup`
  channel) tests.
- `pnpm e2e` — Playwright/Electron **134 passing**, including `mvp-flow.spec.ts`
  (full loop + restart) and the new `onboarding.spec.ts`.
- `pnpm --filter @interleave/desktop dist` — produces the `.app` + `.dmg`.

## The human acceptance gate (not automated)

T050's final acceptance is a real person living in the packaged app **daily for a
week with no manual DB edits**. `pnpm e2e` proves the loop programmatically and this
checklist proves each DoD item on the packaged build; the week-of-use gate is the
honest definition of "shipped MVP" and is the maintainer's sign-off, not a CI check.
