import { describe, expect, it } from "vitest";
import { CodeBlockNodeView } from "./CodeBlockNodeView";
import { MathNodeView } from "./MathNodeView";
import * as nodeViews from "./react-node-views";

describe("react-node-views barrel", () => {
  it("exports the React node views SourceEditor wires into the schema", () => {
    expect(nodeViews.CodeBlockNodeView).toBe(CodeBlockNodeView);
    expect(nodeViews.MathNodeView).toBe(MathNodeView);
  });
});
