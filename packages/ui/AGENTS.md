# AGENTS.md

`packages/ui` contains shared renderer components only. Keep domain logic, SQL, scheduling rules,
extraction transforms, and filesystem access out of UI components.

Follow the design system:

- use tokens from `design/tokens.css`
- use `lucide-react` icons according to `design/icon-map.md`
- keep the desktop workspace dense, calm, keyboard-first, and minimal
- do not hard-code colors that should be design tokens

UI may display Element status, stage, priority, lineage, scheduler state, and operation outcomes,
but mutations must go through typed client/app APIs.

Preserve the FSRS vs attention distinction in labels and components. Cards show recall/review
state; sources, topics, extracts, tasks, and synthesis work show processing attention state.

Component tests should cover important states, keyboard behavior, disabled/loading/error states,
and token-based variants.
