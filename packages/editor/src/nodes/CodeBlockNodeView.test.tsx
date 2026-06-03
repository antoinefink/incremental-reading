// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  highlightCodeHtml: vi.fn(),
}));

vi.mock("@tiptap/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ReactNodeViewRenderer: (component: unknown) => component,
    NodeViewWrapper: ({ as, children, ...props }: Record<string, unknown>) =>
      React.createElement((as as string | undefined) ?? "div", props, children as never),
    NodeViewContent: ({ as, ...props }: Record<string, unknown>) =>
      React.createElement((as as string | undefined) ?? "div", props),
  };
});

vi.mock("../render/shiki", () => ({
  highlightCodeHtml: (...args: unknown[]) => h.highlightCodeHtml(...args),
}));

import { CodeBlockNodeView } from "./CodeBlockNodeView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderNodeView(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Component = CodeBlockNodeView as unknown as (
    input: Record<string, unknown>,
  ) => ReactElement;
  act(() => root.render(createElement(Component, props)));
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  h.highlightCodeHtml.mockReset();
  h.highlightCodeHtml.mockResolvedValue('<pre class="shiki">highlighted</pre>');
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("CodeBlockNodeView", () => {
  it("renders an editable language picker and async highlighted overlay", async () => {
    const updateAttributes = vi.fn();
    const view = renderNodeView({
      node: { attrs: { language: "typescript" }, textContent: "const x = 1;" },
      updateAttributes,
      editor: { isEditable: true },
    });

    const wrapper = view.container.querySelector("[data-testid='code-node']");
    expect(wrapper?.getAttribute("data-language")).toBe("typescript");

    const select = view.container.querySelector(
      "[data-testid='code-node-lang']",
    ) as HTMLSelectElement;
    expect(select.value).toBe("typescript");
    act(() => {
      select.value = "python";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(updateAttributes).toHaveBeenCalledWith({ language: "python" });

    await act(async () => {
      await Promise.resolve();
    });
    expect(h.highlightCodeHtml).toHaveBeenCalledWith("const x = 1;", {
      language: "typescript",
      theme: "light",
    });
    expect(
      view.container.querySelector("[data-testid='code-node-highlighted']")?.innerHTML,
    ).toContain("highlighted");
  });

  it("omits the picker in read-only mode and tracks the document theme", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const view = renderNodeView({
      node: { attrs: { language: null }, textContent: "plain" },
      updateAttributes: vi.fn(),
      editor: { isEditable: false },
    });

    expect(view.container.querySelector("[data-testid='code-node-lang']")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.highlightCodeHtml).toHaveBeenCalledWith("plain", {
      language: null,
      theme: "dark",
    });
  });
});
