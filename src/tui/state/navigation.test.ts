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
  const a = linearTree("alpha", ["a1", "a2", "a3"]);
  const b = linearTree("beta", ["b1", "b2"]);
  const grid = buildGrid(
    [a, b],
    allUpToDate(["a1", "a2", "a3", "b1", "b2"]),
  );

  test("moveDown walks to the next branch in row order", () => {
    const c: Cursor = { branch: "a1" };
    expect(moveDown(grid, c).branch).toBe("a2");
  });

  test("moveDown crosses stack boundaries", () => {
    const c: Cursor = { branch: "a3" };
    expect(moveDown(grid, c).branch).toBe("b1");
  });

  test("moveDown at the very last branch is a no-op", () => {
    const c: Cursor = { branch: "b2" };
    expect(moveDown(grid, c)).toEqual(c);
  });

  test("moveUp mirrors moveDown", () => {
    const c: Cursor = { branch: "b1" };
    expect(moveUp(grid, c).branch).toBe("a3");
  });

  test("moveUp at the very first branch is a no-op", () => {
    const c: Cursor = { branch: "a1" };
    expect(moveUp(grid, c)).toEqual(c);
  });

  test("moveRight moves to the first child", () => {
    const c: Cursor = { branch: "a1" };
    expect(moveRight(grid, c).branch).toBe("a2");
  });

  test("moveRight at a leaf is a no-op", () => {
    const c: Cursor = { branch: "a3" };
    expect(moveRight(grid, c)).toEqual(c);
  });

  test("moveLeft moves to the parent", () => {
    const c: Cursor = { branch: "a3" };
    expect(moveLeft(grid, c).branch).toBe("a2");
  });

  test("moveLeft at a root is a no-op", () => {
    const c: Cursor = { branch: "a1" };
    expect(moveLeft(grid, c)).toEqual(c);
  });

  test("moveToBranch jumps directly", () => {
    const r = moveToBranch(grid, "b2");
    expect(r?.branch).toBe("b2");
  });

  test("moveToBranch returns null for unknown branch", () => {
    expect(moveToBranch(grid, "nope")).toBe(null);
  });

  test("moveToStack focuses first branch of target stack", () => {
    const c: Cursor = { branch: "a3" };
    const r = moveToStack(grid, "beta", c);
    expect(r?.branch).toBe("b1");
  });
});
