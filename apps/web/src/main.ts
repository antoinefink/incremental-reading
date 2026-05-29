/**
 * Placeholder app entry for T002.
 *
 * Renders a single identifiable element so the Docker `app` service is verifiably
 * serving a page and the smoke E2E (T002) has a stable target to assert against.
 * The real React 19 + TanStack Router shell replaces this in T003 — keep the
 * `data-testid` stable so the smoke test survives that swap.
 */
import { webPlaceholder } from "./index";

const root = document.querySelector<HTMLDivElement>("#root");

if (root) {
  const heading = document.createElement("h1");
  heading.dataset.testid = "app-shell";
  heading.textContent = "Interleave";

  const status = document.createElement("p");
  status.dataset.testid = "app-boot";
  status.textContent = webPlaceholder();

  root.append(heading, status);
}
