// @vitest-environment jsdom

import { DOMParser, DOMSerializer, Node as PmNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { buildSchema } from "../schema";
import { MATH_DISPLAY_ATTR, MATH_DOM_ATTR, MATH_NODE_NAME } from "./math";

const schema = buildSchema();

describe("MathNode", () => {
  it("parses latex/display attrs from DOM and round-trips them in JSON", () => {
    const host = document.createElement("article");
    host.innerHTML = `<p><span data-math="E=mc^2" data-display="true"></span></p>`;

    const parsed = DOMParser.fromSchema(schema).parse(host);
    const json = parsed.toJSON() as {
      content: { content?: { type: string; attrs?: Record<string, unknown> }[] }[];
    };
    const math = json.content[0]?.content?.[0];
    expect(math?.type).toBe(MATH_NODE_NAME);
    expect(math?.attrs).toMatchObject({ latex: "E=mc^2", display: true });
  });

  it("renders clean latex attrs and text content, including display=false", () => {
    const node = PmNode.fromJSON(schema, {
      type: "math",
      attrs: { latex: "a^2+b^2=c^2", display: false },
    });

    const serialized = DOMSerializer.fromSchema(schema).serializeNode(node) as HTMLElement;
    expect(serialized.tagName).toBe("SPAN");
    expect(serialized.getAttribute(MATH_DOM_ATTR)).toBe("a^2+b^2=c^2");
    expect(serialized.getAttribute(MATH_DISPLAY_ATTR)).toBe("false");
    expect(serialized.textContent).toBe("a^2+b^2=c^2");
  });
});
