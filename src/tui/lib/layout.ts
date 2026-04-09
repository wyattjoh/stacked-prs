import type { StackNode, StackTree } from "../../lib/stack.ts";
import type {
  ConnectorStyle,
  GridCell,
  GridLayout,
  SyncStatus,
} from "../types.ts";

function styleFromSync(sync: SyncStatus | undefined): ConnectorStyle {
  if (sync === "behind-parent") return "dashed";
  if (sync === "diverged") return "double";
  return "solid";
}

/**
 * Walk a tree in DFS pre-order, emitting one row per branch. Every branch
 * gets a unique row — there is no "first child continues the row" behaviour,
 * so linear chains ladder downward and forks fan out on consecutive rows.
 *
 * `ancestorRails[i]` for a depth-D row encodes whether the ancestor at
 * depth (i+1) has a later sibling, i.e. whether a vertical rail runs through
 * col-group i on this row. The corner at col-group D-1 consumes its own slot,
 * so ancestorRails has length max(0, D-1).
 */
function walkTree(
  tree: StackTree,
  syncByBranch: Map<string, SyncStatus>,
  startRow: number,
  cells: GridCell[],
): number {
  let nextRow = startRow;

  const visit = (
    node: StackNode,
    depth: number,
    isLastSibling: boolean,
    ancestorRails: boolean[],
    parent: string | null,
  ): void => {
    cells.push({
      branch: node.branch,
      stackName: tree.stackName,
      row: nextRow++,
      depth,
      isLastSibling,
      hasChildren: node.children.length > 0,
      ancestorRails,
      parent,
      firstChild: node.children[0]?.branch ?? null,
      connectorStyle: styleFromSync(syncByBranch.get(node.branch)),
      ...(node.merged ? { merged: true } : {}),
    });

    // When descending from a depth-0 root, we don't append a rail entry
    // because depth-1 rows have no rail slot before the corner. From depth
    // 1 onward, each child inherits the parent's rails plus one slot
    // describing whether the parent has later siblings.
    const childBaseRails = depth >= 1 ? [...ancestorRails, !isLastSibling] : [];

    for (let i = 0; i < node.children.length; i++) {
      const childIsLast = i === node.children.length - 1;
      visit(
        node.children[i],
        depth + 1,
        childIsLast,
        childBaseRails,
        node.branch,
      );
    }
  };

  // Multiple roots in one stack are treated as independent subtrees: each
  // is rendered with isLastSibling=true so no shared rail is drawn between
  // them. This matches how they relate to the base branch, not each other.
  // Merged roots are walked first so they appear above live roots in the grid.
  const mergedRoots = tree.roots.filter((n) => n.merged);
  const liveRoots = tree.roots.filter((n) => !n.merged);
  for (const root of mergedRoots) {
    visit(root, 0, true, [], null);
  }
  for (const root of liveRoots) {
    visit(root, 0, true, [], null);
  }

  return nextRow;
}

export function buildGrid(
  trees: StackTree[],
  syncByBranch: Map<string, SyncStatus>,
): GridLayout {
  const cells: GridCell[] = [];
  let row = 0;
  for (const tree of trees) {
    row = walkTree(tree, syncByBranch, row, cells);
  }

  const byBranch = new Map<string, GridCell>();
  const byRow = new Map<number, GridCell[]>();
  const byStack = new Map<string, GridCell[]>();
  const rowsByStack = new Map<string, Set<number>>();
  let totalRows = 0;

  for (const cell of cells) {
    byBranch.set(cell.branch, cell);
    (byRow.get(cell.row) ?? byRow.set(cell.row, []).get(cell.row)!).push(cell);
    (byStack.get(cell.stackName) ??
      byStack.set(cell.stackName, []).get(cell.stackName)!).push(cell);
    (rowsByStack.get(cell.stackName) ??
      rowsByStack.set(cell.stackName, new Set()).get(cell.stackName)!).add(
        cell.row,
      );
    if (cell.row + 1 > totalRows) totalRows = cell.row + 1;
  }

  return {
    cells,
    byBranch,
    byRow,
    byStack,
    rowsByStack: new Map(
      [...rowsByStack.entries()].map((
        [k, v],
      ) => [k, [...v].sort((a, b) => a - b)]),
    ),
    totalRows,
  };
}
