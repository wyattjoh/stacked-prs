import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { StackTree } from "../../lib/stack.ts";
import { buildGrid } from "./layout.ts";
import {
  branchNameContentX,
  computeScrollX,
  computeScrollY,
  measureLayout,
} from "./scroll.ts";

function linearStack(name: string, depth: number): StackTree {
  // deno-lint-ignore no-explicit-any
  let node: any = null;
  for (let i = depth - 1; i >= 0; i--) {
    const branch = `${name}/${i}`;
    const parent = i === 0 ? "main" : `${name}/${i - 1}`;
    node = { branch, stackName: name, parent, children: node ? [node] : [] };
  }
  return {
    stackName: name,
    baseBranch: "main",
    mergeStrategy: "merge",
    roots: [node],
  };
}

function gridOf(trees: StackTree[]) {
  return buildGrid(trees, new Map());
}

/**
 * Invariant the UI depends on: after `computeScrollY`, the cursor's
 * 2-line row must be fully inside `[scrollY, scrollY + viewportHeight)`.
 */
function expectCursorVisible(opts: {
  visibleStacks: string[];
  grid: ReturnType<typeof gridOf>;
  cursorBranch: string;
  viewportHeight: number;
  prev: number;
}) {
  const scrollY = computeScrollY(opts);
  const { cursorY } = measureLayout(
    opts.visibleStacks,
    opts.grid,
    opts.cursorBranch,
  );
  const top = scrollY;
  const bottom = scrollY + opts.viewportHeight;
  expect(cursorY).toBeGreaterThanOrEqual(0);
  // Cursor row occupies [cursorY, cursorY+2).
  expect(cursorY).toBeGreaterThanOrEqual(top);
  expect(cursorY + 2).toBeLessThanOrEqual(bottom);
  return scrollY;
}

describe("measureLayout", () => {
  test("linear stack: y positions follow the 2-lines + rail cadence", () => {
    const grid = gridOf([linearStack("s", 3)]);
    const l0 = measureLayout(["s"], grid, "s/0");
    const l1 = measureLayout(["s"], grid, "s/1");
    const l2 = measureLayout(["s"], grid, "s/2");
    // 2 (main + trunk) + 1 (header) = first cell at y=3
    expect(l0.cursorY).toBe(3);
    // next cell = prev (3) + 2 (name+info) + 1 (rail) = 6
    expect(l1.cursorY).toBe(6);
    expect(l2.cursorY).toBe(9);
    // contentHeight = 9 + 2 (last cell name+info) = 11 (no trailing rail)
    expect(l0.contentHeight).toBe(11);
  });

  test("two stacks: gap row + second stack header counted", () => {
    const grid = gridOf([linearStack("a", 2), linearStack("b", 2)]);
    const la = measureLayout(["a", "b"], grid, "a/1");
    const lb0 = measureLayout(["a", "b"], grid, "b/0");
    const lb1 = measureLayout(["a", "b"], grid, "b/1");
    // a/0 at 3, a/1 at 6
    expect(la.cursorY).toBe(6);
    // a has 2 cells: header(1) + 2+1+2 = 6 content rows → stack a ends at
    // y = 2 + 1 + (2 + 1 + 2) = 8. Then gap(1) so b header at y=9, b/0 at 10.
    expect(lb0.cursorY).toBe(10);
    expect(lb1.cursorY).toBe(13);
  });

  test("cursor not in visible stacks returns cursorY = -1", () => {
    const grid = gridOf([linearStack("a", 2), linearStack("b", 2)]);
    const l = measureLayout(["b"], grid, "a/0");
    expect(l.cursorY).toBe(-1);
  });
});

