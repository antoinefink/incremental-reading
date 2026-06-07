/**
 * SourceEditor rich render test (T072 + U1).
 *
 * The constrained editor (used for SOURCE and, reused, EXTRACT bodies) renders a
 * `math` node via the KaTeX NodeView and a `language`-tagged `codeBlock` via the
 * Shiki NodeView. This asserts that a doc containing a block formula + an inline
 * formula + a code block + a local article image renders the math (KaTeX), the
 * code (with the editable text intact), and the image without exposing a remote
 * URL or filesystem path.
 */

import { SourceEditor } from "@interleave/editor";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "blk-formula" },
      content: [{ type: "math", attrs: { latex: "E=mc^2", display: true } }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "blk-inline" },
      content: [
        { type: "text", text: "energy " },
        { type: "math", attrs: { latex: "a^2+b^2", display: false } },
      ],
    },
    {
      type: "codeBlock",
      attrs: { blockId: "blk-code", language: "python" },
      content: [{ type: "text", text: "print('hi')" }],
    },
    {
      type: "image",
      attrs: {
        blockId: "blk-image",
        src: "article-image://src_1/asset_1",
        alt: "Architecture diagram",
        title: "Figure title",
        width: 640,
        height: 480,
      },
    },
  ],
};

describe("SourceEditor rich render (T072 + U1)", () => {
  it("renders math nodes, a code block, and a local article image in the body", async () => {
    render(<SourceEditor initialDoc={DOC} editable={false} />);

    // The KaTeX math NodeViews render (block + inline).
    await waitFor(() => {
      const mathNodes = screen.getAllByTestId("math-node");
      expect(mathNodes.length).toBe(2);
    });
    const mathNodes = screen.getAllByTestId("math-node");
    // At least one is the block (display) formula.
    expect(mathNodes.some((n) => n.getAttribute("data-display") === "true")).toBe(true);
    // KaTeX rendered markup is present.
    expect(document.querySelector(".katex")).not.toBeNull();

    // The code NodeView renders, keeping the editable code text intact.
    await waitFor(() => {
      expect(screen.getByTestId("code-node")).toBeInTheDocument();
    });
    expect(screen.getByTestId("code-node")).toHaveTextContent("print('hi')");
    expect(screen.getByTestId("code-node").getAttribute("data-language")).toBe("python");

    const image = screen.getByRole("img", { name: "Architecture diagram" });
    expect(image.getAttribute("src")).toBe("article-image://src_1/asset_1");
    expect(image.getAttribute("title")).toBe("Figure title");
    expect(image.getAttribute("width")).toBe("640");
    expect(image.getAttribute("height")).toBe("480");
    expect(image.getAttribute("src")).not.toMatch(/^(https?:|file:|data:)/);
  });
});
