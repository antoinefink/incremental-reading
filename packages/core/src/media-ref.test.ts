/**
 * MediaRef (T075) — the audio-card presentation carrier validator.
 */

import { describe, expect, it } from "vitest";
import { isMediaRefFace, MEDIA_REF_FACES, parseMediaRef } from "./media-ref";

describe("MEDIA_REF_FACES / isMediaRefFace", () => {
  it("is the closed set prompt/answer/both", () => {
    expect(MEDIA_REF_FACES).toEqual(["prompt", "answer", "both"]);
  });

  it("accepts each face value and rejects others", () => {
    expect(isMediaRefFace("prompt")).toBe(true);
    expect(isMediaRefFace("answer")).toBe(true);
    expect(isMediaRefFace("both")).toBe(true);
    expect(isMediaRefFace("front")).toBe(false);
    expect(isMediaRefFace(null)).toBe(false);
    expect(isMediaRefFace(2)).toBe(false);
  });
});

describe("parseMediaRef", () => {
  const valid = { sourceElementId: "src-1", startMs: 1000, endMs: 4000, on: "prompt" as const };

  it("parses a valid object", () => {
    expect(parseMediaRef(valid)).toEqual(valid);
  });

  it("parses the raw JSON string form (the stored cell)", () => {
    expect(parseMediaRef(JSON.stringify(valid))).toEqual(valid);
  });

  it("rounds non-integer millis to whole numbers", () => {
    expect(parseMediaRef({ ...valid, startMs: 1000.4, endMs: 3999.9 })).toEqual({
      ...valid,
      startMs: 1000,
      endMs: 4000,
    });
  });

  it("rejects an inverted window (endMs <= startMs)", () => {
    expect(parseMediaRef({ ...valid, startMs: 4000, endMs: 4000 })).toBeNull();
    expect(parseMediaRef({ ...valid, startMs: 5000, endMs: 4000 })).toBeNull();
  });

  it("rejects a negative start", () => {
    expect(parseMediaRef({ ...valid, startMs: -1 })).toBeNull();
  });

  it("rejects a missing/empty source id", () => {
    expect(parseMediaRef({ ...valid, sourceElementId: "" })).toBeNull();
    expect(parseMediaRef({ startMs: 0, endMs: 1, on: "prompt" })).toBeNull();
  });

  it("rejects an unknown face", () => {
    expect(parseMediaRef({ ...valid, on: "front" })).toBeNull();
  });

  it("degrades a malformed/non-object/empty value to null (no throw on read)", () => {
    expect(parseMediaRef(null)).toBeNull();
    expect(parseMediaRef(undefined)).toBeNull();
    expect(parseMediaRef("")).toBeNull();
    expect(parseMediaRef("{not json")).toBeNull();
    expect(parseMediaRef(42)).toBeNull();
  });
});
