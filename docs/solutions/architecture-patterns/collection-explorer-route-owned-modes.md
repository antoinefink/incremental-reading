---
title: Route-owned Collection Explorer modes with URL handoff
date: 2026-06-06
category: architecture-patterns
module: collection-explorer
problem_type: architecture_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Two routes present adjacent modes over the same domain but use different backend contracts."
  - "Mode switches need to preserve compatible UI filters without durable mode memory."
  - "One mode has pending constraints while another mode has immediately active filters."
tags: [collection-explorer, library, search, url-state, route-state, renderer, react]
---

# Route-owned Collection Explorer modes with URL handoff

## Context

Library and Search both explore the user's collection, but they answer different questions:

- Browse mode asks what exists and calls `library.browse` over browsable element types.
- Search mode asks what matches a keyword and calls `search.query` or `semantic.search` over indexed source, extract, and card content.

The integration risk was treating these as one remembered local mode. That would let stale local state override route intent, make `/search` inherit old filters, or make `/library` stay narrowed after a plain Library navigation.

## Guidance

Keep the route as the source of truth for mode, and use URL search params only as a handoff channel for compatible state.

Use small shared primitives for the cross-mode contract:

- a shared mode switch control,
- a shared parser/builder for compatible URL params,
- explicit Search/Browse route effects that reconcile local state when route params change.

Do not merge the retrieval effects when the backend contracts are meaningfully different. In this case, Search and Browse stay clearer as separate route screens because Search has keyword/semantic behavior and pending constraints, while Browse has all live browsable types, status facets, and local title filtering.

## Why This Matters

Route-owned mode prevents same-route navigation bugs:

- `/search?q=memory&type=card` followed by a plain `/search` must clear query and filters.
- `/library?type=topic&status=scheduled` followed by a plain `/library` must return to unfiltered browse inventory.
- Search commands should focus Search with route intent, not resurrect whatever the user last selected.

URL handoff also makes compatibility explicit. Browse-only fields such as `status` and non-searchable types such as `topic` are dropped when moving to Search. Shared fields such as Concept and Priority are preserved.

## When to Apply

- Use this pattern when two routes share a product area but remain semantically distinct modes.
- Use URL params for transient route-to-route handoff when a reloadable deep link is useful.
- Keep local component state for ephemeral UI only, such as row selection, loading state, and local visible-title filtering.
- Avoid durable "last mode" persistence unless the product explicitly wants route intent to be secondary.

## Examples

The shared state helper should normalize the handoff:

```ts
explorerSearchParams("search", {
  query: "memory",
  type: "topic",
  conceptId: "concept-1",
  priority: "A",
});
// => { q: "memory", conceptId: "concept-1", priority: "A" }
// `topic` is dropped because Search only supports source/extract/card.
```

Each route screen should then reconcile local state from the route params:

```ts
useEffect(() => {
  setRawQuery(routeQuery);
  setDebouncedQuery(routeQuery);
  setTypeFilter(routeType);
  setConceptFilter(routeConceptId);
  setPriorityFilter(routePriority);
  setSelId(null);
  searchInputRef.current?.focus();
}, [routeQuery, routeType, routeConceptId, routePriority]);
```

Pending Search constraints need distinct UI treatment. A selected Concept with an empty query is not filtering visible rows yet; it is a pending constraint that applies when the user types. Style and copy should say that directly instead of reusing the same active-filter presentation as Browse rows.

## Related

- `docs/brainstorms/2026-06-06-collection-explorer-requirements.md`
- `docs/plans/2026-06-06-collection-explorer.md`
- `docs/solutions/ui-bugs/search-empty-query-facets-browse-rows.md`
- `docs/solutions/ui-bugs/search-filterbar-facet-counts-after-search.md`
