---
title: "Public static sites should reuse design tokens without crossing desktop boundaries"
date: "2026-06-07"
category: "docs/solutions/architecture-patterns/"
module: "apps/site static marketing site"
problem_type: "architecture_pattern"
component: "tooling"
severity: "medium"
applies_when:
  - "A standalone Vite site imports shared repo design assets without exposing the full repository root."
  - "Self-hosted @fontsource fonts need to load while Vite server.fs.allow remains narrow."
  - "A public presentation site should look like Interleave without behaving like the desktop app."
  - "Static interaction demos mutate DOM selections and need contract tests for safe selection behavior."
tags:
  - "static-site"
  - "vite"
  - "fs-allow"
  - "fontsource"
  - "design-tokens"
  - "lucide-react"
  - "reader-demo"
  - "contract-tests"
---

# Public static sites should reuse design tokens without crossing desktop boundaries

## Context

Interleave added a public static site under `apps/site` for later Cloudflare Pages hosting while the product remains a desktop-first Electron app. The core risk was accidentally turning the public site into a browser version of the app by routing through `apps/web`, importing renderer-only helpers, or exposing desktop capabilities such as `window.appApi`, SQLite, or filesystem access.

The site still needed to look like Interleave. That meant reusing the canonical design language without sharing the Electron renderer's runtime contract.

## Guidance

Keep repo-integrated public sites as separate static packages. A public site should have its own Vite app, HTML entrypoint, CSS, tests, and build output. Do not mount it in `apps/web`, do not depend on the preload bridge, and do not expose local-first app APIs.

Reuse design assets through stable static inputs:

```css
@import "@fontsource/ibm-plex-sans/400.css";
@import "@fontsource/ibm-plex-serif/400.css";
@import "@fontsource/ibm-plex-mono/400.css";

@import "../../../design/tokens.css";
```

This keeps typography, OKLCH colors, spacing, priority badges, scheduler chips, and element-type colors consistent without coupling the site to renderer components.

For icons, follow the same semantic names as `design/icon-map.md`, but render them in the site package's own static-friendly layer. The site can use `lucide-react` and `react-dom/server` to render SVG strings for progressive enhancement:

```ts
const ICONS = {
  brain: Brain,
  download: Download,
  extract: Quote,
  gauge: Gauge,
} satisfies Record<string, LucideIcon>;

export function iconSvg(name: string, size = 16): string {
  return renderToStaticMarkup(
    createElement(ICONS[name], {
      "aria-hidden": true,
      focusable: false,
      size,
      strokeWidth: 1.75,
    }),
  );
}
```

Keep Vite dev-server access narrow. Default to localhost and allow only the roots the static site actually needs:

```ts
const siteRoot = import.meta.dirname;
const designRoot = resolve(repoRoot, "design");
const fontRoots = [
  dirname(require.resolve("@fontsource/ibm-plex-sans/package.json")),
  dirname(require.resolve("@fontsource/ibm-plex-serif/package.json")),
  dirname(require.resolve("@fontsource/ibm-plex-mono/package.json")),
];

server: {
  host: process.env.INTERLEAVE_SITE_HOST ?? "127.0.0.1",
  fs: {
    allow: [siteRoot, designRoot, ...fontRoots],
  },
}
```

Do not allow the whole repo root just to make shared tokens work. The first narrow attempt may break local font loading because `@fontsource` CSS refers to package-local font files; add the resolved font package roots rather than widening back to the repository root.

Interactive marketing demos should be progressive enhancement only. If a demo mutates selected text, accept only simple selections that are inside the demo surface, within one block, and backed by one text node. Escape selected text before inserting generated cards.

## Why This Matters

This preserves the product boundary. The website can market and demonstrate Interleave without becoming a PWA, touching local data, or weakening the Electron IPC/security model.

It also prevents design drift in the right direction. Shared tokens and icon semantics keep the site visually aligned with the app, while a separate static package avoids prematurely extracting renderer components into a shared UI library before their contracts are stable.

The Vite boundary matters because static-site convenience can otherwise expose unrelated repository files during local development. The demo boundary matters because marketing-page interactions often get less scrutiny, yet they still handle arbitrary selected text and DOM mutation.

## When to Apply

- Adding a public website, docs site, demo page, or Cloudflare Pages target inside the monorepo.
- The page should look like Interleave but must not behave like the Electron desktop app.
- The site needs shared design tokens, local fonts, Lucide icon semantics, or a small interactive product demo.
- The site is browser-only and should not expose SQLite, filesystem, preload bridge, or app-data assumptions.

## Examples

Use contract tests to lock the public-surface boundaries:

- `homepage-contract.test.ts` asserts all download affordances go to GitHub Releases and no direct installer links appear.
- The same contract test blocks `window.appApi`, `nodeIntegration`, `db.query`, `better-sqlite3`, `fs.readFile`, theme toggles, quarantine copy, and other desktop/prototype affordances.
- `vite.config.test.ts` asserts `server.fs.allow` stays limited and does not include the repo root.
- `styles.test.ts` asserts local `@fontsource` imports and canonical token imports, with no Google Fonts.
- `icons.test.ts` verifies every `data-icon` in the static page resolves and unused icons do not linger.
- `site.test.ts` covers escaped extract-card HTML, outside-reader selections, cross-paragraph selections, and scroll/resize toolbar updates.

The pattern is also worth browser-smoke testing after config changes:

```txt
desktop: no console errors, no horizontal overflow, all icons painted
mobile: no horizontal overflow, all icons painted
demo: selecting reader text and clicking Extract adds one card and one mark
```

## Related

- [Open managed backup folders with pathless IPC](./pathless-backups-open-folder-ipc.md) - related boundary pattern for avoiding broad filesystem capabilities.
- [Run automatic rolling backups in Electron main, not the renderer](./electron-main-rolling-backups-over-renderer-reminders.md) - related rule for keeping local durability work out of browser surfaces.
- [URL-imported articles inbox processing](../ui-bugs/url-imported-articles-inbox-processing.md) - related browser-surface boundary for capture flows.
- [Compact card quality check disclosure](../design-patterns/compact-card-quality-check-disclosure.md) - related design-system reuse guidance for dense UI surfaces.
- [Battle-testing matrix and test-hardening execution for core app surfaces](./test-audit-driven-battle-testing.md) - related testing guidance for high-risk boundaries and styling drift.
