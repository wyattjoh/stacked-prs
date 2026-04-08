import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { StackTree } from "../../lib/stack.ts";
import type { SyncStatus } from "../types.ts";
import { buildGrid } from "./layout.ts";

function tree(
  stackName: string,
  rootBranch: string,
  children: Array<[string, string[]]> = [],
): StackTree {
  const childrenMap = new Map<string, string[]>();
  for (const [parent, kids] of children) childrenMap.set(parent, kids);

  // deno-lint-ignore no-explicit-any
  const build = (branch: string, parent: string): any => ({
    branch,
    stackName,
    parent,
    children: (childrenMap.get(branch) ?? []).map((c) => build(c, branch)),
  });

  return {
    stackName,
    baseBranch: "main",
    mergeStrategy: "merge",
    roots: [build(rootBranch, "main")],
  };
}

function sync(...pairs: Array<[string, SyncStatus]>): Map<string, SyncStatus> {
  return new Map(pairs);
}

describe("buildGrid", () => {
  test("single linear stack ladders down with increasing depth", () => {
    const t = tree("alpha", "a", [["a", ["b"]], ["b", ["c"]]]);
    const grid = buildGrid(
      [t],
      sync(
        ["a", "up-to-date"],
        ["b", "up-to-date"],
        ["c", "up-to-date"],
      ),
    );

    expect(grid.cells).toHaveLength(3);
    expect(grid.byBranch.get("a")?.depth).toBe(0);
    expect(grid.byBranch.get("b")?.depth).toBe(1);
    expect(grid.byBranch.get("c")?.depth).toBe(2);
    expect(grid.byBranch.get("a")?.row).toBe(0);
    expect(grid.byBranch.get("b")?.row).toBe(1);
    expect(grid.byBranch.get("c")?.row).toBe(2);
    expect(grid.byBranch.get("a")?.parent).toBe(null);
    expect(grid.byBranch.get("b")?.parent).toBe("a");
    expect(grid.byBranch.get("a")?.firstChild).toBe("b");
    expect(grid.byBranch.get("c")?.firstChild).toBe(null);
  });

  test("fork puts siblings on consecutive rows at same depth", () => {
    const t = tree("alpha", "a", [["a", ["b", "c"]]]);
    const grid = buildGrid(
      [t],
      sync(
        ["a", "up-to-date"],
        ["b", "up-to-date"],
        ["c", "up-to-date"],
      ),
    );

    // Every branch is on its own row; b and c are at the same depth.
    expect(grid.byBranch.get("a")?.row).toBe(0);
    expect(grid.byBranch.get("b")?.row).toBe(1);
    expect(grid.byBranch.get("c")?.row).toBe(2);
    expect(grid.byBranch.get("b")?.depth).toBe(1);
    expect(grid.byBranch.get("c")?.depth).toBe(1);
    // b is not the last sibling, c is.
    expect(grid.byBranch.get("b")?.isLastSibling).toBe(false);
    expect(grid.byBranch.get("c")?.isLastSibling).toBe(true);
  });

  test("ancestor rails reflect whether an uncle is still coming", () => {
    // a has children b, c; b has child d. When rendering d (depth 2),
    // slot 0 should carry a rail because b still has a later sibling (c).
    const t = tree("alpha", "a", [["a", ["b", "c"]], ["b", ["d"]]]);
    const grid = buildGrid(
      [t],
      sync(
        ["a", "up-to-date"],
        ["b", "up-to-date"],
        ["c", "up-to-date"],
        ["d", "up-to-date"],
      ),
    );

    const d = grid.byBranch.get("d");
    expect(d?.depth).toBe(2);
    expect(d?.ancestorRails).toEqual([true]);
  });

  test("no ancestor rail when parent is last sibling", () => {
    // a has only child b; b has only child c. c at depth 2 should have
    // ancestorRails [false] because b is last sibling of a.
    const t = tree("alpha", "a", [["a", ["b"]], ["b", ["c"]]]);
    const grid = buildGrid(
      [t],
      sync(
        ["a", "up-to-date"],
        ["b", "up-to-date"],
        ["c", "up-to-date"],
      ),
    );

    const c = grid.byBranch.get("c");
    expect(c?.depth).toBe(2);
    expect(c?.ancestorRails).toEqual([false]);
  });

  test("connector style reflects sync status", () => {
    const t = tree("alpha", "a", [["a", ["b"]], ["b", ["c"]]]);
    const grid = buildGrid(
      [t],
      sync(
        ["a", "up-to-date"],
        ["b", "behind-parent"],
        ["c", "diverged"],
      ),
    );

    expect(grid.byBranch.get("b")?.connectorStyle).toBe("dashed");
    expect(grid.byBranch.get("c")?.connectorStyle).toBe("double");
    expect(grid.byBranch.get("a")?.connectorStyle).toBe("solid");
  });

  test("multiple stacks get non-overlapping row ranges", () => {
    const a = tree("alpha", "a", [["a", ["b"]]]);
    const b = tree("beta", "x", [["x", ["y"]]]);
    const grid = buildGrid(
      [a, b],
      sync(
        ["a", "up-to-date"],
        ["b", "up-to-date"],
        ["x", "up-to-date"],
        ["y", "up-to-date"],
      ),
    );

    const alphaRows = grid.rowsByStack.get("alpha") ?? [];
    const betaRows = grid.rowsByStack.get("beta") ?? [];
    for (const r of alphaRows) {
      expect(betaRows).not.toContain(r);
    }
  });

  test("byRow and byStack indexes are consistent with cells", () => {
    const a = tree("alpha", "a", [["a", ["b", "c"]]]);
    const grid = buildGrid(
      [a],
      sync(
        ["a", "up-to-date"],
        ["b", "up-to-date"],
        ["c", "up-to-date"],
      ),
    );

    for (const cell of grid.cells) {
      expect(grid.byBranch.get(cell.branch)).toBe(cell);
      expect(grid.byRow.get(cell.row)).toContain(cell);
      expect(grid.byStack.get(cell.stackName)).toContain(cell);
    }
  });

  test("empty stack list returns empty grid", () => {
    const grid = buildGrid([], sync());
    expect(grid.cells).toHaveLength(0);
    expect(grid.totalRows).toBe(0);
  });
});
