/**
 * Cloze parse/serialize/render tests (T034).
 *
 * Cover the structured-metadata contract the M6 spec requires:
 *  - a single cloze parses to one deletion with `clozeCount = 1`;
 *  - multiple distinct clozes (`c1` + `c2`) parse to `clozeCount = 2`, ordered;
 *  - grouped clozes (`c1` repeated) count as ONE distinct index but two deletions;
 *  - bare `{{answer}}` markers auto-number to canonical `{{c1::…}}` form;
 *  - parse → serialize round-trips to canonical numbered text;
 *  - malformed/empty markers are dropped (no phantom deletions);
 *  - `renderClozePrompt` yields `[ … ]` hidden spans + reveals answers.
 */

import { describe, expect, it } from "vitest";
import {
  CLOZE_PLACEHOLDER,
  canonicalizeCloze,
  hasClozeMarker,
  parseCloze,
  renderClozePrompt,
  serializeCloze,
} from "./cloze";

describe("parseCloze", () => {
  it("parses a single numbered cloze", () => {
    const model = parseCloze("Intelligence is {{c1::skill-acquisition efficiency}}.");
    expect(model.clozeCount).toBe(1);
    expect(model.deletions).toHaveLength(1);
    expect(model.deletions[0]).toMatchObject({
      index: 1,
      answer: "skill-acquisition efficiency",
    });
    // Offsets point into the RENDERED prompt ("Intelligence is skill-acquisition efficiency.").
    const d = model.deletions[0];
    if (!d) throw new Error("expected a deletion");
    expect("Intelligence is skill-acquisition efficiency.".slice(d.start, d.end)).toBe(
      "skill-acquisition efficiency",
    );
  });

  it("parses multiple distinct clozes with clozeCount = 2", () => {
    const model = parseCloze("Memory moves from the {{c1::hippocampus}} to the {{c2::neocortex}}.");
    expect(model.clozeCount).toBe(2);
    expect(model.deletions.map((d) => d.index)).toEqual([1, 2]);
    expect(model.deletions.map((d) => d.answer)).toEqual(["hippocampus", "neocortex"]);
  });

  it("treats grouped clozes (repeated c1) as ONE distinct index but two deletions", () => {
    const model = parseCloze("Both {{c1::cats}} and {{c1::dogs}} are mammals.");
    expect(model.clozeCount).toBe(1);
    expect(model.deletions).toHaveLength(2);
    expect(model.deletions.every((d) => d.index === 1)).toBe(true);
  });

  it("auto-numbers bare {{answer}} markers left-to-right", () => {
    const model = parseCloze("From the {{hippocampus}} to the {{neocortex}}.");
    expect(model.clozeCount).toBe(2);
    expect(model.raw).toBe("From the {{c1::hippocampus}} to the {{c2::neocortex}}.");
  });

  it("fills bare markers into indices above any explicit number", () => {
    const model = parseCloze("{{c2::two}} and {{one}}");
    // The bare marker must not collide with the explicit c2 → it becomes c3.
    expect(model.raw).toBe("{{c2::two}} and {{c3::one}}");
    expect(model.clozeCount).toBe(2);
  });

  it("numbers a bare marker that PRECEDES a numbered one above the explicit index", () => {
    // Documented, deliberate ordering caveat: explicit numbers win, so a bare
    // marker before `c1` takes the next index above maxSeen (c2) rather than c1 —
    // the visually-first deletion gets the HIGHER number. Pin it so the behavior
    // is intentional, not accidental, and round-trips cleanly.
    const model = parseCloze("{{a}} {{c1::b}}");
    expect(model.raw).toBe("{{c2::a}} {{c1::b}}");
    expect(model.clozeCount).toBe(2);
    expect(model.deletions.map((d) => d.index)).toEqual([2, 1]);
    // Round-trips to the same canonical text (idempotent re-parse).
    expect(canonicalizeCloze(model.raw)).toBe("{{c2::a}} {{c1::b}}");
  });

  it("leaves gaps below maxSeen unused when a bare marker precedes a high explicit index", () => {
    // `{{a}}` before `c5` becomes c6 (above maxSeen=5), leaving c1..c4 free —
    // surprising but intentional and consistent; numbering explicitly is the fix
    // when ordering matters.
    const model = parseCloze("{{a}} {{c5::b}}");
    expect(model.raw).toBe("{{c6::a}} {{c5::b}}");
    expect(model.deletions.map((d) => d.index)).toEqual([6, 5]);
  });

  it("drops malformed / empty markers", () => {
    const model = parseCloze("Empty {{}} and blank {{   }} and ok {{c1::real}}.");
    expect(model.clozeCount).toBe(1);
    expect(model.deletions).toHaveLength(1);
    expect(model.deletions[0]?.answer).toBe("real");
  });

  it("returns no deletions for plain text", () => {
    const model = parseCloze("Just a sentence with no clozes.");
    expect(model.clozeCount).toBe(0);
    expect(model.deletions).toHaveLength(0);
    expect(model.raw).toBe("Just a sentence with no clozes.");
  });
});

describe("serializeCloze / canonicalizeCloze", () => {
  it("round-trips canonical numbered text", () => {
    const raw = "Memory moves from the {{c1::hippocampus}} to the {{c2::neocortex}}.";
    expect(serializeCloze(parseCloze(raw))).toBe(raw);
    expect(canonicalizeCloze(raw)).toBe(raw);
  });

  it("normalizes bare markers and whitespace to canonical form", () => {
    expect(canonicalizeCloze("the {{ hippocampus }}")).toBe("the {{c1::hippocampus}}");
  });
});

describe("hasClozeMarker", () => {
  it("detects numbered and bare markers, not plain text", () => {
    expect(hasClozeMarker("a {{c1::b}} c")).toBe(true);
    expect(hasClozeMarker("a {{b}} c")).toBe(true);
    expect(hasClozeMarker("no markers here")).toBe(false);
  });
});

describe("renderClozePrompt", () => {
  it("hides deletions as the placeholder by default", () => {
    const spans = renderClozePrompt("A {{c1::x}} and {{c2::y}}.");
    const deletions = spans.filter((s) => s.kind === "deletion");
    expect(deletions).toHaveLength(2);
    expect(deletions.every((s) => s.content === CLOZE_PLACEHOLDER && !s.revealed)).toBe(true);
    // The literal text is preserved around the deletions.
    expect(spans.map((s) => s.content).join("")).toBe(
      `A ${CLOZE_PLACEHOLDER} and ${CLOZE_PLACEHOLDER}.`,
    );
  });

  it("reveals all deletions when revealAll is set", () => {
    const spans = renderClozePrompt("A {{c1::x}} and {{c2::y}}.", { revealAll: true });
    expect(spans.map((s) => s.content).join("")).toBe("A x and y.");
    expect(spans.filter((s) => s.kind === "deletion").every((s) => s.revealed)).toBe(true);
  });

  it("reveals only the requested index", () => {
    const spans = renderClozePrompt("A {{c1::x}} and {{c2::y}}.", { revealIndex: 1 });
    const c1 = spans.find((s) => s.index === 1);
    const c2 = spans.find((s) => s.index === 2);
    expect(c1?.content).toBe("x");
    expect(c2?.content).toBe(CLOZE_PLACEHOLDER);
  });

  it("renders a malformed marker as literal text", () => {
    const spans = renderClozePrompt("ok {{}} done");
    expect(spans.every((s) => s.kind === "text")).toBe(true);
    expect(spans.map((s) => s.content).join("")).toBe("ok {{}} done");
  });
});
