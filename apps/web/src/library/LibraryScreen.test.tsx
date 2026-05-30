/**
 * LibraryScreen component tests (T042).
 *
 * Search/index/ranking all live MAIN-side (`SearchRepository` + the FTS migration);
 * this asserts the RENDERER seam of the library view:
 *  - typing a query calls `appApi.searchQuery` (debounced) with the trimmed term;
 *  - grouped results render with the query highlighted (`<em>`);
 *  - clicking a type/concept filter narrows the call;
 *  - an empty result set shows the EmptyState; an empty query shows the prompt.
 *
 * `appApi` + the router are mocked so the test exercises ONLY this component's
 * wiring; no SQLite/IPC — the renderer is a pure UI consumer here.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConceptNode, SearchResult } from "../lib/appApi";

const h = vi.hoisted(() => {
  const sourceHit: SearchResult = {
    id: "src-1",
    type: "source",
    title: "On the Measure of Intelligence",
    snippet: "…define the intelligence of a system…",
    score: -2.1,
    priority: 0.9,
    priorityLabel: "A",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: null,
    dueAt: null,
  };
  const cardHit: SearchResult = {
    id: "card-1",
    type: "card",
    title: "Chollet's definition of intelligence",
    snippet: "How does Chollet define…",
    score: -1.4,
    priority: 0.9,
    priorityLabel: "A",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "Definition · ¶1",
    dueAt: null,
  };
  const concept: ConceptNode = {
    id: "concept-1",
    name: "Intelligence",
    parentConceptId: null,
    childCount: 0,
    memberCount: 2,
  };
  return {
    sourceHit,
    cardHit,
    concept,
    navigateSpy: vi.fn(),
    searchQuery: vi.fn(),
    listConcepts: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      searchQuery: h.searchQuery,
      listConcepts: h.listConcepts,
    },
  };
});

import { LibraryScreen } from "./LibraryScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.searchQuery.mockResolvedValue({ results: [h.sourceHit, h.cardHit] });
  h.listConcepts.mockResolvedValue({ concepts: [h.concept] });
});

describe("LibraryScreen", () => {
  it("starts with the search prompt and no query call", async () => {
    render(<LibraryScreen />);
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    // The concept list loads for the filterbar/map.
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    expect(h.searchQuery).not.toHaveBeenCalled();
  });

  it("searches (debounced) on input and renders grouped, highlighted results", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });

    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "intelligence" })),
    );

    // Both groups render.
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(screen.getByTestId("library-group-card")).toBeTruthy();

    // The matched term is highlighted in a result title.
    const rows = screen.getAllByTestId("library-result");
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.querySelector("em"))).toBe(true);
  });

  it("narrows the query when a type filter is clicked", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    h.searchQuery.mockClear();
    h.searchQuery.mockResolvedValue({ results: [h.cardHit] });
    fireEvent.click(screen.getByTestId("library-filter-type-card"));

    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", type: "card" }),
      ),
    );
  });

  it("narrows the query when a concept filter is clicked", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    h.searchQuery.mockClear();
    fireEvent.click(await screen.findByTestId("library-filter-concept-concept-1"));
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", conceptId: "concept-1" }),
      ),
    );
  });

  it("shows the empty state when there are no matches", async () => {
    h.searchQuery.mockResolvedValue({ results: [] });
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "zzzznope" },
    });
    expect(await screen.findByTestId("library-empty")).toBeTruthy();
  });

  it("opens a result in context on click + open button", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));

    // The detail panel shows; clicking Open navigates to the source reader.
    fireEvent.click(await screen.findByTestId("library-detail-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });
  });
});
