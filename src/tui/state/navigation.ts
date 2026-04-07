import type { Cursor, GridCell, GridLayout } from "../types.ts";

function cellFor(grid: GridLayout, cursor: Cursor): GridCell | undefined {
  return grid.byBranch.get(cursor.branch);
}

/** Sorted list of rows that have any cells. */
function rowsWithCells(grid: GridLayout): number[] {
  return [...grid.byRow.keys()].sort((a, b) => a - b);
}

export function moveRight(grid: GridLayout, cursor: Cursor): Cursor {
  const cell = cellFor(grid, cursor);
  if (!cell) return cursor;
  const row = grid.byRow.get(cell.row) ?? [];
  const next = row.find((c) => c.col === cell.col + 1);
  if (!next) return cursor;
  return { branch: next.branch, preferredCol: next.col };
}

export function moveLeft(grid: GridLayout, cursor: Cursor): Cursor {
  const cell = cellFor(grid, cursor);
  if (!cell) return cursor;
  const row = grid.byRow.get(cell.row) ?? [];
  const next = row.find((c) => c.col === cell.col - 1);
  if (!next) return cursor;
  return { branch: next.branch, preferredCol: next.col };
}

function moveVertical(
  grid: GridLayout,
  cursor: Cursor,
  direction: 1 | -1,
): Cursor {
  const cell = cellFor(grid, cursor);
  if (!cell) return cursor;
  const rows = rowsWithCells(grid);
  const idx = rows.indexOf(cell.row);
  if (idx < 0) return cursor;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= rows.length) return cursor;
  const targetRow = grid.byRow.get(rows[targetIdx]) ?? [];
  if (targetRow.length === 0) return cursor;

  // Pick cell with largest col <= preferredCol. If none qualify, land on the
  // last cell of the row.
  const sorted = [...targetRow].sort((a, b) => a.col - b.col);
  let picked: GridCell = sorted[sorted.length - 1];
  for (const c of sorted) {
    if (c.col <= cursor.preferredCol) picked = c;
  }
  return { branch: picked.branch, preferredCol: cursor.preferredCol };
}

export function moveDown(grid: GridLayout, cursor: Cursor): Cursor {
  return moveVertical(grid, cursor, 1);
}

export function moveUp(grid: GridLayout, cursor: Cursor): Cursor {
  return moveVertical(grid, cursor, -1);
}

export function moveToBranch(grid: GridLayout, branch: string): Cursor | null {
  const cell = grid.byBranch.get(branch);
  if (!cell) return null;
  return { branch: cell.branch, preferredCol: cell.col };
}

export function moveToStack(
  grid: GridLayout,
  stackName: string,
  _current: Cursor | null,
): Cursor | null {
  const cells = grid.byStack.get(stackName);
  if (!cells || cells.length === 0) return null;
  const first = [...cells].sort(
    (a, b) => a.row - b.row || a.col - b.col,
  )[0];
  return { branch: first.branch, preferredCol: first.col };
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
  const last = [...cells].sort(
    (a, b) => b.row - a.row || b.col - a.col,
  )[0];
  return { branch: last.branch, preferredCol: last.col };
}
