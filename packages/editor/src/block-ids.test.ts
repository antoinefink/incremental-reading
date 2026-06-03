import { describe, expect, it } from "vitest";
import { newBlockId } from "./block-ids";

const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

describe("newBlockId", () => {
  it("mints Crockford-base32 ULID-shaped stable block IDs", () => {
    const id = newBlockId();
    expect(id).toMatch(ULID_RE);
  });

  it("mints distinct IDs across calls", () => {
    const ids = new Set(Array.from({ length: 32 }, () => newBlockId()));
    expect(ids.size).toBe(32);
  });
});
