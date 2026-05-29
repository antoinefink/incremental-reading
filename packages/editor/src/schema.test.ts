/**
 * Constrained-schema tests (T015).
 *
 * The whole point of the schema is that it is narrow and cannot grow by
 * accident: an over-broad schema would make the block-ID (T016) + mark +
 * extraction (M4) logic brittle. These tests compile the constrained schema
 * headlessly (no DOM) and assert it ACCEPTS every allowed node/mark and
 * STRIPS/REJECTS disallowed ones (`strike`, `underline`, raw `<script>` HTML)
 * across a JSON round-trip.
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { ALLOWED_MARK_NAMES, ALLOWED_NODE_NAMES, buildSchema } from "./schema";

const schema = buildSchema();

/** Build a node from JSON, then serialize back — the round-trip the editor does. */
function roundTrip(json: unknown): PmNode {
  const node = PmNode.fromJSON(schema, json);
  // Re-parse from its own JSON to prove the shape is stable through the schema.
  return PmNode.fromJSON(schema, node.toJSON());
}

/** Collect every mark name present anywhere in a document. */
function markNames(doc: PmNode): Set<string> {
  const names = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks) names.add(mark.type.name);
    return true;
  });
  return names;
}

/** Collect every node type name present anywhere in a document. */
function nodeNames(doc: PmNode): Set<string> {
  const names = new Set<string>();
  doc.descendants((node) => {
    names.add(node.type.name);
    return true;
  });
  return names;
}

describe("constrained schema — allowed set", () => {
  it("registers exactly the allowed node + mark types", () => {
    for (const name of ALLOWED_NODE_NAMES) {
      expect(schema.nodes[name], `node ${name} should exist`).toBeDefined();
    }
    for (const name of ALLOWED_MARK_NAMES) {
      expect(schema.marks[name], `mark ${name} should exist`).toBeDefined();
    }
  });

  it("does NOT register disallowed marks (strike, underline)", () => {
    expect(schema.marks.strike).toBeUndefined();
    expect(schema.marks.underline).toBeUndefined();
  });

  it("does NOT register disallowed nodes (table, image)", () => {
    expect(schema.nodes.table).toBeUndefined();
    expect(schema.nodes.image).toBeUndefined();
    expect(schema.nodes.taskList).toBeUndefined();
  });

  it("accepts a rich document using the full allowed set", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " and " },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
            { type: "text", text: " and " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
            },
          ],
        },
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }],
            },
          ],
        },
        { type: "codeBlock", content: [{ type: "text", text: "const x = 1;" }] },
        { type: "horizontalRule" },
      ],
    };

    const result = roundTrip(doc);
    const marks = markNames(result);
    expect(marks).toEqual(new Set(["bold", "italic", "code", "link"]));

    const nodes = nodeNames(result);
    expect(nodes.has("heading")).toBe(true);
    expect(nodes.has("blockquote")).toBe(true);
    expect(nodes.has("bulletList")).toBe(true);
    expect(nodes.has("orderedList")).toBe(true);
    expect(nodes.has("listItem")).toBe(true);
    expect(nodes.has("codeBlock")).toBe(true);
    expect(nodes.has("horizontalRule")).toBe(true);
  });
});

describe("constrained schema — rejects disallowed content", () => {
  it("rejects a disallowed `strike` mark (mark type unknown to schema)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "struck", marks: [{ type: "strike" }] }],
        },
      ],
    };
    // The constrained schema has no `strike` mark, so it cannot survive a JSON
    // round-trip: ProseMirror throws rather than silently keeping it.
    expect(() => PmNode.fromJSON(schema, doc)).toThrow(/no mark type strike/);
    expect(schema.marks.strike).toBeUndefined();
  });

  it("rejects a disallowed `underline` mark (mark type unknown to schema)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "u", marks: [{ type: "underline" }] }],
        },
      ],
    };
    expect(() => PmNode.fromJSON(schema, doc)).toThrow(/no mark type underline/);
  });

  it("throws when a disallowed NODE type is present (e.g. an image)", () => {
    const doc = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "x.png" } }],
    };
    expect(() => PmNode.fromJSON(schema, doc)).toThrow();
  });

  it("cannot represent raw HTML / <script> as a node — there is no html node", () => {
    expect(schema.nodes.html).toBeUndefined();
    // A document trying to smuggle a raw-HTML node type fails to parse.
    const doc = {
      type: "doc",
      content: [{ type: "html", content: [{ type: "text", text: "<script>alert(1)</script>" }] }],
    };
    expect(() => PmNode.fromJSON(schema, doc)).toThrow();
  });
});
