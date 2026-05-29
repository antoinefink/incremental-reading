import { defineConfig } from "vite";

/**
 * Minimal Vite config for T002.
 *
 * This stands up only a placeholder dev server so the Docker `app` service can
 * run and the smoke E2E can load a page. The real React 19 + TanStack Router app
 * is scaffolded in T003, which will extend this config (plugins, aliases, theme).
 *
 * Host/port are fixed so the container can expose the server and Playwright can
 * reach it deterministically.
 */
export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
});
