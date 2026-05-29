/// <reference types="vitest/globals" />

/**
 * Make `@testing-library/jest-dom`'s custom matchers (e.g. `toBeInTheDocument`)
 * visible to `tsc` in the renderer's component tests. The matchers are registered
 * at runtime in `vitest.setup.ts` (`import "@testing-library/jest-dom/vitest"`);
 * this ambient import pulls in their type augmentation of Vitest's `expect` so the
 * test files typecheck. Types-only — no runtime effect.
 */
import "@testing-library/jest-dom/vitest";
