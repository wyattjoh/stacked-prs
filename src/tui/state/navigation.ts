import type { Cursor, GridCell, GridLayout } from "../types.ts";

function cellFor(grid: GridLayout, cursor: Cursor): GridCell | undefined {
  return grid.byBranch.get(cursor.branch);
}

/** Cells across all stacks, ordered by monotonic row index. */
function orderedCells(grid: GridLayout): GridCell[] {
  return [...grid.cells].sort((a, b) => a.row - b.row);
}

export function moveDown(grid: GridLayout, cursor: Cursor): Cursor {
  const cell = cellFor(grid, cursor);
  if (!cell) return cursor;
  const ordered = orderedCells(grid);
  const idx = ordered.findIndex((c) => c.branch === cell.branch);
  if (idx < 0 || idx + 1 >= ordered.length) return cursor;
  return { branch: ordered[idx + 1].branch };
}

export function moveUp(grid: GridLayout, cursor: Cursor): Cursor {
  const cell = cellFor(grid, cursor);
  if (!cell) return cursor;
  const ordered = orderedCells(grid);
  const idx = ordered.findIndex((c) => c.branch === cell.branch);
  if (idx <= 0) return cursor;
  return { branch: ordered[idx - 1].branch };
}

/** Left moves to the parent branch (one level up the tree). */
export function moveLeft(grid: GridLayout, cursor: Cursor): Cursor {
  const cell = cellFor(grid, cursor);
  if (!cell || !cell.parent) return cursor;
  const parentCell = grid.byBranch.get(cell.parent);
  if (!parentCell) return cursor;
  return { branch: parentCell.branch };
}

/** Right moves to the first child branch (one level down the tree). */
export function moveRight(grid: GridLayout, cursor: Cursor): Cursor {
  const cell = cellFor(grid, cursor);
  if (!cell || !cell.firstChild) return cursor;
  const childCell = grid.byBranch.get(cell.firstChild);
  if (!childCell) return cursor;
  return { branch: childCell.branch };
}

export function moveToBranch(grid: GridLayout, branch: string): Cursor | null {
  const cell = grid.byBranch.get(branch);
  if (!cell) return null;
  return { branch: cell.branch };
}

export function moveToStack(
  grid: GridLayout,
  stackName: string,
  _current: Cursor | null,
): Cursor | null {
  const cells = grid.byStack.get(stackName);
  if (!cells || cells.length === 0) return null;
  const first = [...cells].sort((a, b) => a.row - b.row)[0];
  return { branch: first.branch };
}

export function moveToStackStart(
  grid: GridLayout,
  stackName: string,
): Cursor | null {
  return moveToStack(grid, stackName, null);
}

export function moveToStackEnd(
  grid: GridLayout,
  stackName: string,
): Cursor | null {
  const cells = grid.byStack.get(stackName);
  if (!cells || cells.length === 0) return null;
  const last = [...cells].sort((a, b) => b.row - a.row)[0];
  return { branch: last.branch };
}
