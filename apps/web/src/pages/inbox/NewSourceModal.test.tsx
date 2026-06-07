import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  importManualSource: vi.fn(),
  importMarkdownText: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    appApi: {
      importManualSource: h.importManualSource,
      importMarkdownText: h.importMarkdownText,
    },
  };
});

import { NewSourceModal } from "./NewSourceModal";

beforeEach(() => {
  h.importManualSource.mockReset();
  h.importMarkdownText.mockReset();
  h.importManualSource.mockResolvedValue({ id: "source-1" });
  h.importMarkdownText.mockResolvedValue({ id: "md-1" });
});

describe("NewSourceModal", () => {
  it("renders nothing when closed", () => {
    const { queryByTestId } = render(
      <NewSourceModal open={false} onClose={vi.fn()} onCreated={vi.fn()} />,
    );

    expect(queryByTestId("new-source-modal")).toBeNull();
  });

  it("creates a manual source with trimmed optional metadata and priority", async () => {
    const onCreated = vi.fn();
    const { getByTestId } = render(<NewSourceModal open onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(getByTestId("new-source-title"), { target: { value: "  Article  " } });
    fireEvent.change(getByTestId("new-source-url"), {
      target: { value: " https://example.com/path?utm_source=x " },
    });
    fireEvent.change(getByTestId("new-source-author"), { target: { value: "  Author  " } });
    fireEvent.change(getByTestId("new-source-date"), { target: { value: "2026-05-20" } });
    fireEvent.change(getByTestId("new-source-accessed"), { target: { value: "2026-06-03" } });
    fireEvent.change(getByTestId("new-source-body"), { target: { value: "Body text" } });
    fireEvent.click(getByTestId("new-source-priority-A"));
    fireEvent.click(getByTestId("new-source-submit"));

    await waitFor(() =>
      expect(h.importManualSource).toHaveBeenCalledWith({
        title: "Article",
        priority: "A",
        url: "https://example.com/path?utm_source=x",
        author: "Author",
        publishedAt: "2026-05-20",
        accessedAt: "2026-06-03T00:00:00.000Z",
        body: "Body text",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith("source-1");
  });

  it("uses the configured default priority when the user leaves priority unchanged", async () => {
    const onCreated = vi.fn();
    const { getByTestId } = render(
      <NewSourceModal open defaultPriority="B" onClose={vi.fn()} onCreated={onCreated} />,
    );

    expect(getByTestId("new-source-priority-B")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(getByTestId("new-source-title"), { target: { value: "Defaulted" } });
    fireEvent.change(getByTestId("new-source-accessed"), { target: { value: "" } });
    fireEvent.click(getByTestId("new-source-submit"));

    await waitFor(() =>
      expect(h.importManualSource).toHaveBeenCalledWith({
        title: "Defaulted",
        priority: "B",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith("source-1");
  });

  it("routes Markdown bodies through the Markdown importer and validates empty bodies", async () => {
    const onCreated = vi.fn();
    const { getByTestId, findByTestId } = render(
      <NewSourceModal open defaultPriority="B" onClose={vi.fn()} onCreated={onCreated} />,
    );

    fireEvent.change(getByTestId("new-source-title"), { target: { value: "Markdown" } });
    fireEvent.click(getByTestId("new-source-markdown"));
    fireEvent.click(getByTestId("new-source-submit"));
    expect(await findByTestId("new-source-error")).toHaveTextContent(/Add some Markdown/i);

    fireEvent.change(getByTestId("new-source-body"), { target: { value: "# Heading" } });
    fireEvent.click(getByTestId("new-source-submit"));
    await waitFor(() =>
      expect(h.importMarkdownText).toHaveBeenCalledWith({
        text: "# Heading",
        title: "Markdown",
        priority: "B",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith("md-1");
  });

  it("closes from Escape and displays bridge errors", async () => {
    h.importManualSource.mockRejectedValueOnce(new Error("db down"));
    const onClose = vi.fn();
    const { getByTestId, findByTestId } = render(
      <NewSourceModal open onClose={onClose} onCreated={vi.fn()} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();

    fireEvent.change(getByTestId("new-source-title"), { target: { value: "Bad" } });
    fireEvent.click(getByTestId("new-source-submit"));
    expect(await findByTestId("new-source-error")).toHaveTextContent("db down");
  });
});
