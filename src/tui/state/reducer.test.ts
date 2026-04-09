import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { initialState, reducer } from "./reducer.ts";
import type { Action, State, SyncStatus } from "../types.ts";
import type { StackTree } from "../../lib/stack.ts";
import { buildGrid } from "../lib/layout.ts";

const emptyGrid = buildGrid([], new Map());

function makeState(overrides: Partial<State> = {}): State {
  return { ...initialState(), grid: emptyGrid, ...overrides };
}

describe("reducer", () => {
  test("initialState has no cursor and is loading=0", () => {
    const s = initialState();
    expect(s.cursor).toBe(null);
    expect(s.loadingCount).toBe(0);
    expect(s.showHelp).toBe(false);
  });

  test("LOCAL_LOADED populates trees, grid, totalLoadCount", () => {
    const s = makeState();
    const action: Action = {
      type: "LOCAL_LOADED",
      trees: [],
      syncByBranch: new Map(),
      worktreeByBranch: new Map(),
      grid: emptyGrid,
      colorByStack: new Map([["alpha", "cyan"]]),
      currentBranch: "a1",
      totalBranches: 3,
    };
    const s2 = reducer(s, action);
    expect(s2.totalLoadCount).toBe(3);
    expect(s2.colorByStack.get("alpha")).toBe("cyan");
    expect(s2.currentBranch).toBe("a1");
  });

  test("PR_LOAD_START increments loadingCount and marks cell loading", () => {
    const s = makeState();
    const s2 = reducer(s, { type: "PR_LOAD_START", branch: "a1" });
    expect(s2.loadingCount).toBe(1);
    expect(s2.prData.get("a1")?.status).toBe("loading");
  });

  test("PR_LOADED decrements loadingCount and stores PR", () => {
    const loading = reducer(
      makeState(),
      { type: "PR_LOAD_START", branch: "a1" },
    );
    const loaded = reducer(loading, {
      type: "PR_LOADED",
      branch: "a1",
      pr: { number: 1, url: "u", state: "OPEN", isDraft: false },
    });
    expect(loaded.loadingCount).toBe(0);
    expect(loaded.prData.get("a1")).toEqual({
      status: "loaded",
      pr: { number: 1, url: "u", state: "OPEN", isDraft: false },
    });
  });

  test("PR_ERROR decrements loadingCount and stores error", () => {
    const loading = reducer(
      makeState(),
      { type: "PR_LOAD_START", branch: "a1" },
    );
    const err = reducer(
      loading,
      { type: "PR_ERROR", branch: "a1", message: "boom" },
    );
    expect(err.loadingCount).toBe(0);
    expect(err.prData.get("a1")?.status).toBe("error");
  });

  test("GH_UNAVAILABLE sets the flag", () => {
    const s = reducer(makeState(), { type: "GH_UNAVAILABLE" });
    expect(s.ghUnavailable).toBe(true);
  });

  test("HELP_TOGGLE flips showHelp", () => {
    const s1 = reducer(makeState(), { type: "HELP_TOGGLE" });
    expect(s1.showHelp).toBe(true);
    const s2 = reducer(s1, { type: "HELP_TOGGLE" });
    expect(s2.showHelp).toBe(false);
  });

  test("CURSOR_SET updates cursor", () => {
    const s = reducer(
      makeState(),
      { type: "CURSOR_SET", cursor: { branch: "a1" } },
    );
    expect(s.cursor).toEqual({ branch: "a1" });
  });

  test("TAB_SWITCH remembers cursors per tab", () => {
    const s0 = makeState({
      cursor: { branch: "a1" },
      activeTab: "all",
    });
    const s1 = reducer(s0, { type: "TAB_SWITCH", tab: { stack: "alpha" } });
    // Previous "all" cursor saved
    expect(s1.cursorByTab.get("all")?.branch).toBe("a1");
    expect(s1.activeTab).toEqual({ stack: "alpha" });
  });

  test("TAB_SWITCH into a specific stack snaps cursor to that stack", () => {
    const linear = (name: string, branches: string[]): StackTree => {
      // deno-lint-ignore no-explicit-any
      const chain = (i: number): any => {
        if (i >= branches.length) return [];
        return [{
          branch: branches[i],
          stackName: name,
          parent: i === 0 ? "main" : branches[i - 1],
          children: chain(i + 1),
        }];
      };
      return {
        stackName: name,
        baseBranch: "main",
        mergeStrategy: "merge",
        roots: chain(0),
      };
    };
    const sync = new Map<string, SyncStatus>(
      ["a1", "a2", "b1", "b2"].map((b) => [b, "up-to-date"]),
    );
    const grid = buildGrid(
      [linear("alpha", ["a1", "a2"]), linear("beta", ["b1", "b2"])],
      sync,
    );
    // Cursor lives in "alpha" while we switch to tab for "beta" — it should
    // snap to beta's first cell instead of staying on a1.
    const s0 = makeState({
      grid,
      cursor: { branch: "a1" },
      activeTab: "all",
    });
    const s1 = reducer(s0, { type: "TAB_SWITCH", tab: { stack: "beta" } });
    expect(s1.cursor?.branch).toBe("b1");

    // Switching back to "all" restores the saved cursor on "all".
    const s2 = reducer(s1, { type: "TAB_SWITCH", tab: "all" });
    expect(s2.cursor?.branch).toBe("a1");

    // Re-entering "beta" restores the per-tab cursor (still b1).
    const s3 = reducer(s2, { type: "TAB_SWITCH", tab: { stack: "beta" } });
    expect(s3.cursor?.branch).toBe("b1");
  });

  test("COMMITS_LOADED stores commits for branch", () => {
    const s = reducer(makeState(), {
      type: "COMMITS_LOADED",
      branch: "a1",
      commits: [{ sha: "abc", subject: "x" }],
    });
    expect(s.commits.get("a1")?.status).toBe("loaded");
  });
});
