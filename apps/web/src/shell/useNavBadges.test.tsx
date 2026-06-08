/**
 * Shell nav-badge hook tests.
 *
 * The sidebar's Queue / Inbox / Review count badges are wired to REAL
 * `window.appApi` data — the live due-queue counts (`queue.list` →
 * `counts.all` / `counts.card`) and the inbox length (`inbox.list`) — not
 * hardcoded placeholder numbers. This asserts:
 *  - Queue reads the full due count, Review reads the due-CARD count;
 *  - Inbox reads the inbox-source count;
 *  - the counts refresh when a command-level undo fires (`UNDO_EVENT`);
 *  - the counts refresh when another queue surface emits `queueRefresh`;
 *  - outside the desktop shell it queries nothing and returns no counts.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestQueueRefresh } from "../components/queue/queueRefresh";
import { UNDO_EVENT } from "./nav";
import { useNavBadges } from "./useNavBadges";

const h = vi.hoisted(() => ({
  isDesktop: vi.fn(() => true),
  listQueue: vi.fn(),
  listInbox: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.isDesktop(),
    appApi: {
      listQueue: h.listQueue,
      listInbox: h.listInbox,
    },
  };
});

function queueResult(all: number, card: number) {
  return {
    items: [],
    counts: {
      all,
      card,
      source: 0,
      extract: 0,
      topic: 0,
      task: 0,
      highPriority: 0,
      overdue: 0,
      protected: 0,
    },
    budget: { used: 0, target: 60 },
  };
}

function inboxResult(count: number) {
  return { items: Array.from({ length: count }, (_, i) => ({ id: `s-${i}` })) };
}

describe("useNavBadges", () => {
  beforeEach(() => {
    h.isDesktop.mockReset();
    h.listQueue.mockReset();
    h.listInbox.mockReset();
  });

  it("reads Queue (all), Review (cards), and Inbox (length) from the bridge", async () => {
    h.isDesktop.mockReturnValue(true);
    h.listQueue.mockResolvedValue(queueResult(42, 28));
    h.listInbox.mockResolvedValue(inboxResult(4));

    const { result } = renderHook(() => useNavBadges());

    await waitFor(() => expect(result.current.queue).toBe(42));
    expect(result.current.review).toBe(28);
    await waitFor(() => expect(result.current.inbox).toBe(4));
  });

  it("refreshes the counts on UNDO_EVENT (undo changes what is due / in the inbox)", async () => {
    h.isDesktop.mockReturnValue(true);
    h.listQueue.mockResolvedValue(queueResult(42, 28));
    h.listInbox.mockResolvedValue(inboxResult(4));

    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.queue).toBe(42));

    h.listQueue.mockResolvedValue(queueResult(41, 27));
    h.listInbox.mockResolvedValue(inboxResult(5));
    act(() => {
      window.dispatchEvent(new CustomEvent(UNDO_EVENT));
    });
    await waitFor(() => expect(result.current.queue).toBe(41));
    expect(result.current.review).toBe(27);
    await waitFor(() => expect(result.current.inbox).toBe(5));
  });

  it("refreshes queue badges on queue refresh events from other surfaces", async () => {
    h.isDesktop.mockReturnValue(true);
    h.listQueue.mockResolvedValue(queueResult(1, 0));
    h.listInbox.mockResolvedValue(inboxResult(4));

    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.queue).toBe(1));

    h.listQueue.mockResolvedValue(queueResult(3, 1));
    act(() => {
      requestQueueRefresh();
    });

    await waitFor(() => expect(result.current.queue).toBe(3));
    expect(result.current.review).toBe(1);
  });

  it("queries nothing and returns no counts outside the desktop shell", async () => {
    h.isDesktop.mockReturnValue(false);

    const { result } = renderHook(() => useNavBadges());

    expect(h.listQueue).not.toHaveBeenCalled();
    expect(h.listInbox).not.toHaveBeenCalled();
    expect(result.current.queue).toBeUndefined();
    expect(result.current.review).toBeUndefined();
    expect(result.current.inbox).toBeUndefined();
  });
});
