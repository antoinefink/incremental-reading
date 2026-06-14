import { describe, expect, it } from "vitest";
import { type CardEditBody, type CardEditClass, classifyCardEdit } from "./card-edit-classifier";
import type { CardKind } from "./enums";

interface Case {
  readonly name: string;
  readonly kind: CardKind;
  readonly before: CardEditBody;
  readonly after: CardEditBody;
  readonly expected: CardEditClass;
}

const qa = (prompt: string, answer: string): CardEditBody => ({ prompt, answer, cloze: null });
const cloze = (text: string): CardEditBody => ({ prompt: null, answer: null, cloze: text });

const cases: readonly Case[] = [
  // ---- Q&A: only the answer-bearing side matters ----
  {
    name: "qa identical body → typo",
    kind: "qa",
    before: qa("Capital of France?", "Paris"),
    after: qa("Capital of France?", "Paris"),
    expected: "typo",
  },
  {
    name: "qa whitespace/case-only answer change → typo",
    kind: "qa",
    before: qa("Capital of France?", "Paris"),
    after: qa("Capital of France?", "  paris "),
    expected: "typo",
  },
  {
    name: "qa prompt reworded, answer identical → typo",
    kind: "qa",
    before: qa("Capital of France?", "Paris"),
    after: qa("What is the capital city of France?", "Paris"),
    expected: "typo",
  },
  {
    name: "qa single-character answer typo fix → typo (below min distance)",
    kind: "qa",
    before: qa("Capital of France?", "Pariss"),
    after: qa("Capital of France?", "Paris"),
    expected: "typo",
  },
  {
    name: "qa added trailing punctuation → typo",
    kind: "qa",
    before: qa("Define osmosis", "Movement of water across a membrane"),
    after: qa("Define osmosis", "Movement of water across a membrane."),
    expected: "typo",
  },
  {
    name: "qa answer replaced entirely → substantive",
    kind: "qa",
    before: qa("Capital of Australia?", "Sydney"),
    after: qa("Capital of Australia?", "Canberra"),
    expected: "substantive",
  },
  {
    name: "qa answer materially reworded → substantive",
    kind: "qa",
    before: qa("What does TCP guarantee?", "ordered delivery"),
    after: qa("What does TCP guarantee?", "reliable, in-order byte stream"),
    expected: "substantive",
  },
  {
    name: "qa one-word fix in a long answer → typo (below ratio)",
    kind: "qa",
    before: qa("Mitochondria role?", "the powerhouse of the cells producing ATP energy"),
    after: qa("Mitochondria role?", "the powerhouse of the cell producing ATP energy"),
    expected: "typo",
  },
  // ---- Cloze: only the deletion answers matter ----
  {
    name: "cloze surrounding context edited, deletions unchanged → typo",
    kind: "cloze",
    before: cloze("The mitochondria is the {{c1::powerhouse}} of the cell"),
    after: cloze("In biology, the mitochondria is the {{c1::powerhouse}} of every cell"),
    expected: "typo",
  },
  {
    name: "cloze deletion answer changed → substantive",
    kind: "cloze",
    before: cloze("The capital of Australia is {{c1::Sydney}}"),
    after: cloze("The capital of Australia is {{c1::Canberra}}"),
    expected: "substantive",
  },
  {
    name: "cloze deletion added → substantive",
    kind: "cloze",
    before: cloze("Water is made of {{c1::hydrogen}} and oxygen"),
    after: cloze("Water is made of {{c1::hydrogen}} and {{c2::oxygen}}"),
    expected: "substantive",
  },
  {
    name: "cloze deletion removed → substantive",
    kind: "cloze",
    before: cloze("Water is made of {{c1::hydrogen}} and {{c2::oxygen}}"),
    after: cloze("Water is made of {{c1::hydrogen}} and oxygen"),
    expected: "substantive",
  },
  {
    name: "cloze deletion reordering is not a change → typo",
    kind: "cloze",
    before: cloze("{{c1::alpha}} then {{c2::beta}}"),
    after: cloze("{{c2::beta}} comes after {{c1::alpha}}"),
    expected: "typo",
  },
  {
    name: "cloze case-only deletion change → typo",
    kind: "cloze",
    before: cloze("DNA carries {{c1::Genetic}} information"),
    after: cloze("DNA carries {{c1::genetic}} information"),
    expected: "typo",
  },
];

describe("classifyCardEdit", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(classifyCardEdit(c.kind, c.before, c.after).editClass).toBe(c.expected);
    });
  }

  it("reports answerChanged + distance audit signals", () => {
    const same = classifyCardEdit("qa", qa("p", "Paris"), qa("p", "Paris"));
    expect(same.answerChanged).toBe(false);
    expect(same.editDistance).toBe(0);
    expect(same.normalizedDistance).toBe(0);

    const changed = classifyCardEdit("qa", qa("p", "Sydney"), qa("p", "Canberra"));
    expect(changed.answerChanged).toBe(true);
    expect(changed.editDistance).toBeGreaterThan(0);
    expect(changed.normalizedDistance).toBeGreaterThan(0);
  });

  it("handles empty before/after answers without throwing", () => {
    expect(() => classifyCardEdit("qa", qa("p", ""), qa("p", "Paris"))).not.toThrow();
    // empty → non-empty answer of meaningful length is substantive
    expect(classifyCardEdit("qa", qa("p", ""), qa("p", "Canberra")).editClass).toBe("substantive");
    // both empty answer-bearing sides → typo (nothing changed)
    expect(classifyCardEdit("cloze", cloze("no markers here"), cloze("still none")).editClass).toBe(
      "typo",
    );
  });

  it("threshold edges: just below vs just above the ratio", () => {
    // 8-char answer, change 2 chars (25% < 34%, also under min distance) → typo
    expect(classifyCardEdit("qa", qa("p", "abcdefgh"), qa("p", "abXdefgY")).editClass).toBe("typo");
    // 6-char answer fully replaced (100% >= ratio, >= min distance) → substantive
    expect(classifyCardEdit("qa", qa("p", "abcdef"), qa("p", "ZYXWVU")).editClass).toBe(
      "substantive",
    );
  });
});
