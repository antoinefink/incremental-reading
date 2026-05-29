import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config (T002) — drives the smoke E2E that loads the app shell.
 *
 * By default Playwright starts the Vite dev server itself (`webServer`) and waits
 * for it before running specs, so `make e2e` is one command. When `E2E_BASE_URL`
 * is set (e.g. the compose `e2e` service pointing at the `app` service), the
 * external server is reused instead of spawning a new one.
 *
 * The real cross-route navigation E2E arrives with T003; here we only assert the
 * placeholder page renders.
 */
const externalBaseURL = process.env.E2E_BASE_URL;
const baseURL = externalBaseURL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // When pointed at an external server (compose/CI), do not spawn our own.
  webServer: externalBaseURL
    ? undefined
    : {
        command: "pnpm --filter @interleave/web dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
