import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocationSummary } from "../lib/appApi";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

import { jumpSearchForLocation, useNavigateToLocation } from "./navigateToLocation";

function location(overrides: Partial<LocationSummary> = {}): LocationSummary {
  return {
    id: "loc-1",
    sourceElementId: "src-1",
    label: "Paragraph 2",
    blockIds: ["blk-a", "blk-b"],
    startOffset: 4,
    endOffset: 12,
    selectedText: "selected",
    ...overrides,
  } as LocationSummary;
}

beforeEach(() => {
  navigate.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(12345);
});

describe("jumpSearchForLocation", () => {
  it("builds a search payload from the first stable block id", () => {
    expect(jumpSearchForLocation(location())).toEqual({
      block: "blk-a",
      offset: 4,
      label: "Paragraph 2",
      n: 12345,
    });
  });

  it("returns null when there is no block anchor", () => {
    expect(jumpSearchForLocation(location({ blockIds: [] }))).toBeNull();
  });
});

describe("useNavigateToLocation", () => {
  it("navigates to the source reader with the jump search payload", () => {
    const { result } = renderHook(() => useNavigateToLocation());

    act(() => result.current(location()));

    expect(navigate).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "src-1" },
      search: { block: "blk-a", offset: 4, label: "Paragraph 2", n: 12345 },
    });
  });
});
