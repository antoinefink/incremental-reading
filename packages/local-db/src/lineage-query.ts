/**
 * Lineage read query (T023) — the full, navigable element hierarchy.
 *
 * The inspector's flat parent/children rows (T010) answer "what is one hop away";
 * this query answers "show me the whole chain". For ANY element it resolves the
 * lineage ROOT (the owning `source`/`topic`) and walks the tree DOWN through
 * `source → extract → sub-extract → card` via `parentId`, returning a FLATTENED,
 * depth-tagged node list the renderer renders as the kit's `LineageTree`
 * (depth-indented `tree-row`/`tree-node`, navigable in BOTH directions).
 *
 * Read-only: it performs no mutations and appends nothing to the operation log.
 * This is the seam that keeps lineage domain logic OUT of React — the renderer
 * calls `window.appApi.lineage.get(id)` and the Electron main process runs THIS
 * against the open database, handing back flat JSON-serializable nodes the
 * renderer only renders + navigates (it never re-derives the tree client-side).
 *
 * The hierarchy is modeled by `elements.parentId` (the source for a top-level
 * extract, the parent extract for a sub-extract, the extract for a card) with
 * `elements.sourceId` pointing every descendant at the lineage root. Walking
 * `parentId` (not the `derived_from` relation rows) keeps a single, total order
 * and avoids surfacing the same node twice; `derived_from`/`sourceId` agree with
 * `parentId` by construction (see `ExtractionService`).
 */

import type { Element, ElementId } from "@interleave/core";
import type { Repositories } from "./index";

/**
 * One flattened lineage node. `depth` is the indentation level from the root
 * (root = 0); `meta` is the short trailing label the kit shows (the stage for
 * extracts, the card type for cards, `"source"`/`"topic"` for roots, or
 * `"sub-extract"`). `active` marks the element the inspector is showing.
 */
export interface LineageNode {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly stage: string;
  /** Indentation depth from the lineage root (root = 0). */
  readonly depth: number;
  /** Short trailing label (stage / card type / "sub-extract" / "source"). */
  readonly meta: string;
  /** True for the element the lineage was requested for (the inspector's focus). */
  readonly active: boolean;
  /**
   * True when this node is a soft-deleted "tombstone" — a deleted ancestor kept
   * visible (only when {@link LineageGetOptions.includeTombstones} is set) so a
   * live descendant never vanishes from its own chain. Always `false` on the
   * default live-only path. Derived from `deletedAt`; no schema/status change.
   */
  readonly deleted: boolean;
}

/** Options for {@link LineageQuery.get}. */
export interface LineageGetOptions {
  /**
   * When `true`, include soft-deleted nodes as tombstones: `get` no longer
   * early-returns for a deleted focused node, `resolveRoot` walks THROUGH deleted
   * ancestors up to the live root, and `walkDown` descends into soft-deleted
   * nodes (each tagged `deleted: true`). The default (flag absent/false) path is
   * live-only and behaviorally unchanged, so yield / "review this branch" / other
   * analytics consumers are unaffected (R2).
   */
  readonly includeTombstones?: boolean;
}

/** The lineage payload for one element: the root id + the flattened tree. */
export interface LineageData {
  /** The element the lineage was requested for. */
  readonly elementId: string;
  /** The lineage root (`source`/`topic`) the tree is rooted at. */
  readonly rootId: string;
  /** Depth-ordered, flattened nodes (pre-order DFS) for the `LineageTree`. */
  readonly nodes: readonly LineageNode[];
}

/** A guard against cycles when walking `parentId` to the root (defensive). */
const MAX_WALK = 64;

/**
 * Short trailing `meta` label for a node, mirroring the design kit's `LineageTree`
 * feed (stage for extracts, card type for cards, `sub-extract` for a non-top-level
 * extract, the element type for roots).
 */
function metaFor(el: Element, isSubExtract: boolean): string {
  if (el.type === "extract") return isSubExtract ? "sub-extract" : el.stage;
  if (el.type === "card") return el.stage;
  return el.type;
}

/**
 * Read-only lineage query layer. Constructed once per open database (alongside
 * {@link Repositories} / {@link InspectorQuery}); the main process exposes its one
 * method over validated IPC. The renderer never instantiates this.
 */
export class LineageQuery {
  constructor(private readonly repos: Repositories) {}

