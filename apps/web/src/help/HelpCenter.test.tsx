import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelpCenter } from "./HelpCenter";

function setup(props: Partial<Parameters<typeof HelpCenter>[0]> = {}) {
  const onClose = vi.fn();
  const onNavScreen = vi.fn();
  render(<HelpCenter open onClose={onClose} onNavScreen={onNavScreen} {...props} />);
  return { onClose, onNavScreen };
}

describe("HelpCenter", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <HelpCenter open={false} onClose={() => {}} onNavScreen={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the search home with the category grid and reference links", () => {
    setup();
    expect(screen.getByText("How can we help?")).toBeInTheDocument();
    expect(screen.getByText("The Method")).toBeInTheDocument();
    expect(screen.getByText("Keyboard reference")).toBeInTheDocument();
    expect(screen.getByText("Concepts glossary")).toBeInTheDocument();
  });

  it("opens an article and renders its authored body (not the stub)", () => {
    setup();
    fireEvent.click(screen.getByText("The Method"));
    // The Method's first article is "What is incremental reading?"
    expect(
      screen.getByRole("heading", { level: 1, name: /incremental reading/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/queued for writing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/help:\/\/what-is-incremental-reading/)).toBeInTheDocument();
  });

  it("deep-links to an article via openSlug", () => {
    setup({ openSlug: "two-schedulers" });
    expect(screen.getByRole("heading", { level: 1, name: /two schedulers/i })).toBeInTheDocument();
  });

  it("searches and opens a result", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Search the help center"), {
      target: { value: "anki" },
    });
    const result = screen.getByText("Migrating from Readwise, Kindle, and Anki");
    fireEvent.click(result);
    expect(
      screen.getByRole("heading", { level: 1, name: /Migrating from Readwise/i }),
    ).toBeInTheDocument();
  });

  it("renders the keyboard reference from the shortcut registry", () => {
    setup({ openSlug: "keyboard-reference" });
    expect(
      screen.getByRole("heading", { level: 1, name: /Keyboard Reference/i }),
    ).toBeInTheDocument();
    // A registry-derived row + the g-nav supplement.
    expect(screen.getByText("Command palette")).toBeInTheDocument();
    expect(screen.getByText(/Go to Daily Queue/)).toBeInTheDocument();
  });

  it("'Open the relevant screen' navigates and closes", () => {
    const { onNavScreen, onClose } = setup({ openSlug: "overload-is-a-feature" });
    fireEvent.click(screen.getByText("Open the relevant screen"));
    expect(onNavScreen).toHaveBeenCalledWith("/queue");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from the backdrop scrim", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByLabelText("Close help center"));
    expect(onClose).toHaveBeenCalled();
  });
});
