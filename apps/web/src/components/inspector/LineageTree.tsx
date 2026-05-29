/**
 * LineageTree (T023) — the navigable element hierarchy, rebuilt from the design
 * kit's `LineageTree` (`design/kit/app/components.jsx`) for React 19.
 *
 * Renders the FLATTENED, depth-tagged nodes the main process computes
 * (`lineage.get`) as depth-indented `tree-row`/`tree-indent`/`tree-node` rows —
 * `source → extract → sub-extract → card`, navigable in BOTH directions. The whole
 * tree is computed in `packages/local-db` and crosses IPC as flat nodes; this
 * component ONLY renders + navigates (no lineage logic, no SQL — per the layering
 * rules). Clicking a node re-selects that element (driving the inspector) and, for
 * sources, navigates the reader to `/source/$id`.
 *
 * Pixel-for-pixel with the kit: a `tree-indent` spacer per depth level (the
 * vertical guide line), the `TypeIcon`, a truncated title, the active node's
 * `tree-node--on` accent highlight, and a faint mono `meta` suffix.
 */

import type { LineageNode } from "../../lib/appApi";
import { TypeIcon } from "./primitives";

/** Render an array of depth-tagged lineage nodes as the kit's `LineageTree`. */
export function LineageTree({
  nodes,
  onPick,
}: {
  readonly nodes: readonly LineageNode[];
  /** Called with the picked node; the caller re-selects + navigates. */
  onPick: (node: LineageNode) => void;
}) {
  return (
    <div className="tree" data-testid="lineage-tree">
      {nodes.map((n) => (
        <div className="tree-row" key={n.id}>
          {/* One indent spacer per depth level (the kit's vertical guide line). */}
          {Array.from({ length: n.depth }).map((_, d) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: pure spacers, count == depth
            <span className="tree-indent" key={d} aria-hidden />
          ))}
          <button
            type="button"
            className={`tree-node${n.active ? " tree-node--on" : ""}`}
            data-testid="lineage-tree-node"
            data-element-id={n.id}
            data-element-type={n.type}
            data-active={n.active ? "true" : "false"}
            aria-current={n.active ? "true" : undefined}
            onClick={() => onPick(n)}
          >
            <TypeIcon type={n.type} />
            <span className="tree-node__title">{n.title}</span>
            {n.meta ? <span className="tree-node__meta">{n.meta}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