  /**
   * The full lineage tree for one element, or `null` when the id is unknown (or
   * soft-deleted, on the default live-only path). Resolves the lineage ROOT, then
   * flattens the descendant tree (pre-order DFS, children sorted by creation
   * order) into depth-tagged nodes, marking the requested element `active`.
   *
   * By default soft-deleted nodes are skipped (they live in the trash, not the
   * lineage). With {@link LineageGetOptions.includeTombstones}, a soft-deleted
   * focused node still resolves, deleted ancestors are walked THROUGH to the live
   * root, and soft-deleted descendants are emitted as tombstones (`deleted: true`)
   * so a live element never vanishes from its own chain (R1).
   */
  get(id: ElementId, options: LineageGetOptions = {}): LineageData | null {
    const includeTombstones = options.includeTombstones ?? false;
    const { elements } = this.repos;
    const element = elements.findById(id);
    if (!element) return null;
    // Default path: a soft-deleted focus has no live lineage. With tombstones on,
    // the focused node is itself surfaced (as the active tombstone) rather than null.
    if (element.deletedAt && !includeTombstones) return null;

    const root = this.resolveRoot(element, includeTombstones);
    const nodes: LineageNode[] = [];
    this.walkDown(root, 0, id, nodes, includeTombstones);
    return { elementId: id, rootId: root.id, nodes };
  }

  /**
   * Resolve the lineage root for an element: a `source`/`topic` is its own root;
   * otherwise follow `sourceId` to the owning source, falling back to walking
   * `parentId` up to the topmost ancestor (so an element with no `sourceId` still
   * roots somewhere sensible). Defends against cycles with {@link MAX_WALK}.
   *
   * On the default path a deleted ancestor terminates the walk (live-only). With
   * `includeTombstones`, the walk passes THROUGH deleted ancestors so resolution
   * reaches the live lineage root, keeping a deleted middle's descendants under
   * their true root rather than rooting them at the tombstone (R1).
   */
  private resolveRoot(element: Element, includeTombstones: boolean): Element {
    const { elements } = this.repos;
    if (element.type === "source" || element.type === "topic") return element;

    if (element.sourceId && element.sourceId !== element.id) {
      const source = elements.findById(element.sourceId);
      // The owning source/topic is almost always live; with tombstones on we still
      // root at it even if intermediate ancestors are deleted.
      if (source && (includeTombstones || !source.deletedAt)) return source;
    }

    // No usable `sourceId` — walk `parentId` to the topmost ancestor. The default
    // path stops at the first deleted ancestor; tombstone mode walks through them.
    let current = element;
    const seen = new Set<string>([current.id]);
    for (let i = 0; i < MAX_WALK; i++) {
      if (!current.parentId || current.parentId === current.id) break;
      const parent = elements.findById(current.parentId);
      if (!parent || seen.has(parent.id)) break;
      if (parent.deletedAt && !includeTombstones) break;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  }

  /**
   * Pre-order DFS down the `parentId` tree from `node`, pushing a depth-tagged
   * {@link LineageNode} for each descendant. `activeId` marks the focused element.
   * A node is a "sub-extract" when it is an `extract` whose parent is itself an
   * `extract`. Defends against cycles via a visited set.
   *
   * Default path: only LIVE children are walked (`listChildren`) and every node is
   * `deleted: false`. With `includeTombstones`, soft-deleted children are walked
   * too (`listChildrenIncludingDeleted`) and each node carries its real
   * `deletedAt`-derived `deleted` flag so the renderer can mute the tombstones.
   */
  private walkDown(
    node: Element,
    depth: number,
    activeId: ElementId,
    out: LineageNode[],
    includeTombstones: boolean,
    visited: Set<string> = new Set(),
  ): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    const parent = node.parentId ? this.repos.elements.findById(node.parentId) : null;
    const isSubExtract = node.type === "extract" && parent?.type === "extract";
    out.push({
      id: node.id,
      type: node.type,
      title: node.title,
      stage: node.stage,
      depth,
      meta: metaFor(node, isSubExtract),
      active: node.id === activeId,
      deleted: node.deletedAt != null,
    });

    // Direct children (sorted by createdAt ≈ creation order for determinism). The
    // default path keeps live-only; tombstone mode includes soft-deleted children.
    const children = (
      includeTombstones
        ? this.repos.elements.listChildrenIncludingDeleted(node.id)
        : this.repos.elements.listChildren(node.id)
    )
      .filter((c) => c.id !== node.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    for (const child of children) {
      this.walkDown(child, depth + 1, activeId, out, includeTombstones, visited);
    }
  }
}
