import React from "react";
import { describe, it, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import type { GridCell } from "../types.ts";
import { StackBand } from "./stack-band.tsx";

function cell(
  branch: string,
  row: number,
  depth: number,
  opts: Partial<GridCell> = {},
): GridCell {
  return {
    branch,
    stackName: "alpha",
    row,
    depth,
    isLastSibling: opts.isLastSibling ?? true,
    hasChildren: opts.hasChildren ?? false,
    ancestorRails: opts.ancestorRails ?? [],
    parent: opts.parent ?? null,
    firstChild: opts.firstChild ?? null,
    connectorStyle: opts.connectorStyle ?? "solid",
  };
}

const emptyPrefix = [{ text: "" }];

describe("StackBand merged cell rendering", () => {
  it("renders a merged cell with dimColor and no connector prefix", () => {
    const mergedCell: GridCell = {
      branch: "feature/a",
      stackName: "my-stack",
      row: 0,
      depth: 0,
      isLastSibling: true,
      hasChildren: false,
      ancestorRails: [],
      parent: null,
      firstChild: null,
      connectorStyle: "solid",
      merged: true,
    };
    const liveCell: GridCell = {
      branch: "feature/b",
      stackName: "my-stack",
      row: 2,
      depth: 0,
      isLastSibling: true,
      hasChildren: false,
      ancestorRails: [],
      parent: null,
      firstChild: null,
      connectorStyle: "solid",
    };

    const { unmount, lastFrame } = render(
      <StackBand
        stackName="my-stack"
        mergeStrategy={undefined}
        color="cyan"
        cells={[mergedCell, liveCell]}
        focusedBranch={null}
        prData={new Map()}
        headerPrefix={[]}
        contentPrefix={[]}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("feature/a");
    expect(frame).toContain("feature/b");
    unmount();
  });
});

describe("StackBand", () => {
  test("renders header with stack name and merge strategy", () => {
    const { lastFrame, unmount } = render(
      <StackBand
        stackName="alpha"
        mergeStrategy="squash"
        color="cyan"
        cells={[cell("a1", 0, 0)]}
        focusedBranch={null}
        prData={new Map()}
        headerPrefix={emptyPrefix}
        contentPrefix={emptyPrefix}
      />,
    );
    expect(lastFrame()).toContain("Stack: alpha");
    expect(lastFrame()).toContain("squash");
    unmount();
  });

  test("renders linear chain with ladder connectors", () => {
    const { lastFrame, unmount } = render(
      <StackBand
        stackName="alpha"
        mergeStrategy={undefined}
        color="cyan"
        cells={[
          cell("a1", 0, 0, { hasChildren: true, firstChild: "a2" }),
          cell("a2", 1, 1, {
            hasChildren: true,
            parent: "a1",
            firstChild: "a3",
            ancestorRails: [],
          }),
          cell("a3", 2, 2, { parent: "a2", ancestorRails: [false] }),
        ]}
        focusedBranch={null}
        prData={new Map()}
        headerPrefix={emptyPrefix}
        contentPrefix={emptyPrefix}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("a1");
    expect(f).toContain("a2");
    expect(f).toContain("a3");
    expect(f).toContain("└─ a2");
    expect(f).toContain("└─ a3");
    unmount();
  });

  test("renders fork with mid and last corners", () => {
    const { lastFrame, unmount } = render(
      <StackBand
        stackName="alpha"
        mergeStrategy={undefined}
        color="cyan"
        cells={[
          cell("a1", 0, 0, { hasChildren: true, firstChild: "a2" }),
          cell("a2", 1, 1, {
            parent: "a1",
            isLastSibling: false,
            ancestorRails: [],
          }),
          cell("a3", 2, 1, {
            parent: "a1",
            isLastSibling: true,
            ancestorRails: [],
          }),
        ]}
        focusedBranch={null}
        prData={new Map()}
        headerPrefix={emptyPrefix}
        contentPrefix={emptyPrefix}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("├─ a2");
    expect(f).toContain("└─ a3");
    unmount();
  });
});
