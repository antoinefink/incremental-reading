import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for the renderer (`apps/web`).
 *
 * Picked up by the root `vitest.config.ts` `projects: ["apps/*"]` glob. Most
 * renderer tests are pure logic (nav/icon config) and run in Node, but the
 * component tests (e.g. the T019 selection toolbar) render React, so this project
 * uses the **jsdom** environment + Testing Library, loaded via `setupFiles`.
 *
 * `@vitejs/plugin-react` is included so the JSX/TSX test files transform exactly
 * like the app build. Kept separate from `vite.config.ts` (the app/dev server
 * config) so the test environment never leaks into the production bundle.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "vite.config.test.ts",
      "vitest.config.test.ts",
      "vitest.setup.test.ts",
    ],
  },
});
