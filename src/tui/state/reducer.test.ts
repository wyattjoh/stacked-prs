import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { initialState, reducer } from "./reducer.ts";
import type { Action, State } from "../types.ts";
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
      { type: "CURSOR_SET", cursor: { branch: "a1", preferredCol: 0 } },
    );
    expect(s.cursor).toEqual({ branch: "a1", preferredCol: 0 });
  });

  test("TAB_SWITCH remembers cursors per tab", () => {
    const s0 = makeState({
      cursor: { branch: "a1", preferredCol: 0 },
      activeTab: "all",
    });
    const s1 = reducer(s0, { type: "TAB_SWITCH", tab: { stack: "alpha" } });
    // Previous "all" cursor saved
    expect(s1.cursorByTab.get("all")?.branch).toBe("a1");
    expect(s1.activeTab).toEqual({ stack: "alpha" });
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
