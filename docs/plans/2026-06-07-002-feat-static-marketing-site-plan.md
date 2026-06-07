---
title: "Add Static Marketing Site"
type: feat
status: active
date: 2026-06-07
---

# Add Static Marketing Site

## Summary

Add a new `apps/site` workspace package for Interleave's public website. The site is a single static homepage based on the downloaded design handoff, focused on incremental reading, with GitHub Releases CTAs and an interactive reader-to-extract demo that reuses Interleave's canonical visual language without depending on the Electron renderer.

---

## Problem Frame

Interleave is currently only an application inside the monorepo. The project needs a lightweight website that can later be hosted on Cloudflare Pages, but adding it to `apps/web` would collide with the Electron renderer and could accidentally turn the public site into a browser version of the app. The design handoff already provides the intended homepage and final copy direction: shorter incremental-reading positioning, no review section, no theme selector, and download links that go only to GitHub Releases.

---

## Requirements

- R1. The repository contains a separate website package with its own `index.html`, build output, tests, and workspace scripts, while leaving `apps/web/index.html` untouched.
- R2. The homepage presents Interleave as a local-first incremental reading app, not a generic read-it-later, notes, or flashcard-only product.
- R3. The implementation uses canonical repo design assets and tokens: `design/tokens.css`, self-hosted IBM Plex fonts, app-style component classes, and the existing icon semantics.
- R4. The homepage includes the final design shape: focused hero, live reader-to-extract demo, distillation pipeline, feature grid, GitHub CTA, and footer.
- R5. All download CTAs point to GitHub Releases only; the page does not include direct app-download links, quarantine commands, version number copy, a GitHub star ask, review-section content, or a manual theme selector.
- R6. The site follows system light/dark preference, updates when the system preference changes, and has no `window.appApi`, Electron, SQLite, or filesystem dependency.
- R7. The reader demo is progressive enhancement: selecting text in the demo can create an extract, cloze draft, or highlight, but failure cases no-op without implying persistence.
- R8. The page remains usable and visually coherent at desktop and mobile widths with no clipped controls, overlapping text, or exposed non-site repository files.

---

## Key Technical Decisions

- **Create `apps/site` instead of reusing `apps/web`:** `apps/web` is the Electron renderer entrypoint. A separate app keeps Cloudflare Pages deployment, public copy, and static assets isolated from desktop packaging and app routes.
- **Use Vite for a static site package:** A small Vite app gives the repo a normal `build`, `dev`, `preview`, `test`, and `typecheck` contract while still shipping plain `index.html`, CSS, and TypeScript-enhanced JavaScript.
- **Reuse tokens, not renderer internals:** `packages/ui` is still a placeholder and many `apps/web` components assume router, shell, or desktop API context. This pass reuses `design/tokens.css`, app CSS patterns, logo assets, and icon semantics rather than extracting shared React components.
- **Self-host fonts like the app:** The design bundle imports Google Fonts, but the repo's canonical token file intentionally avoids network font loading. The site should import the same `@fontsource` IBM Plex packages used by the renderer.
- **Keep site interaction static and local:** The reader demo is DOM-only, ephemeral, and testable. It does not call app APIs, store visitor data, or add analytics.

---

## Implementation Units

### U1. Site Package Scaffold

- **Goal:** Add an isolated static website workspace package with Vite, TypeScript, Vitest, and a root `index.html`.
- **Requirements:** R1, R6, R8
- **Dependencies:** none
- **Files:** Create `apps/site/package.json`, `apps/site/tsconfig.json`, `apps/site/vite.config.ts`, `apps/site/vitest.config.ts`, `apps/site/index.html`; modify `tsconfig.json`; expect `pnpm-lock.yaml` to update.
- **Approach:** Keep the package name `@interleave/site`; use the existing workspace dependency versions where possible. Configure Vite to allow importing `design/tokens.css` from the repo root, mirroring the renderer's token-import pattern.
- **Patterns to follow:** `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/src/styles.css`.
- **Test scenarios:** The package resolves through pnpm workspace filters; `vite build` emits an `apps/site/dist/index.html`; TypeScript project references include the site without disturbing existing packages.
- **Verification:** `pnpm --filter @interleave/site build`; `pnpm --filter @interleave/site typecheck`.

### U2. Homepage Markup And Assets

- **Goal:** Implement the final design homepage as `apps/site/index.html`.
- **Requirements:** R2, R4, R5, R8
- **Dependencies:** U1
- **Files:** Modify `apps/site/index.html`; add `apps/site/public/assets/logo.png`, `apps/site/public/assets/icon.png`.
- **Approach:** Adapt the handoff's final `project/index.html`, preserving the trimmed incremental-reading copy and removing the review section, manual theme selector, direct-download copy, quarantine command, version copy, and star ask. Use GitHub Releases for download CTAs.
- **Patterns to follow:** Downloaded handoff files `interleave-2/project/index.html` and `interleave-2/chats/chat1.md`; repo design intent in `docs/design-system.md` and `CONCEPTS.md`.
- **Test scenarios:** Header, hero, pipeline, feature grid, CTA, and footer render in the static DOM; no forbidden copy appears; all download links use the releases URL; footer/source links are external GitHub links or local anchors.
- **Verification:** DOM/unit tests for copy and links; browser smoke check in a local preview.

