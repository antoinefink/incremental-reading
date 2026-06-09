import type { SourceBlockProcessingState } from "@interleave/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceBlockProcessingSummaryPayload } from "../../lib/appApi";
import { DoneIntentMenu } from "./DoneIntentMenu";

afterEach(cleanup);

type SummaryOverrides = Partial<Omit<SourceBlockProcessingSummaryPayload, "stateCounts">> & {
  stateCounts?: Partial<Record<SourceBlockProcessingState, number>>;
};

function summary(overrides: SummaryOverrides = {}): SourceBlockProcessingSummaryPayload {
  const stateCounts = {
    unread: 0,
    read: 0,
    extracted: 0,
    ignored: 0,
    processed_without_output: 0,
    needs_later: 0,
    stale_after_edit: 0,
  };
  return {
    sourceElementId: "src-1",
    totalBlocks: 0,
    processedBlocks: 0,
    terminalBlocks: 0,
    unresolvedBlocks: 0,
    highPriorityUnresolvedBlocks: 0,
    extractedBlockCount: 0,
    extractedOutputCount: 0,
    ignoredBlocks: 0,
    ignoredRatio: 0,
    terminalRatio: 1,
    staleAfterEditBlocks: 0,
    legacyProjectedBlocks: 0,
    canMarkDoneWithoutConfirmation: true,
    ...overrides,
    stateCounts: { ...stateCounts, ...(overrides.stateCounts ?? {}) },
  };
}

const UNRESOLVED = summary({
  canMarkDoneWithoutConfirmation: false,
  unresolvedBlocks: 64,
  totalBlocks: 68,
  stateCounts: { unread: 60, needs_later: 3, stale_after_edit: 1 },
});

describe("DoneIntentMenu", () => {
  it("fast path: 0 unresolved marks done immediately with no popover", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(summary({ canMarkDoneWithoutConfirmation: true }));
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("done-intent-trigger"));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("finished"));
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("done-intent-pop")).toBeNull();
  });

  it("opens a non-modal popover with focus on Return later, the breakdown, and the resume line", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(
      <DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} resumeLabel="block 12 of 68" />,
    );

    fireEvent.click(screen.getByTestId("done-intent-trigger"));

    const pop = await screen.findByTestId("done-intent-pop");
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-modal")).toBe("false");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("done-intent-later")),
    );
    const breakdown = screen.getByTestId("done-intent-breakdown").textContent ?? "";
    expect(breakdown).toContain("60");
    expect(breakdown).toContain("unread");
    expect(breakdown).toContain("deferred");
    expect(breakdown).toContain("stale after edit");
    expect(screen.getByTestId("done-intent-resume").textContent).toBe("block 12 of 68");
  });

  it("omits the resume line when none is provided", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    expect(screen.queryByTestId("done-intent-resume")).toBeNull();
  });

  it.each([
    ["done-intent-later", "later"],
    ["done-intent-finished", "finished"],
    ["done-intent-abandon", "abandon"],
  ] as const)("routes %s to onResolved(%s) exactly once", async (testId, intent) => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    fireEvent.click(screen.getByTestId(testId));

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith(intent);
  });

  it("Escape closes the surface without resolving", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("done-intent-pop")).toBeNull());
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("drops a double-submit (resolves once)", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    const finished = screen.getByTestId("done-intent-finished");
    fireEvent.click(finished);
    fireEvent.click(finished);

    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("disables the trigger when host is busy and does not fetch", () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} busy />);
    const trigger = screen.getByTestId("done-intent-trigger") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(getSummary).not.toHaveBeenCalled();
  });

  it("runs the trigger logic when triggerSignal changes (keyboard shortcut)", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    const { rerender } = render(
      <DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} triggerSignal={0} />,
    );
    expect(getSummary).not.toHaveBeenCalled();
    rerender(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} triggerSignal={1} />);
    await screen.findByTestId("done-intent-pop");
    expect(getSummary).toHaveBeenCalledTimes(1);
  });

  it("releases the in-flight guard after the host settles so a fast-path retry works", async () => {
    // Regression: the fast path never opens the popover, so the guard must clear on
    // `busy` settling (not on an open→close transition) or the Done control deadlocks
    // when the host mutation fails and the component stays mounted on the same item.
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(summary({ canMarkDoneWithoutConfirmation: true }));
    const { rerender } = render(
      <DoneIntentMenu getSummary={getSummary} onResolved={onResolved} busy={false} />,
    );
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    // Host runs the mutation: busy true, then back to false on a failure (no unmount).
    rerender(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} busy={true} />);
    rerender(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} busy={false} />);
    // The Done control must still respond.
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(2));
  });

  it("toggles the popover closed on a re-press without re-fetching", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} />);
    const trigger = screen.getByTestId("done-intent-trigger");
    fireEvent.click(trigger);
    await screen.findByTestId("done-intent-pop");
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByTestId("done-intent-pop")).toBeNull());
    expect(getSummary).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside click without resolving", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("done-intent-pop")).toBeNull());
    expect(onResolved).not.toHaveBeenCalled();
  });
});
