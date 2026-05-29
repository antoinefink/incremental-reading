/**
 * App entry (T003).
 *
 * Loads the global stylesheet (tokens + Tailwind), applies the persisted theme
 * to <html> before first paint, and mounts the typed TanStack Router.
 *
 * Keep the structure thin: composition lives in `router.tsx`, theme handling in
 * `theme.ts`. No domain logic here.
 */
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import "./styles.css";
import { applyTheme, getStoredTheme } from "./theme";

// Reconcile <html data-theme> with the persisted preference before mount so the
// first paint is already on the correct theme (no flash).
applyTheme(getStoredTheme());

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
