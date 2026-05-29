/**
 * LineageTree component test (T023).
 *
 * The tree itself is presentational — the flattened, depth-tagged nodes are
 * computed in `packages/local-db` and cross IPC (covered by the LineageQuery
 * Vitest there). Here we assert the renderer seam:
 *  - it renders one row per node, depth-indented, with the active node marked;
 *  - clicking a node fires `onPick` with that node (the bidirectional-navigation
 *    hinge the inspector wires to selection + `/source/$id`).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LineageNode } from "../../lib/appApi";
import { LineageTree } from "./LineageTree";

/** A source → extract → sub-extract chain as the main process would flatten it. */
const NODES: readonly LineageNode[] = [
  {
    id: "src-1",
    type: "source",
    title: "On the Measure of Intelligence",
    stage: "raw_source",
    depth: 0,
    meta: "source",
    active: false,
  },
  {
    id: "ext-1",
    type: "extract",
    title: "Intelligence = skill-acquisition efficiency",
    stage: "atomic_statement",
    depth: 1,
    meta: "atomic_statement",
    active: true,
  },
  {
    id: "sub-1",
    type: "extract",
    title: "Must control for priors and experience",
    stage: "raw_extract",
    depth: 2,
    meta: "sub-extract",
    active: false,
  },
];

describe("LineageTree", () => {
  it("renders one node per row with the active node highlighted", () => {
    render(<LineageTree nodes={NODES} onPick={() => {}} />);
    const rows = screen.getAllByTestId("lineage-tree-node");
    expect(rows).toHaveLength(3);

    // The active extract carries the `--on` highlight + aria-current.
    const active = rows.find((r) => r.getAttribute("data-element-id") === "ext-1");
    expect(active?.getAttribute("data-active")).toBe("true");
    expect(active?.className).toContain("tree-node--on");

    // A non-active node is not highlighted.
    const source = rows.find((r) => r.getAttribute("data-element-id") === "src-1");
    expect(source?.getAttribute("data-active")).toBe("false");
    expect(source?.className).not.toContain("tree-node--on");
  });

  it("indents each node by its depth (the kit's vertical guide spacers)", () => {
    const { container } = render(<LineageTree nodes={NODES} onPick={() => {}} />);
    const rows = container.querySelectorAll(".tree-row");
    // depth 0 → 0 indents, depth 1 → 1 indent, depth 2 → 2 indents.
    expect(rows[0]?.querySelectorAll(".tree-indent")).toHaveLength(0);
    expect(rows[1]?.querySelectorAll(".tree-indent")).toHaveLength(1);
    expect(rows[2]?.querySelectorAll(".tree-indent")).toHaveLength(2);
  });

  it("renders the faint meta suffix for each node", () => {
    render(<LineageTree nodes={NODES} onPick={() => {}} />);
    expect(screen.getByText("sub-extract")).toBeInTheDocument();
    expect(screen.getByText("source")).toBeInTheDocument();
  });

  it("fires onPick with the clicked node (bidirectional navigation)", () => {
    const onPick = vi.fn();
    render(<LineageTree nodes={NODES} onPick={onPick} />);

    // Click the source node (navigating UP the chain from the active extract).
    const source = screen
      .getAllByTestId("lineage-tree-node")
      .find((r) => r.getAttribute("data-element-id") === "src-1");
    expect(source).toBeDefined();
    if (source) fireEvent.click(source);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "src-1", type: "source" }));

    // Click the sub-extract node (navigating DOWN the chain).
    const sub = screen
      .getAllByTestId("lineage-tree-node")
      .find((r) => r.getAttribute("data-element-id") === "sub-1");
    if (sub) fireEvent.click(sub);
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ id: "sub-1" }));
  });
});
