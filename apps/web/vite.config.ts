import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for the React 19 app (T003).
 *
 * - `@vitejs/plugin-react` → React 19 + Fast Refresh + the automatic JSX runtime.
 * - `@tailwindcss/vite` → Tailwind v4 (the @theme is derived from the design
 *   tokens in src/styles.css; no PostCSS config needed).
 * - `server.fs.allow` is widened to the monorepo root so src/styles.css can
 *   `@import "../../../design/tokens.css"` (the canonical, shared token file
 *   lives outside this app's root).
 *
 * Host/port are fixed so the Docker `app` service can expose the server and
 * Playwright can reach it deterministically.
 */
const repoRoot = resolve(import.meta.dirname, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    fs: {
      // Allow importing the shared design tokens from the repo root.
      allow: [repoRoot],
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
});
