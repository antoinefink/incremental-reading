import { describe, expect, it } from "vitest";
import {
  CaptureErrorResponseSchema,
  CaptureKindSchema,
  CapturePageRequestSchema,
  CaptureSelectionRequestSchema,
  DEFAULT_CAPTURE_PRIORITY,
  PriorityLabelSchema,
  shapeCapture,
} from "./index";

describe("capture-contract index exports", () => {
  it("keeps the exported enum surfaces narrow and extension-safe", () => {
    expect(PriorityLabelSchema.options).toEqual(["A", "B", "C", "D"]);
    expect(CaptureKindSchema.options).toEqual(["page", "selection"]);
    expect(DEFAULT_CAPTURE_PRIORITY).toBe("C");
  });

  it("validates exported request and error response schemas", () => {
    expect(
      CapturePageRequestSchema.parse({
        kind: "page",
        url: "https://example.com",
        priority: "D",
      }),
    ).toMatchObject({ kind: "page", priority: "D" });
    expect(
      CaptureSelectionRequestSchema.parse({
        kind: "selection",
        url: "https://example.com",
        selection: "selected",
      }),
    ).toMatchObject({ kind: "selection", selection: "selected" });
    expect(CaptureErrorResponseSchema.parse({ ok: false, error: "bad_token" })).toEqual({
      ok: false,
      error: "bad_token",
    });
  });

  it("shapeCapture clamps page HTML without trimming internal markup whitespace", () => {
    const shaped = shapeCapture({
      kind: "page",
      url: " https://example.com/article ",
      html: ` <main>${"x".repeat(5_000_050)}</main> `,
    });

    expect(shaped.kind).toBe("page");
    if (shaped.kind === "page") {
      expect(shaped.html).toHaveLength(5_000_000);
      expect(shaped.html?.startsWith(" <main>")).toBe(true);
    }
  });
});
