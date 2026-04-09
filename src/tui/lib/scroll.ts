import type { GridLayout } from "../types.ts";

/**
 * Pure layout math for the stack-map vertical scroll. Keeping this outside
 * `app.tsx` lets the behavior be unit-tested against synthetic grids without
 * spinning up Ink, and guarantees the cursor-visibility invariant is
 * regression-checked on every commit.
 *
 * # Line model
 *
 * The stack-map renders rows in this order (matching `StackMap` and
 * `StackBand`):
 *
 * ```
 *   0: shared base-branch label (e.g. "main")   ← only if any stack visible
 *   1: initial trunk row                         ← only if any stack visible
 *   2: stack A header
 *   3: gap row                                   ← only when merged cells exist
 *   4: merged cell 0 name                        ← only when merged cells exist
 *   5: merged cell 0 info
 *   6: gap row                                   ← only when both merged and live cells
 *   7: live cell 0 name
 *   8: live cell 0 info
 *   9: live cell 0 → 1 rail                      ← only between live cells
 *  10: live cell 1 name
 *   ...
 *   N: live cell last info                       ← no trailing rail
 *   N+1: gap row                                 ← only between stacks
 *   N+2: stack B header
 *   ...
 * ```
 *
 * Each branch cell is **2** lines tall (name + info). Between two cells in
 * the same stack, there is **1** inter-cell rail row. Between two stacks
 * there is **1** gap row.
 *
 * # Scroll policy
 *
 * Let `[scrollY, scrollY + viewportHeight)` be the visible row range and
 * `[cursorY, cursorY + 2)` be the cursor's 2-line row. The policy here
 * guarantees that the cursor's rows are **always fully inside the visible
 * range** after this function runs, for any viewport height `≥ 2`.
 *
 * - Scrolling **up** snaps to `max(0, headerY - 2)` so the stack header plus
 *   two rows of context above it stay on screen. For the first stack that
 *   context is the shared `main` label + initial trunk row.
 * - Scrolling **down** moves minimally to keep the cursor's 2-line row in
 *   view. Tall stacks that exceed the viewport let the header scroll off
 *   the top.
 * - In both directions, if the "nice" target would hide the cursor (stack
 *   longer than the viewport, tiny viewport, etc.), the function falls
 *   back to cursor-only visibility: `scrollY = cursorBottom - viewportHeight`.
 *
 * This ensures the invariant `cursor fully visible` holds for any valid
 * input, which is the property users rely on during navigation.
 */
export interface ScrollInput {
  /** Ordered stacks currently rendered (after tab filtering). */
  visibleStacks: string[];
  /** Grid with all cells; only cells in `visibleStacks` are counted. */
  grid: GridLayout;
  /** Branch the cursor is on. If not in any visible stack, returns `prev`. */
  cursorBranch: string;
  /** Current stack-map viewport height in rows. Clamped to `≥ 2` internally. */
  viewportHeight: number;
  /** Previous scroll offset (used to prefer minimal movement). */
  prev: number;
}

export interface ScrollLayout {
  /** y coordinate of the cursor's first row, or `-1` if not found. */
  cursorY: number;
  /** y coordinate of the cursor's stack header row, or `-1` if not found. */
  headerY: number;
  /** Total rendered content height for the visible stacks. */
  contentHeight: number;
}

/**
 * Walk the visible stacks and compute y positions without any scroll math.
 * Exposed so tests can assert the line model directly.
 */
export function measureLayout(
  visibleStacks: string[],
  grid: GridLayout,
  cursorBranch: string,
): ScrollLayout {
  let y = 0;
  let cursorY = -1;
  let headerY = -1;
  if (visibleStacks.length > 0) {
    y += 2; // base-branch label + initial trunk row
  }
  for (let s = 0; s < visibleStacks.length; s++) {
    const stack = visibleStacks[s];
    const allCells = [...(grid.byStack.get(stack) ?? [])]
      .sort((a, b) => a.row - b.row);
    const mergedCells = allCells.filter((c) => c.merged);
    const liveCells = allCells.filter((c) => !c.merged);
    const thisHeaderY = y;
    y += 1; // stack header

    if (mergedCells.length > 0) {
      y += 1; // gap row after header
      for (const cell of mergedCells) {
        if (cell.branch === cursorBranch) {
          cursorY = y;
          headerY = thisHeaderY;
        }
        y += 2; // name + info (no rail between merged cells)
      }
      if (liveCells.length > 0) {
        y += 1; // gap row before live section
      }
    }

    for (let i = 0; i < liveCells.length; i++) {
      if (liveCells[i].branch === cursorBranch) {
        cursorY = y;
        headerY = thisHeaderY;
      }
      y += 2; // name + info
      if (i < liveCells.length - 1) {
        y += 1; // inter-cell rail
      }
    }

    if (s < visibleStacks.length - 1) {
      y += 1; // gap row between stacks
    }
  }
  return { cursorY, headerY, contentHeight: y };
}

