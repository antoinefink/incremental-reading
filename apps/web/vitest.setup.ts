/**
 * Vitest setup for the renderer's jsdom component tests.
 *
 * Registers `@testing-library/jest-dom`'s custom matchers (`toBeInTheDocument`,
 * etc.) and tears down the rendered tree + restores mocks after each test so
 * component tests stay isolated.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
