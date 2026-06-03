// @vitest-environment jsdom

import { DOMParser, DOMSerializer, Node as PmNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { buildSchema } from "../schema";
import { CODE_BLOCK_LANGUAGE_ATTR } from "./code-block-language";

const schema = buildSchema();

describe("CodeBlockWithLanguage", () => {
  it("parses fenced-code language from class names and renders data/class attrs", () => {
    const host = document.createElement("article");
    host.innerHTML = `<pre><code class="language-python">print("hi")</code></pre>`;

    const parsed = DOMParser.fromSchema(schema).parse(host);
    const json = parsed.toJSON() as {
      content: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }[];
    };
    expect(json.content[0]?.type).toBe("codeBlock");
    expect(json.content[0]?.attrs?.language).toBe("python");

    const serialized = DOMSerializer.fromSchema(schema).serializeNode(
      PmNode.fromJSON(schema, {
        type: "codeBlock",
        attrs: { blockId: "blk-code", language: "typescript" },
        content: [{ type: "text", text: "const x = 1;" }],
      }),
    ) as HTMLElement;
    expect(serialized.getAttribute(CODE_BLOCK_LANGUAGE_ATTR)).toBe("typescript");
    expect(serialized.className).toContain("language-typescript");
  });

  it("keeps plain code blocks free of language attributes", () => {
    const serialized = DOMSerializer.fromSchema(schema).serializeNode(
      PmNode.fromJSON(schema, {
        type: "codeBlock",
        attrs: { blockId: "blk-code", language: null },
        content: [{ type: "text", text: "plain" }],
      }),
    ) as HTMLElement;
    const code = serialized.querySelector("code");
    expect(code?.hasAttribute(CODE_BLOCK_LANGUAGE_ATTR)).toBe(false);
    expect(code?.className).toBe("");
  });
});
