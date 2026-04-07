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
 * Walk a single tree and emit cells. The first visited branch at each forking
 * point continues the current row; subsequent siblings each drop to a fresh
 * row whose column aligns with the sibling's own depth.
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
    row: number,
    col: number,
    parentCol: number | null,
    isForkRow: boolean,
  ): void => {
    cells.push({
      branch: node.branch,
      stackName: tree.stackName,
      row,
      col,
      parentCol,
      connectorStyle: styleFromSync(syncByBranch.get(node.branch)),
      isForkRow,
    });

    if (node.children.length === 0) return;

    // First child continues this row.
    visit(node.children[0], row, col + 1, col, isForkRow);

    // Additional children become fork sub-rows.
    for (let i = 1; i < node.children.length; i++) {
      nextRow = Math.max(nextRow, row) + 1;
      visit(node.children[i], nextRow, col + 1, col, true);
    }
  };

  for (const root of tree.roots) {
    visit(root, nextRow, 0, null, false);
    nextRow += 1;
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
    const endRow = walkTree(tree, syncByBranch, row, cells);
    row = endRow + 1;
  }

  const byBranch = new Map<string, GridCell>();
  const byRow = new Map<number, GridCell[]>();
  const byStack = new Map<string, GridCell[]>();
  const rowsByStack = new Map<string, Set<number>>();
  let totalCols = 0;
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
    if (cell.col + 1 > totalCols) totalCols = cell.col + 1;
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
    totalCols,
  };
}