describe("computeScrollY", () => {
  test("cursor at top: no scroll needed", () => {
    const grid = gridOf([linearStack("s", 3)]);
    const y = computeScrollY({
      visibleStacks: ["s"],
      grid,
      cursorBranch: "s/0",
      viewportHeight: 10,
      prev: 0,
    });
    expect(y).toBe(0);
  });

  test("cursor below viewport scrolls down to reveal it", () => {
    const grid = gridOf([linearStack("s", 10)]);
    // cursor is the last branch; with a 5-row viewport it must scroll.
    const y = computeScrollY({
      visibleStacks: ["s"],
      grid,
      cursorBranch: "s/9",
      viewportHeight: 5,
      prev: 0,
    });
    const { cursorY, contentHeight } = measureLayout(["s"], grid, "s/9");
    // Cursor bottom = cursorY + 2; scroll = cursorBottom - viewportHeight.
    const expected = Math.min(
      Math.max(0, cursorY + 2 - 5),
      Math.max(0, contentHeight - 5),
    );
    expect(y).toBe(expected);
    expectCursorVisible({
      visibleStacks: ["s"],
      grid,
      cursorBranch: "s/9",
      viewportHeight: 5,
      prev: 0,
    });
  });

  test("cursor above viewport scrolls up to header context", () => {
    const grid = gridOf([linearStack("s", 10)]);
    const { cursorY, headerY } = measureLayout(["s"], grid, "s/2");
    // Pretend the user had scrolled all the way down.
    const prev = 20;
    const y = computeScrollY({
      visibleStacks: ["s"],
      grid,
      cursorBranch: "s/2",
      viewportHeight: 12,
      prev,
    });
    // With viewport 12, target = max(0, headerY-2) should fit cursor + context.
    expect(y).toBeLessThan(prev);
    expect(y).toBeLessThanOrEqual(cursorY);
    expectCursorVisible({
      visibleStacks: ["s"],
      grid,
      cursorBranch: "s/2",
      viewportHeight: 12,
      prev,
    });
    // Should snap to header-2 when context fits.
    expect(y).toBe(Math.max(0, headerY - 2));
  });

  test("tall stack + small viewport: fallback keeps cursor visible", () => {
    const grid = gridOf([linearStack("s", 20)]);
    // Walk from cursor at bottom to cursor at top one step at a time.
    let prev = 0;
    for (let i = 19; i >= 0; i--) {
      prev = expectCursorVisible({
        visibleStacks: ["s"],
        grid,
        cursorBranch: `s/${i}`,
        viewportHeight: 4,
        prev,
      });
    }
    // And walk back down.
    for (let i = 0; i < 20; i++) {
      prev = expectCursorVisible({
        visibleStacks: ["s"],
        grid,
        cursorBranch: `s/${i}`,
        viewportHeight: 4,
        prev,
      });
    }
  });

  test("minimum viewport (height 2) still keeps cursor fully visible", () => {
    const grid = gridOf([linearStack("s", 6)]);
    let prev = 0;
    for (let i = 0; i < 6; i++) {
      prev = expectCursorVisible({
        visibleStacks: ["s"],
        grid,
        cursorBranch: `s/${i}`,
        viewportHeight: 2,
        prev,
      });
    }
  });

  test("viewport height below 2 is clamped so scroll math still runs", () => {
    const grid = gridOf([linearStack("s", 5)]);
    // Degenerate viewports can't physically fit a 2-line cursor, but the
    // scroll computation must still clamp internally and produce a legal
    // scroll offset rather than throwing or going negative.
    const y = computeScrollY({
      visibleStacks: ["s"],
      grid,
      cursorBranch: "s/4",
      viewportHeight: 1,
      prev: 0,
    });
    expect(y).toBeGreaterThanOrEqual(0);
  });

  test("cross-stack navigation keeps cursor visible after every step", () => {
    const grid = gridOf([linearStack("a", 4), linearStack("b", 4)]);
    const visible = ["a", "b"];
    // Walk across both stacks in both directions with a small viewport.
    const sequence = [
      "a/0",
      "a/1",
      "a/2",
      "a/3",
      "b/0",
      "b/1",
      "b/2",
      "b/3",
      "b/2",
      "b/1",
      "b/0",
      "a/3",
      "a/2",
      "a/1",
      "a/0",
    ];
    let prev = 0;
    for (const branch of sequence) {
      prev = expectCursorVisible({
        visibleStacks: visible,
        grid,
        cursorBranch: branch,
        viewportHeight: 6,
        prev,
      });
    }
  });

  test("cursor branch not in visible stacks clamps prev without crash", () => {
    const grid = gridOf([linearStack("a", 3), linearStack("b", 3)]);
    // Active tab is "a" only, but cursor is on a "b" branch.
    const y = computeScrollY({
      visibleStacks: ["a"],
      grid,
      cursorBranch: "b/2",
      viewportHeight: 6,
      prev: 99,
    });
    // contentHeight for just "a" = 2 + 1 + 2+1+2+1+2 = 11. maxScroll = 5.
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(11 - 6);
  });

  test("cursor stays visible after viewport shrinks from a resize", () => {
    const grid = gridOf([linearStack("s", 10)]);
    // Start with viewport=12, cursor in the middle, scroll at header context.
    const first = computeScrollY({
      visibleStacks: ["s"],
      grid,
      cursorBranch: "s/5",
      viewportHeight: 12,
      prev: 0,
    });
    // Now shrink the viewport to 3 rows and re-run with the same cursor.
    expectCursorVisible({
      visibleStacks: ["s"],
      grid,
      cursorBranch: "s/5",
      viewportHeight: 3,
      prev: first,
    });
  });
});

