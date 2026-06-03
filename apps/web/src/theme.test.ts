import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, getStoredTheme, toggleTheme } from "./theme";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("theme controller", () => {
  it("prefers a persisted light/dark theme over the html attribute", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("interleave.theme", "light");

    expect(getStoredTheme()).toBe("light");
  });

  it("falls back to the html attribute, defaulting to dark", () => {
    document.documentElement.setAttribute("data-theme", "light");
    expect(getStoredTheme()).toBe("light");

    document.documentElement.removeAttribute("data-theme");
    expect(getStoredTheme()).toBe("dark");
  });

  it("applies and persists a theme", () => {
    applyTheme("dark");

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("interleave.theme")).toBe("dark");
  });

  it("toggles the current theme and returns the new value", () => {
    applyTheme("dark");

    expect(toggleTheme()).toBe("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
