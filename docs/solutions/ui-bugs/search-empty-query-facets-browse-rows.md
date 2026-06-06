---
title: "Search empty-query facets should browse matching rows"
date: "2026-06-06"
category: "ui-bugs"
module: "search"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "The /search empty screen did not show counters next to Type chips."
  - "Clicking empty-query facets such as Sources or the Intelligence concept did not show matching source, extract, or card rows."
  - "Rows and selection from a previous empty-query facet could remain visible while a new browse request was pending."
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "service_object"
  - "testing_framework"
tags:
  - "search"
  - "empty-query"
  - "facet-counts"
  - "library-browse"
  - "library-screen"
  - "renderer-bridge"
  - "stale-response-guard"
---

# Search empty-query facets should browse matching rows

## Problem

`/search` treated an empty query as "show prompt and clear results" even when facets were selected. That left the empty search screen without Type/Priority counters, and facet clicks such as `Sources` or `Intelligence` did not browse the matching collection rows.

## Symptoms

- Type chips on the empty `/search` screen had no counters.
- Priority chips also had no empty-query counters.
- Concept chips could show global concept volume instead of the `/search` source/extract/card universe.
- Clicking `Sources` with no keyword left the prompt visible instead of showing source rows.
- Clicking a concept such as `Intelligence` with no keyword did not show matching source, extract, or card rows.
- Empty-query facet transitions could leave stale rows or a stale detail selection visible while the next browse request was pending.

## What Didn't Work

- The keyword facet-count fix only handled non-empty `search.query` and semantic paths.
- Calling `search.query` for empty input was the wrong path because keyword search intentionally returns no rows for an empty query.
- Falling back to `ConceptNode.memberCount` avoided zero concept chips, but that value is global Map volume, not scoped to the `/search` result universe.
- Filtering or counting in React would violate the renderer boundary and still would not have rows to filter when empty keyword search returns `[]`.

## Solution

Use `appApi.libraryBrowse` as the empty-query retrieval mode, while keeping keyword and semantic search unchanged.

```ts
const SEARCHABLE_TYPES = TYPE_GROUPS.map((g) => g.type);

function emptyQueryBrowseRequest(filters: {
  readonly typeFilter: SearchableType | null;
  readonly conceptFilter: string | null;
  readonly priorityFilter: PriorityLetter | null;
}): LibraryBrowseRequest {
  return {
    types: filters.typeFilter ? [filters.typeFilter] : SEARCHABLE_TYPES,
    ...(filters.conceptFilter ? { conceptId: filters.conceptFilter } : {}),
    ...(filters.priorityFilter ? { priorityLabel: filters.priorityFilter } : {}),
  };
}
```

At empty-query browse start, clear stale rows and selection synchronously before the bridge request resolves:

```ts
if (q.length === 0) {
  setLoading(true);
  setError(null);
  setResults([]);
  setSelId(null);

  appApi.libraryBrowse(emptyQueryBrowseRequest(filters)).then((res) => {
    setSearchCounts(searchCountsFromBrowse(res.counts));
    setResults(
      hasEmptyFacetBrowse
        ? res.items.filter(isSearchableLibraryItem).map(libraryItemToRow)
        : [],
    );
  });
}
```

`LibraryItem` rows carry enough metadata for the existing result UI. Map them into the existing search row shape with neutral `snippet` and `score`, then render Type, Concept, and Priority counters from the active retrieval mode's `searchCounts`:

```tsx
<span className="filter-opt__count">{searchCounts.byType[g.type] ?? 0}</span>
<span className="filter-opt__count">{searchCounts.byConcept[c.id] ?? 0}</span>
<span className="filter-opt__count">{searchCounts.byPriority[p] ?? 0}</span>
```

## Why This Works

`library.browse` already provides main-side collection rows and facet counts without requiring a keyword. Bounding every empty-query `/search` browse request to `source`, `extract`, and `card` keeps `/search` distinct from `/library`, which can browse broader element types.

The renderer still owns only UI state. SQL, count semantics, ordering, and row enrichment stay behind the typed bridge. Cancellation guards prevent stale browse responses from overwriting later keyword searches, and clearing rows/selection at browse start prevents old facet results from lingering during pending or failed requests.

## Prevention

- Treat empty-query `/search` as a separate browse-backed mode, not as keyword search.
- Keep empty-query `/search` browse requests bounded to `source`, `extract`, and `card`, including concept-only and priority-only clicks.
- Never use global `ConceptNode.memberCount` for `/search` filterbar chips; reserve it for Map concept volume.
- Test the three retrieval states independently:

```ts
empty query + no facet -> prompt + counters + no rows
empty query + facet -> libraryBrowse({ types: ["source", "extract", "card"], ...facet })
non-empty query -> searchQuery or semanticSearch
```

- Keep renderer tests for Type, Concept, Priority, bounded non-searchable rows, stale browse responses, pending/failed facet switches, and clearing the final facet.
- Keep Electron E2E coverage for opening `/search`, verifying empty Type counters, clicking `Sources`, and clicking a seeded concept such as `Intelligence`.

## Related Issues

- `docs/solutions/ui-bugs/search-filterbar-facet-counts-after-search.md` covers the sibling keyword/semantic search count problem. This doc covers the separate empty-query browse mode.
