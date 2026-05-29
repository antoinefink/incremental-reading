import { expect, test } from "@playwright/test";

/**
 * Smoke E2E (T002) — verifies the app shell actually loads in a real browser.
 *
 * This is the gate the Definition of Done refers to: if the placeholder page
 * fails to boot or the stable test hook disappears, `make e2e` (and CI) fails.
 * T003 extends this to navigate between routes once the router exists.
 */
test("app shell loads", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/Interleave/);
  await expect(page.getByTestId("app-shell")).toHaveText("Interleave");
});
