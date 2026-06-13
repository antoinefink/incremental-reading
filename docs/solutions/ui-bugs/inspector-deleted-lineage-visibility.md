---
title: "Hide Inspector deleted lineage without losing restore"
date: "2026-06-13"
category: "docs/solutions/ui-bugs/"
module: "apps/web inspector lineage"
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Deleted lineage tombstones were visible by default in the Inspector."
  - "Restore controls for deleted lineage were visually too prominent and inconsistent in height."
  - "Ancestor-deleted hints could be based on earlier deleted siblings rather than true depth ancestors."
  - "Stale lineage could remain visible while switching selected elements."
root_cause: scope_issue
resolution_type: code_fix
severity: medium
related_components:
  - "testing_framework"
tags:
  - "inspector"
  - "lineage"
  - "deleted-elements"
  - "tombstones"
  - "restore-ui"
  - "react"
---

# Hide Inspector deleted lineage without losing restore

## Problem

Deleted lineage tombstones were always rendered in the Inspector lineage tree. That preserved recoverability, but made deleted elements visually compete with live lineage and made normal card or extract inspection feel dominated by deletion state.

## Symptoms

- Live cards under a deleted ancestor showed tombstone rows immediately, even when the user was not trying to inspect deleted material.
- The "ancestor deleted" hint appeared by default, making deleted lineage feel like the primary state.
- The tombstone row `Restore` and ancestor-hint `Restore` controls had mismatched height and visual weight.
- Switching selected elements could briefly show stale lineage from the previously selected element.
- Earlier deleted siblings could be mistaken for deleted ancestors when ancestor detection looked only at deleted rows before the active row.

## What Didn't Work

- Always requesting and rendering tombstone-aware lineage solved recoverability, but made deleted rows too prominent.
- Filtering deleted rows without depth normalization left live descendants visually indented under missing parents.
- Counting deleted rows before the active row was too broad: a previous deleted sibling is not an ancestor.
- Keeping lineage state while a new selection loaded allowed old lineage to appear under the new Inspector body.
- Styling restore buttons as regular pills made them heavier than the compact lineage UI needed.

## Solution

Keep the data tombstone-aware, but make the UI opt-in. The Inspector still requests tombstones:

```ts
appApi.getLineage({ id: selectedId, includeTombstones: true });
```

Render deleted nodes only when the current element has matching lineage and the user has opened the Lineage header toggle:

```ts
const currentLineage = lineage?.elementId === element.id ? lineage : null;

const showDeletedLineage =
  lineageDeletedVisibility?.elementId === element.id
    ? lineageDeletedVisibility.showDeleted
    : false;
```

Derive the visible tree with depth normalization so hidden tombstones do not leave indentation gaps:

```ts
function visibleLineageNodes(nodes: readonly LineageNode[], showDeleted: boolean) {
  if (showDeleted) return nodes;

  const visible: LineageNode[] = [];
  const deletedDepths: number[] = [];

  for (const node of nodes) {
    while (deletedDepths.length > 0 && node.depth <= (deletedDepths.at(-1) ?? -1)) {
      deletedDepths.pop();
    }
    if (node.deleted) {
      deletedDepths.push(node.depth);
      continue;
    }
    visible.push({ ...node, depth: Math.max(0, node.depth - deletedDepths.length) });
  }

  return visible;
}
```

Detect deleted ancestors with the flattened tree's depth stack, not with list order alone:

```ts
function deletedAncestorCount(nodes: readonly LineageNode[]): number {
  const stack: LineageNode[] = [];
  for (const node of nodes) {
    while (stack.length > node.depth) stack.pop();
    if (node.active) return stack.filter((ancestor) => ancestor.deleted).length;
    stack[node.depth] = node;
  }
  return 0;
}
```

Guard stale lineage by clearing it at selection fetch start, accepting lineage only for the current selection, and keying the Inspector body by element id:

```tsx
setLineage(null);

if (!cancelled && selectedIdRef.current === selectedId) {
  setLineage(res.lineage);
}

<InspectorBody key={data.element.id} ... />
```

Make both Restore controls compact and equal-height using design tokens:

```css
.tree-node__restore,
.insp-jump--lineage-restore {
  height: var(--s-7);
  padding: 0 var(--s-1);
  box-sizing: border-box;
  line-height: 1;
  background: transparent;
  border-color: transparent;
}
```

Expose a stable `data-depth` on lineage nodes so tests can assert normalized visible depth without coupling to spacer DOM structure.

## Why This Works

The Inspector still has enough lineage data to offer recovery, count deleted nodes, and restore ancestor chains, but live reading stays visually live-first. The Lineage header toggle makes deleted-lineage inspection explicit user intent.

Depth normalization preserves the apparent tree shape after hidden deleted ancestors are removed. A live card under a hidden deleted extract shifts from depth `2` to visible depth `1`, so the UI does not imply a missing row.

The `currentLineage` element-id guard prevents lineage fetched for one selection from rendering under another. Keying the body by element id also prevents per-element reveal state from surviving an element round trip.

The depth-stack ancestor check matches the tree model: only nodes currently on the active node's ancestry count. Deleted siblings and cousins no longer trigger ancestor restore hints.

Compact tokenized restore controls keep tombstone recovery available without visually overpowering the lineage row.

## Prevention

- For tombstone-aware reads, separate data availability from default visibility. Fetch enough to recover; render deleted state only behind an explicit toggle.
- Any filtered tree display must normalize depth after removing ancestors.
- For flattened tree ancestor logic, use a depth stack. Do not infer ancestry from list order alone.
- Async lineage state must be keyed to the requested element id before rendering.
- E2E coverage should include restart persistence for restore flows and visual measurements for compact controls.

## Related Issues

- [Lineage-aware deletion tombstone and purge guard](../architecture-patterns/lineage-aware-deletion-tombstone-purge-guard.md) — canonical tombstone-and-keep, ancestor-chain restore, and lineage deletion rules.
- [SQLite table rebuild with foreign keys on fires ON DELETE actions](../database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md) — prior lineage-loss failure mode and why source lineage needs explicit protection.
- [Extract inspector single responsibility lineage scheduler](extract-inspector-single-responsibility-lineage-scheduler.md) — Inspector ownership and stale async guard patterns.
- [Active card rows open card detail surface](active-card-rows-open-card-detail-surface.md) — related Inspector lineage/source redaction and stale selection guard patterns.
