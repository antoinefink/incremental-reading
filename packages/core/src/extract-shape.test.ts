import { describe, expect, it } from "vitest";
import {
  classifyExtractShape,
  EXTRACT_SHAPE_HEURISTIC_VERSION,
  type ExtractShapeInput,
} from "./index";

function shape(overrides: Partial<ExtractShapeInput>): ExtractShapeInput {
  return {
    normalizedText: "The hippocampus supports memory consolidation.",
    paragraphCount: 1,
    blockCount: 1,
    blockTypes: ["paragraph"],
    hasList: false,
    hasCode: false,
    hasMath: false,
    hasMedia: false,
    rich: true,
    fallback: false,
    reconstructionFailed: false,
    ...overrides,
  };
}

describe("classifyExtractShape", () => {
  it("classifies a self-contained definition as atomic-ready", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "A schema is a reusable mental structure for organizing knowledge.",
      }),
    );

    expect(result.heuristicVersion).toBe(EXTRACT_SHAPE_HEURISTIC_VERSION);
    expect(result.classification).toBe("atomic_ready");
    expect(result.stage).toBe("atomic_statement");
    expect(result.reasonCodes).toEqual(["single_atomic_statement"]);
    expect(result.inputSignals).toMatchObject({
      hasList: false,
      hasCode: false,
      hasMath: false,
      hasMedia: false,
      rich: true,
      fallback: false,
      reconstructionFailed: false,
    });
    expect(result.stats).toMatchObject({
      normalizedCharCount: 65,
      wordCount: 10,
      sentenceCount: 1,
      paragraphCount: 1,
      blockCount: 1,
      blockTypes: ["paragraph"],
    });
  });

  it("classifies a single factual statement as atomic-ready", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "Photosynthesis converts light energy into chemical energy.",
      }),
    );

    expect(result.classification).toBe("atomic_ready");
    expect(result.stage).toBe("atomic_statement");
    expect(result.reasonCodes).toEqual(["single_atomic_statement"]);
  });

  it("classifies a simple self-contained formula as atomic-ready despite low word count", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "E = mc^2",
        hasMath: true,
      }),
    );

    expect(result.classification).toBe("atomic_ready");
    expect(result.stage).toBe("atomic_statement");
    expect(result.reasonCodes).toEqual(["simple_formula"]);
    expect(result.stats.wordCount).toBeLessThan(4);
  });

  it("classifies math-node plain text with delimiters as a simple formula", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "$$E = mc^2$$",
        hasMath: true,
      }),
    );

    expect(result.classification).toBe("atomic_ready");
    expect(result.stage).toBe("atomic_statement");
    expect(result.reasonCodes).toEqual(["simple_formula"]);
    expect(result.inputSignals.hasMath).toBe(true);
  });

  it("does not split a single statement on common abbreviations", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "Dr. Smith defines retrieval practice as active recall.",
      }),
    );

    expect(result.classification).toBe("atomic_ready");
    expect(result.stage).toBe("atomic_statement");
    expect(result.stats.sentenceCount).toBe(1);
  });

  it("produces a deterministic normalized-input hash from structured shape inputs", () => {
    const first = classifyExtractShape(
      shape({
        normalizedText: "  Photosynthesis   converts light energy into chemical energy.  ",
      }),
    );
    const second = classifyExtractShape(
      shape({
        normalizedText: "Photosynthesis converts light energy into chemical energy.",
      }),
    );
    const differentShape = classifyExtractShape(
      shape({
        normalizedText: "Photosynthesis converts light energy into chemical energy.",
        fallback: true,
      }),
    );

    expect(first.normalizedInputHash).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(first.normalizedInputHash).toBe(second.normalizedInputHash);
    expect(first.normalizedInputHash).not.toBe(differentShape.normalizedInputHash);
  });

  it("keeps multi-sentence prose as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText:
          "Deep sleep supports memory consolidation. It also improves next-day recall.",
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("multiple_sentences");
  });

  it("keeps list-shaped extracts as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "Encoding\nStorage\nRetrieval",
        paragraphCount: 3,
        blockCount: 3,
        blockTypes: ["listItem", "listItem", "listItem"],
        hasList: true,
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("list_block");
    expect(result.inputSignals.hasList).toBe(true);
  });

  it("keeps code extracts as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "const answer = 42;",
        blockTypes: ["codeBlock"],
        hasCode: true,
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("code_block");
    expect(result.inputSignals.hasCode).toBe(true);
  });

  it("keeps media-backed extracts as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "Figure 2 shows the pipeline.",
        blockTypes: ["image"],
        hasMedia: true,
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("media_block");
    expect(result.inputSignals.hasMedia).toBe(true);
  });

  it("keeps rich reconstruction failures as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "The hippocampus supports memory consolidation.",
        rich: true,
        fallback: true,
        reconstructionFailed: true,
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("fallback_used");
    expect(result.reasonCodes).toContain("reconstruction_failed");
    expect(result.inputSignals).toMatchObject({
      rich: true,
      fallback: true,
      reconstructionFailed: true,
    });
  });

  it("keeps title fragments as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "Attention and Memory",
        blockTypes: ["heading"],
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("title_or_heading");
    expect(result.reasonCodes).toContain("fragment");
  });

  it("keeps dangling-pronoun statements as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "It increases memory consolidation.",
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("dangling_pronoun");
  });

  it("keeps malformed formulas as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "E =",
        hasMath: true,
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("malformed_formula");
  });

  it("keeps contextless formulas as raw extract", () => {
    const result = classifyExtractShape(
      shape({
        normalizedText: "x = y",
        hasMath: true,
      }),
    );

    expect(result.classification).toBe("not_atomic_ready");
    expect(result.stage).toBe("raw_extract");
    expect(result.reasonCodes).toContain("contextless_formula");
  });
});
