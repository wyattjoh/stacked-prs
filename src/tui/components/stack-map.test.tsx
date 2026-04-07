import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import type { StackTree } from "../../lib/stack.ts";
import type { State } from "../types.ts";
import { initialState } from "../state/reducer.ts";
import { buildGrid } from "../lib/layout.ts";
import { StackMap } from "./stack-map.tsx";

function makeTree(name: string, root: string): StackTree {
  return {
    stackName: name,
    baseBranch: "main",
    mergeStrategy: "merge",
    roots: [{ branch: root, stackName: name, parent: "main", children: [] }],
  };
}

describe("StackMap", () => {
  test("renders every stack band when activeTab is 'all'", () => {
    const trees = [makeTree("alpha", "a1"), makeTree("beta", "b1")];
    const grid = buildGrid(
      trees,
      new Map([["a1", "up-to-date"], ["b1", "up-to-date"]]),
    );
    const state: State = {
      ...initialState(),
      trees,
      grid,
      colorByStack: new Map([["alpha", "cyan"], ["beta", "magenta"]]),
      activeTab: "all",
    };
    const { lastFrame, unmount } = render(<StackMap state={state} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Stack: alpha");
    expect(f).toContain("Stack: beta");
    unmount();
  });

  test("renders only one band when activeTab is a specific stack", () => {
    const trees = [makeTree("alpha", "a1"), makeTree("beta", "b1")];
    const grid = buildGrid(
      trees,
      new Map([["a1", "up-to-date"], ["b1", "up-to-date"]]),
    );
    const state: State = {
      ...initialState(),
      trees,
      grid,
      colorByStack: new Map([["alpha", "cyan"], ["beta", "magenta"]]),
      activeTab: { stack: "alpha" },
    };
    const { lastFrame, unmount } = render(<StackMap state={state} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Stack: alpha");
    expect(f).not.toContain("Stack: beta");
    unmount();
  });

  test("shows empty-state message when no stacks", () => {
    const { lastFrame, unmount } = render(<StackMap state={initialState()} />);
    expect(lastFrame()).toContain("No stacks found");
    unmount();
  });
});
