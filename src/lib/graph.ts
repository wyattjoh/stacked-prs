/**
 * Lane (column) layout for branch trees, shared by the CLI status ladder and
 * the browser serve view so both place forks the same way.
 *
 * The placement rule: a node's first child continues the node's lane, and every
 * additional child branches one lane to the right. Because a branching child's
 * whole subtree is emitted contiguously next to its parent, fork connectors only
 * ever span a single adjacent column, so the rendered graph never has crossing
 * lines, in either orientation.
 */

/** A tree node consumed by the lane layout. */
export interface LaneTreeNode<T> {
  value: T;
  children: LaneTreeNode<T>[];
  /**
   * When set, the node has no primary child: every child branches into its own
   * lane. Used for synthetic container nodes (e.g. a repository heading) that
   * must not continue a child inline.
   */
  indentChildren?: boolean;
}

/**
 * Row emission order. "leaf-first" matches the CLI ladder (children above their
 * parent, base at the bottom); "parent-first" reads top-down from the base
 * (used by the browser serve view). The two are per-tree reverses of each
 * other and assign identical lanes.
 */
export type LaneOrientation = "leaf-first" | "parent-first";

/** One laid-out row: a node placed in a lane (column). */
export interface LaneRow<T> {
  value: T;
  /** Column the node's marker sits in. */
  lane: number;
  /** Index of the root tree this row descends from. */
  rootIndex: number;
  /** True when the node has one or more branching (non-primary) children. */
  isFork: boolean;
  /** Lane of each branching child (always lane + 1). */
  forkLanes: number[];
}

export interface LaneLayoutOptions {
  orientation?: LaneOrientation;
  /** Starting lane for the root at the given index. Defaults to 0. */
  rootLane?: (rootIndex: number) => number;
}

export interface LaneLayout<T> {
  rows: LaneRow<T>[];
  maxLane: number;
}

/**
 * Lay out a forest of trees into lanes. See the module comment for the rule and
 * the no-crossings guarantee.
 */
export function layoutLanes<T>(
  roots: LaneTreeNode<T>[],
  options: LaneLayoutOptions = {},
): LaneLayout<T> {
  const orientation = options.orientation ?? "leaf-first";
  const rootLane = options.rootLane ?? (() => 0);
  const rows: LaneRow<T>[] = [];

  const visit = (
    node: LaneTreeNode<T>,
    lane: number,
    rootIndex: number,
  ): void => {
    const primary = node.indentChildren ? undefined : node.children[0];
    const secondary = node.indentChildren
      ? node.children
      : node.children.slice(1);
    const row: LaneRow<T> = {
      value: node.value,
      lane,
      rootIndex,
      isFork: secondary.length > 0,
      forkLanes: secondary.map(() => lane + 1),
    };

    if (orientation === "parent-first") {
      rows.push(row);
      // Secondary subtrees in reverse so each branching child sits directly
      // below its parent (the per-tree reverse of the leaf-first order).
      for (let i = secondary.length - 1; i >= 0; i--) {
        visit(secondary[i], lane + 1, rootIndex);
      }
      if (primary) visit(primary, lane, rootIndex);
      return;
    }

    if (primary) visit(primary, lane, rootIndex);
    for (const child of secondary) visit(child, lane + 1, rootIndex);
    rows.push(row);
  };

  for (let i = 0; i < roots.length; i++) {
    visit(roots[i], rootLane(i), i);
  }

  const maxLane = rows.reduce((max, row) => Math.max(max, row.lane), 0);
  return { rows, maxLane };
}