/**
 * Compute the next `scrollY` so that the cursor's 2-line row is fully
 * visible in the stack-map viewport. Returns `prev` unchanged when the
 * cursor is not in any visible stack or when no scrolling is needed.
 */
export function computeScrollY(input: ScrollInput): number {
  const viewportHeight = Math.max(2, input.viewportHeight);
  const { cursorY, headerY, contentHeight } = measureLayout(
    input.visibleStacks,
    input.grid,
    input.cursorBranch,
  );
  if (cursorY < 0) {
    return clampScroll(input.prev, contentHeight, viewportHeight);
  }
  const cursorBottom = cursorY + 2;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);

  // Cursor above current viewport: snap up to header context, falling back
  // to cursor-visible if the context target would hide the cursor.
  if (cursorY < input.prev) {
    const target = Math.max(0, headerY - 2);
    if (cursorBottom - target > viewportHeight) {
      return clamp(cursorBottom - viewportHeight, 0, maxScroll);
    }
    return clamp(target, 0, maxScroll);
  }

  // Cursor below current viewport: scroll down just enough to reveal it.
  if (cursorBottom > input.prev + viewportHeight) {
    return clamp(cursorBottom - viewportHeight, 0, maxScroll);
  }

  // Already inside the viewport: stay put, but clamp to legal range in
  // case the viewport grew and exposed empty space below.
  return clamp(input.prev, 0, maxScroll);
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function clampScroll(
  prev: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  return clamp(prev, 0, maxScroll);
}

/**
 * Horizontal column of a branch name's left edge inside the stack-map
 * content. Must match `StackMap` + `StackBand` rendering:
 *
 * - `contentPrefix` adds `stackCount * 3` columns of trunk filler.
 * - `topPrefix` adds `cell.depth * 3` columns of ladder rails + corner.
 *
 * The branch name then starts at `stackCount * 3 + cell.depth * 3`.
 * This helper exists so the scroll-X math in `app.tsx` and the
 * content-width math in `stack-map.tsx` cannot drift.
 */
export function branchNameContentX(
  stackCount: number,
  depth: number,
): number {
  return stackCount * 3 + depth * 3;
}

export interface ScrollXInput {
  /** Content x of the cursor branch name's left edge. */
  cursorX: number;
  /** Length of the cursor branch name (right edge = cursorX + cursorWidth). */
  cursorWidth: number;
  /** Terminal width reserved for the stack-map viewport. */
  viewportWidth: number;
  /** Previous horizontal scroll offset. */
  prev: number;
}

/**
 * Compute the next `scrollX` so that the cursor branch name is fully
 * visible horizontally in the stack-map viewport. Returns `prev` unchanged
 * when the cursor row already fits.
 *
 * Policy:
 * - If the cursor's **left** edge is off the left side, snap scrollX to
 *   `cursorX` so the name starts at frame column 0.
 * - If the cursor's **right** edge is off the right side, scroll right
 *   just enough to reveal it (`cursorX + cursorWidth - viewportWidth`).
 * - Otherwise keep `prev` so navigation through equal-or-narrower rows
 *   doesn't cause jittery horizontal scroll.
 */
export function computeScrollX(input: ScrollXInput): number {
  const right = input.cursorX + input.cursorWidth;
  if (input.cursorX < input.prev) {
    return Math.max(0, input.cursorX);
  }
  if (right > input.prev + input.viewportWidth) {
    return Math.max(0, right - input.viewportWidth);
  }
  return input.prev;
}
