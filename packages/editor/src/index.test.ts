import { describe, expect, it } from "vitest";
import {
  ARTICLE_IMAGE_NODE_NAME,
  buildSchema,
  EDITOR_PACKAGE,
  flashBlock,
  isArticleImageSrc,
  jumpToReadPoint,
  jumpToSource,
  newBlockId,
  SourceEditor,
  toPlainText,
} from "./index";

describe("editor barrel", () => {
  it("exports schema, block-id, read-point, jump, serialization, and React editor APIs", () => {
    expect(EDITOR_PACKAGE).toBe("@interleave/editor");
    expect(typeof buildSchema).toBe("function");
    expect(typeof newBlockId).toBe("function");
    expect(typeof jumpToReadPoint).toBe("function");
    expect(typeof jumpToSource).toBe("function");
    expect(typeof flashBlock).toBe("function");
    expect(typeof toPlainText).toBe("function");
    expect(typeof SourceEditor).toBe("function");
    expect(ARTICLE_IMAGE_NODE_NAME).toBe("image");
    expect(isArticleImageSrc("article-image://src_1/asset_1")).toBe(true);
  });
});
