import fs from "node:fs";
import { describe, expect, it } from "vitest";

const setupSource = fs.readFileSync("apps/web/vitest.setup.ts", "utf8");

describe("web Vitest setup", () => {
  it("registers Testing Library matchers and test isolation cleanup", () => {
    expect(setupSource).toContain("@testing-library/jest-dom/vitest");
    expect(setupSource).toContain("cleanup()");
    expect(setupSource).toContain("vi.restoreAllMocks()");
  });
});
