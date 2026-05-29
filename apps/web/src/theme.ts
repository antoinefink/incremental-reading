/**
 * Theme controller (T003).
 *
 * Light/dark is driven by the `data-theme` attribute on <html> (the strategy the
 * design tokens use — see design/tokens.css `[data-theme="dark"]`). This module
 * is the single place that reads/writes that attribute and persists the choice,
 * so the app never sprinkles `document.documentElement` access through views.
 *
 * Pure UI concern — no domain logic. The persisted user-setting version arrives
 * with T011 (local settings); until then this is a lightweight localStorage pref.
 */
export type Theme = "light" | "dark";

const STORAGE_KEY = "interleave.theme";

/** Read the persisted theme, falling back to the attribute already on <html>. */
export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may be unavailable (private mode, sandboxed iframe) — ignore.
  }
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" ? "light" : "dark";
}

/** Apply a theme to <html> and persist it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; the in-memory attribute still drives the UI.
  }
}

/** Flip the current theme and return the new value. */
export function toggleTheme(): Theme {
  const next: Theme = getStoredTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
