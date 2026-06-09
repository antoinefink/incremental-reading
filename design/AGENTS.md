# AGENTS.md

This directory is Interleave's visual source of truth. UI work should match the design kit's
output while rebuilding components in the real app stack.

## Required Context For UI Work

1. Read `design/README.md`.
2. Read `docs/design-system.md`.
3. Use `design/tokens.css` as the canonical token source.
4. Use `design/icon-map.md` for prototype icon names and `lucide-react` mappings.
5. For a screen, inspect the matching `design/kit/app/screen-*.jsx` and
   `design/kit/screenshots/*.png`.

## Hard Rules

- `design/kit/` is immutable reference material. Do not edit it.
- Do not ship the prototype's Babel-in-browser structure.
- Recreate the visual output in React + TypeScript + Vite + Tailwind v4.
- Derive Tailwind theme values from CSS variables instead of hard-coding colors, spacing, radii,
  typography, scheduler colors, priority colors, or element-type colors.
- Use `lucide-react` icons via `icon-map.md`.
- Preserve the scheduler distinction: FSRS cards use the memory treatment; attention-scheduled
  sources, topics, extracts, tasks, and synthesis work use the processing treatment.
- Preserve actionable lineage UI patterns such as source references and `LineageTree`.

## Verification

For UI-bearing implementation work, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant
`pnpm e2e` coverage from the repo root.
