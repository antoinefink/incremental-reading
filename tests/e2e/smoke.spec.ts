import { expect, test } from "@playwright/test";

/**
 * Smoke E2E (T002, extended in T003).
 *
 * Verifies the real React + TanStack Router app boots and is navigable. This is
 * the gate the Definition of Done refers to: if the app fails to boot, a route
 * fails to load, or in-app navigation breaks, `make e2e` (and CI) fails.
 */
test("app boots and the home route renders", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/Interleave/);
  await expect(page.getByTestId("route-home")).toBeVisible();
});

test("navigates between routes via the sidebar", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("route-home")).toBeVisible();

  // Click into the queue, then into review — two in-app navigations.
  await page.getByTestId("nav-queue").click();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByTestId("route-queue")).toBeVisible();

  await page.getByTestId("nav-review").click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId("route-review")).toBeVisible();
});

test("all seven routes load by URL", async ({ page }) => {
  const routes: ReadonlyArray<[string, string]> = [
    ["/", "route-home"],
    ["/inbox", "route-inbox"],
    ["/queue", "route-queue"],
    ["/source/demo-1", "route-source"],
    ["/review", "route-review"],
    ["/search", "route-search"],
    ["/settings", "route-settings"],
  ];

  for (const [url, testId] of routes) {
    await page.goto(url);
    await expect(page.getByTestId(testId)).toBeVisible();
  }
});

test("theme toggle flips the data-theme attribute", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");

  await page.getByTestId("theme-toggle").click();

  const after = await html.getAttribute("data-theme");
  expect(after).not.toBe(before);
  expect(["light", "dark"]).toContain(after);
});
