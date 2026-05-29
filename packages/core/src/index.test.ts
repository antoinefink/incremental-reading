import { describe, expect, it } from "vitest";
import { CORE_PACKAGE, corePlaceholder } from "./index";

/**
 * Sample unit test (T002) — proves the Vitest toolchain runs against a workspace
 * package. Real domain tests (priority↔label conversion, review-state
 * transitions, etc.) land with T005+. Keep at least one passing test here so the
 * `make test` gate always has something to execute.
 */
describe("@interleave/core placeholder", () => {
  it("exposes the package name constant", () => {
    expect(CORE_PACKAGE).toBe("@interleave/core");
  });

  it("returns the package name from the placeholder helper", () => {
    expect(corePlaceholder()).toBe("@interleave/core");
  });
});
