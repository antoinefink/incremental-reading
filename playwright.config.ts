import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config (T002, extended for Electron in T007).
 *
 * Two projects:
 *  - `chromium` — the renderer smoke E2E (T002–T004): loads the Vite dev server
 *    and asserts the app shell + keyboard chrome. Playwright starts the dev
 *    server itself via `webServer` (or reuses an external one via `E2E_BASE_URL`).
 *  - `electron` — the desktop E2E (T007): launches the real Electron app via
 *    `_electron.launch`, asserts the secure window flags + the `window.appApi`
 *    bridge, and proves a value written through the API survives an app restart.
 *    It loads the BUILT renderer + main bundle (no dev server), so it does not
 *    use `webServer`.
 *
 * Run a single project with `pnpm e2e --project=electron` (or `=chromium`).
 */
const externalBaseURL = process.env.E2E_BASE_URL;
const baseURL = externalBaseURL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      testDir: "./tests/e2e",
      use: { ...devices["Desktop Chrome"], baseURL },
    },
    {
      name: "electron",
      testDir: "./tests/electron",
    },
  ],
  // The dev server is only needed by the chromium smoke project. When pointed at
  // an external server (compose/CI) we do not spawn our own.
  webServer: externalBaseURL
    ? undefined
    : {
        command: "pnpm --filter @interleave/web dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
