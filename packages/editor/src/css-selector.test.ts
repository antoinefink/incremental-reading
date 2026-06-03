import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOCK_ID_DOM_ATTR } from "./block-id";
import { buildBlockSelector, cssEscape } from "./css-selector";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("css selector helpers", () => {
  it("uses CSS.escape when the platform provides it", () => {
    const cssEscapeMock = vi.fn((value: string) => `escaped(${value})`);
    vi.stubGlobal("CSS", { escape: cssEscapeMock });

    expect(cssEscape("a b")).toBe("escaped(a b)");
    expect(cssEscapeMock).toHaveBeenCalledWith("a b");
  });

  it("falls back to escaping quotes and backslashes", () => {
    vi.stubGlobal("CSS", undefined);

    expect(cssEscape('block"with\\slashes')).toBe('block\\"with\\\\slashes');
  });

  it("builds the stable block-id attribute selector", () => {
    vi.stubGlobal("CSS", undefined);

    expect(buildBlockSelector('block"1')).toBe(`[${BLOCK_ID_DOM_ATTR}="block\\"1"]`);
  });
});
