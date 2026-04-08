import React from "react";
import { describe, it as test } from "@std/testing/bdd";
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
