import { describe, expect, it } from "vitest";
import { UI_PACKAGE, uiPlaceholder } from "./index";

describe("@interleave/ui placeholder exports", () => {
  it("keeps the package marker stable until shared primitives land", () => {
    expect(UI_PACKAGE).toBe("@interleave/ui");
    expect(uiPlaceholder()).toBe(UI_PACKAGE);
  });
});
