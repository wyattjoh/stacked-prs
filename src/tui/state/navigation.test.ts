import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { StackTree } from "../../lib/stack.ts";
import type { Cursor, SyncStatus } from "../types.ts";
import { buildGrid } from "../lib/layout.ts";
import {
  moveDown,
  moveLeft,
  moveRight,
  moveToBranch,
  moveToStack,
  moveUp,
} from "./navigation.ts";

function linearTree(name: string, branches: string[]): StackTree {
  // deno-lint-ignore no-explicit-any
  const chainChildren = (i: number): any => {
    if (i >= branches.length) return [];
    return [{
      branch: branches[i],
      stackName: name,
      parent: i === 0 ? "main" : branches[i - 1],
      children: chainChildren(i + 1),
    }];
  };
  return {
    stackName: name,
    baseBranch: "main",
    mergeStrategy: "merge",
    roots: chainChildren(0),
  };
}

const allUpToDate = (branches: string[]): Map<string, SyncStatus> =>
  new Map(branches.map((b) => [b, "up-to-date" as SyncStatus]));

describe("navigation", () => {
  const a = linearTree("alpha", ["a1", "a2", "a3", "a4", "a5", "a6"]);
  const b = linearTree("beta", ["b1", "b2", "b3"]);
  const g = linearTree("gamma", ["g1", "g2", "g3", "g4", "g5", "g6", "g7"]);
  const grid = buildGrid(
    [a, b, g],
    allUpToDate([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
      "b1",
      "b2",
      "b3",
      "g1",
      "g2",
      "g3",
      "g4",
      "g5",
      "g6",
      "g7",
    ]),
  );

  test("moveRight walks along a row", () => {
    const c: Cursor = { branch: "a1", preferredCol: 0 };
    const r1 = moveRight(grid, c);
    expect(r1.branch).toBe("a2");
    expect(r1.preferredCol).toBe(1);
  });

  test("moveRight at end of chain is no-op", () => {
    const c: Cursor = { branch: "a6", preferredCol: 5 };
    expect(moveRight(grid, c)).toEqual(c);
  });

  test("moveDown from tall stack to shorter one clamps", () => {
    // a5 is col=4 on alpha row. beta only has cols 0..2.
    const c: Cursor = { branch: "a5", preferredCol: 4 };
    const r1 = moveDown(grid, c);
    expect(r1.branch).toBe("b3");
    expect(r1.preferredCol).toBe(4); // preserved
  });

  test("moveDown restores preferredCol when next row is wide enough", () => {
    const c: Cursor = { branch: "b3", preferredCol: 4 };
    const r1 = moveDown(grid, c);
    expect(r1.branch).toBe("g5");
    expect(r1.preferredCol).toBe(4);
  });

  test("moveUp mirrors moveDown", () => {
    const c: Cursor = { branch: "g5", preferredCol: 4 };
    const r1 = moveUp(grid, c);
    expect(r1.branch).toBe("b3");
    expect(r1.preferredCol).toBe(4);
  });

  test("moveLeft does not change preferredCol beyond new col", () => {
    const c: Cursor = { branch: "a3", preferredCol: 2 };
    const r = moveLeft(grid, c);
    expect(r.branch).toBe("a2");
    expect(r.preferredCol).toBe(1);
  });

  test("moveToBranch jumps directly and resets preferredCol", () => {
    const r = moveToBranch(grid, "g4");
    expect(r?.branch).toBe("g4");
    expect(r?.preferredCol).toBe(3);
  });

  test("moveToBranch returns null for unknown branch", () => {
    expect(moveToBranch(grid, "nope")).toBe(null);
  });

  test("moveToStack focuses first branch of target stack", () => {
    const c: Cursor = { branch: "a3", preferredCol: 2 };
    const r = moveToStack(grid, "beta", c);
    expect(r?.branch).toBe("b1");
  });
});
