// @vitest-environment jsdom

import { DOMParser, DOMSerializer, Node as PmNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { buildSchema } from "../schema";
import {
  ARTICLE_IMAGE_NODE_NAME,
  isArticleImageSrc,
  normalizeArticleImageDimension,
  normalizeArticleImageTextAttr,
} from "./article-image";

const schema = buildSchema();

describe("ArticleImage", () => {
  it("parses only local article-image refs from DOM", () => {
    const host = document.createElement("article");
    host.innerHTML = `
      <img src="article-image://src_1/asset_1" alt=" Figure " title=" T " width="640" height="480" />
      <img src="https://remote.test/a.png" alt="remote" />`;

    const parsed = DOMParser.fromSchema(schema).parse(host);
    const json = parsed.toJSON() as {
      content?: { type: string; attrs?: Record<string, unknown> }[];
    };

    const images = json.content?.filter((node) => node.type === ARTICLE_IMAGE_NODE_NAME) ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]?.attrs).toMatchObject({
      src: "article-image://src_1/asset_1",
      alt: "Figure",
      title: "T",
      width: 640,
      height: 480,
    });
  });

  it("renders invalid stored src values as a non-image placeholder", () => {
    const serialized = DOMSerializer.fromSchema(schema).serializeNode(
      PmNode.fromJSON(schema, {
        type: "image",
        attrs: {
          blockId: "blk-image",
          src: "https://remote.test/a.png",
          alt: "Remote figure",
        },
      }),
    ) as HTMLElement;

    expect(serialized.tagName).toBe("SPAN");
    expect(serialized.getAttribute("data-block-id")).toBe("blk-image");
    expect(serialized.getAttribute("data-article-image-invalid")).toBe("true");
    expect(serialized.textContent).toBe("Remote figure");
    expect(serialized.getAttribute("src")).toBeNull();
  });

  it("normalizes image src, text, and dimensions narrowly", () => {
    expect(isArticleImageSrc("article-image://src_1/asset-1")).toBe(true);
    expect(isArticleImageSrc("article-image://src_1/../asset-1")).toBe(false);
    expect(isArticleImageSrc("file:///tmp/a.png")).toBe(false);
    expect(normalizeArticleImageTextAttr("  Figure\none  ")).toBe("Figure one");
    expect(normalizeArticleImageDimension("640")).toBe(640);
    expect(normalizeArticleImageDimension("0")).toBeNull();
    expect(normalizeArticleImageDimension("640px")).toBeNull();
    expect(normalizeArticleImageDimension("20001")).toBeNull();
  });
});