### U3. Shared Visual Language CSS

- **Goal:** Add site-specific CSS that imports canonical tokens and implements the marketing layout without duplicating token definitions.
- **Requirements:** R3, R4, R6, R8
- **Dependencies:** U1, U2
- **Files:** Create `apps/site/src/styles.css`.
- **Approach:** Import `@fontsource` IBM Plex weights and `../../../design/tokens.css`, then add the landing-specific layout and reused component classes from the design handoff. Remove dead review-demo and quarantine styles. Keep colors, spacing, radii, type, scheduler chips, badges, and reader marks expressed through CSS variables.
- **Patterns to follow:** `apps/web/src/styles.css`, `design/tokens.css`, `design/kit/styles/app.css`, downloaded `interleave-2/project/styles/site.css`.
- **Test scenarios:** CSS imports canonical tokens; no Google Fonts import remains; no hard-coded app-palette hex colors are introduced; responsive breakpoints keep the hero, app-window demo, pipeline, and feature grid readable.
- **Verification:** CSS/source tests plus visual inspection at desktop and mobile widths.

### U4. Icons, Theme, Pipeline, And Demo Behavior

- **Goal:** Implement the small TypeScript runtime that paints icons, follows system theme, renders the distillation pipeline, and powers the reader extraction demo.
- **Requirements:** R3, R6, R7
- **Dependencies:** U2, U3
- **Files:** Create `apps/site/src/icons.ts`, `apps/site/src/site.ts`, `apps/site/src/icons.test.ts`, `apps/site/src/site.test.ts`.
- **Approach:** Port the design handoff's icon semantics into a typed local icon map and expose `iconSvg`. Keep the theme helper as a system-preference sync only. Export small functions for icon painting, pipeline rendering, selection validation, HTML escaping, extract-card rendering, and action handling so Vitest can cover behavior without a browser server.
- **Patterns to follow:** `apps/web/src/components/Icon.tsx`, `design/icon-map.md`, downloaded `interleave-2/project/js/icons.js` and `interleave-2/project/js/site.js`.
- **Test scenarios:** Every `data-icon` in `index.html` resolves; unknown icon names render harmlessly; pipeline renders six steps with current and completed states; system theme sets `data-theme` and responds to preference changes; extract/cloze/highlight actions update DOM state and escape selected text; selections outside the reader no-op.
- **Verification:** `pnpm --filter @interleave/site test`; manual reader-demo smoke check.

### U5. Verification And Documentation Trail

- **Goal:** Prove the site builds in isolation and fits repo conventions without adding Cloudflare deployment configuration yet.
- **Requirements:** R1, R5, R6, R8
- **Dependencies:** U1, U2, U3, U4
- **Files:** Modify this plan status after shipping; add a solution learning if a durable site-integration pattern emerges.
- **Approach:** Run targeted site checks first, then workspace checks. Use browser verification for the static page because the request is visual and interactive. Do not add Cloudflare-specific config unless implementation reveals it is necessary.
- **Patterns to follow:** Native pnpm verification in `AGENTS.md`, `docs/architecture.md`, and `docs/roadmap.md`.
- **Test scenarios:** `apps/web/index.html` remains unchanged; site tests and build pass; workspace typecheck/test/lint pass; the preview has no console errors; the page has no manual theme UI or direct-download/quarantine/star copy.
- **Verification:** `pnpm --filter @interleave/site test`; `pnpm --filter @interleave/site build`; `pnpm typecheck`; `pnpm test`; `pnpm lint`; browser smoke screenshots for desktop and mobile if the dev server starts cleanly.

---

## Scope Boundaries

- Do not replace or reroute the Electron renderer in `apps/web`.
- Do not extract or build a general `packages/ui` component library in this task.
- Do not add Cloudflare Pages configuration, DNS settings, redirects, analytics, or release automation.
- Do not add a PWA/browser app version or expose any desktop data capability to the website.
- Do not edit `design/kit/`; it remains immutable reference material.

---

## Sources / Research

- Downloaded design handoff from `https://api.anthropic.com/v1/design/h/M-k38AfFwv1zNeb3JS5ZcQ?open_file=index.html`, extracted locally as a gzip tar bundle.
- `interleave-2/chats/chat1.md` records the final design direction and removals.
- `interleave-2/project/index.html`, `styles/site.css`, `js/icons.js`, and `js/site.js` provide the visual and interaction source.
- `docs/design-system.md`, `design/tokens.css`, and `apps/web/src/styles.css` define canonical Interleave tokens and offline font loading.
- `apps/web/index.html` is the Electron renderer entrypoint and must stay out of the public site.
- `packages/ui/src/index.ts` is still a placeholder, so component reuse is currently visual/token-level rather than shared React component reuse.
- `docs/solutions/architecture-patterns/electron-main-rolling-backups-over-renderer-reminders.md` and `docs/solutions/architecture-patterns/pathless-backups-open-folder-ipc.md` reinforce keeping static/browser surfaces free of trusted desktop capabilities.