describe("branchNameContentX", () => {
  test("accounts for contentPrefix filler and ladder depth", () => {
    // Single stack: contentPrefix = 3 chars, depth D adds D*3 chars.
    expect(branchNameContentX(1, 0)).toBe(3);
    expect(branchNameContentX(1, 4)).toBe(15);
    expect(branchNameContentX(1, 19)).toBe(60);
    // Four stacks: contentPrefix = 12 chars (shared content col).
    expect(branchNameContentX(4, 0)).toBe(12);
    expect(branchNameContentX(4, 3)).toBe(21);
  });
});

describe("computeScrollX", () => {
  /**
   * Invariant: after `computeScrollX`, the cursor's full branch name is
   * inside `[scrollX, scrollX + viewportWidth)`.
   */
  function expectBranchVisible(input: Parameters<typeof computeScrollX>[0]) {
    const scrollX = computeScrollX(input);
    const right = input.cursorX + input.cursorWidth;
    expect(input.cursorX).toBeGreaterThanOrEqual(scrollX);
    expect(right).toBeLessThanOrEqual(scrollX + input.viewportWidth);
    return scrollX;
  }

  test("no scroll needed when cursor fits in the current viewport", () => {
    const x = computeScrollX({
      cursorX: 10,
      cursorWidth: 10,
      viewportWidth: 50,
      prev: 0,
    });
    expect(x).toBe(0);
  });

  test("scrolls right to reveal the full branch name when right edge is off-screen", () => {
    // Matches the 50x44 linear-stack-depth-19 failure mode: contentX for
    // depth 19 in a single stack is 60, name width 10, right = 70. The
    // previous math used `depth * 3 = 57` as the left edge and clipped
    // the trailing chars of the cursor name at the right edge.
    expectBranchVisible({
      cursorX: branchNameContentX(1, 19),
      cursorWidth: "feat/br-19".length,
      viewportWidth: 50,
      prev: 0,
    });
  });

  test("snaps left when walking back to a shallower branch", () => {
    // After walking up from depth 19 to a shallower depth, the cursor's
    // left edge is below the previous scroll, so scroll must snap back.
    const x = computeScrollX({
      cursorX: 15,
      cursorWidth: 10,
      viewportWidth: 50,
      prev: 20,
    });
    expect(x).toBe(15);
  });

  test("walking up and down a 20-branch deep stack keeps every cursor fully visible", () => {
    const viewportWidth = 50;
    const stackCount = 1;
    let prev = 0;
    for (let depth = 19; depth >= 0; depth--) {
      prev = expectBranchVisible({
        cursorX: branchNameContentX(stackCount, depth),
        cursorWidth: `feat/br-${String(depth).padStart(2, "0")}`.length,
        viewportWidth,
        prev,
      });
    }
    for (let depth = 0; depth < 20; depth++) {
      prev = expectBranchVisible({
        cursorX: branchNameContentX(stackCount, depth),
        cursorWidth: `feat/br-${String(depth).padStart(2, "0")}`.length,
        viewportWidth,
        prev,
      });
    }
  });

  test("name wider than viewport: scroll reveals right edge (best effort)", () => {
    // Pathological: branch name wider than the viewport. Best-effort
    // policy is to anchor on the right edge so the PR glyphs next to
    // the cursor remain visible.
    const scrollX = computeScrollX({
      cursorX: 15,
      cursorWidth: 40,
      viewportWidth: 20,
      prev: 0,
    });
    expect(scrollX).toBe(Math.max(0, 15 + 40 - 20));
  });
});
