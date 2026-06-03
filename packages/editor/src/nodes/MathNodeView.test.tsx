// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  renderMathHtml: vi.fn(),
}));

vi.mock("@tiptap/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ReactNodeViewRenderer: (component: unknown) => component,
    NodeViewWrapper: ({ as, children, ...props }: Record<string, unknown>) =>
      React.createElement((as as string | undefined) ?? "div", props, children as never),
  };
});

vi.mock("../render/katex", () => ({
  renderMathHtml: (...args: unknown[]) => h.renderMathHtml(...args),
}));

import { MathNodeView } from "./MathNodeView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderNodeView(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Component = MathNodeView as unknown as (input: Record<string, unknown>) => ReactElement;
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
  h.renderMathHtml.mockReset();
  h.renderMathHtml.mockReturnValue('<span class="katex">formula</span>');
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("MathNodeView", () => {
  it("renders KaTeX output and commits inline edits", () => {
    const updateAttributes = vi.fn();
    const view = renderNodeView({
      node: { attrs: { latex: "E=mc^2", display: true } },
      updateAttributes,
      editor: { isEditable: true },
    });

    expect(h.renderMathHtml).toHaveBeenCalledWith("E=mc^2", { display: true });
    expect(
      view.container.querySelector("[data-testid='math-node']")?.getAttribute("data-display"),
    ).toBe("true");
    const rendered = view.container.querySelector("[data-testid='math-node-rendered']");
    expect(rendered?.innerHTML).toContain("formula");

    act(() => {
      rendered?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = view.container.querySelector(
      "[data-testid='math-node-edit']",
    ) as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "F=ma");
      (
        input as unknown as { _valueTracker?: { setValue: (value: string) => void } }
      )._valueTracker?.setValue("E=mc^2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(updateAttributes).toHaveBeenCalledWith({ latex: "F=ma" });
  });

  it("does not enter edit mode when the editor is read-only", () => {
    const view = renderNodeView({
      node: { attrs: { latex: "", display: false } },
      updateAttributes: vi.fn(),
      editor: { isEditable: false },
    });

    act(() => {
      view.container
        .querySelector("[data-testid='math-node-empty']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(view.container.querySelector("[data-testid='math-node-edit']")).toBeNull();
  });
});
