/**
 * Inspector "Reliability" section tests (T091).
 *
 * The reliability badge label is assembled MAIN-side (`@interleave/core`
 * `formatSourceRef`); this asserts the RENDERER seam only:
 *  - the section renders the reliability badge + the type/tier/confidence rows + notes;
 *  - a source with no reliability shows the calm empty state + an "Add reliability"
 *    affordance;
 *  - opening the editor and saving calls `sources.updateReliability` with the entered
 *    fields and then fires `onChanged` so the inspector re-reads (the badge/refblocks
 *    update).
 *
 * `appApi` is mocked so the test exercises only this component's wiring — no IPC/SQLite.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceProvenance } from "../../lib/appApi";

const h = vi.hoisted(() => ({ updateSourceReliability: vi.fn() }));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { updateSourceReliability: h.updateSourceReliability },
  };
});

import { ReliabilitySection } from "./Inspector";

const RELIABLE: SourceProvenance = {
  elementId: "src-1",
  url: "https://arxiv.org/abs/1911.01547",
  canonicalUrl: null,
  originalUrl: null,
  author: "François Chollet",
  publishedAt: "2019-11-05",
  accessedAt: null,
  reasonAdded: null,
  sourceType: "article",
  reliabilityTier: "secondary",
  confidence: "low",
  reliabilityNotes: "Pre-print; not peer reviewed.",
};

const EMPTY: SourceProvenance = {
  elementId: "src-1",
  url: null,
  canonicalUrl: null,
  originalUrl: null,
  author: null,
  publishedAt: null,
  accessedAt: null,
  reasonAdded: null,
  sourceType: null,
  reliabilityTier: null,
  confidence: null,
  reliabilityNotes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.updateSourceReliability.mockResolvedValue({ provenance: EMPTY });
});

describe("Inspector ReliabilitySection (T091)", () => {
  it("renders the reliability badge + the rows + notes for a reliable source", () => {
    render(<ReliabilitySection sourceId="src-1" provenance={RELIABLE} onChanged={vi.fn()} />);
    const badge = screen.getByTestId("inspector-reliability-badge");
    expect(badge).toHaveAttribute("data-reliability-tier", "secondary");
    // Low confidence → uncertainty label.
    expect(badge).toHaveTextContent("Secondary source · low confidence");
    const section = screen.getByTestId("reliability-section");
    expect(section).toHaveTextContent("Article");
    expect(section).toHaveTextContent("Secondary");
    expect(section).toHaveTextContent("Low");
    expect(screen.getByTestId("inspector-reliability-notes")).toHaveTextContent(
      "Pre-print; not peer reviewed.",
    );
  });

  it("shows the empty state + an Add reliability affordance for a null source", () => {
    render(<ReliabilitySection sourceId="src-1" provenance={EMPTY} onChanged={vi.fn()} />);
    expect(screen.getByTestId("inspector-reliability-empty")).toBeInTheDocument();
    // No badge when nothing is set.
    expect(screen.queryByTestId("inspector-reliability-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("inspector-reliability-edit")).toHaveTextContent(/add reliability/i);
  });

  it("opens the editor, saves via sources.updateReliability, and fires onChanged", async () => {
    const onChanged = vi.fn();
    render(<ReliabilitySection sourceId="src-1" provenance={EMPTY} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId("inspector-reliability-edit"));
    fireEvent.change(screen.getByTestId("inspector-reliability-tier"), {
      target: { value: "primary" },
    });
    fireEvent.change(screen.getByTestId("inspector-reliability-type"), {
      target: { value: "paper" },
    });
    fireEvent.change(screen.getByTestId("inspector-reliability-confidence"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByTestId("inspector-reliability-notes-input"), {
      target: { value: "Landmark paper." },
    });
    fireEvent.click(screen.getByTestId("inspector-reliability-save"));

    await waitFor(() => {
      expect(h.updateSourceReliability).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: "src-1",
          reliabilityTier: "primary",
          sourceType: "paper",
          confidence: "high",
          reliabilityNotes: "Landmark paper.",
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });
});
