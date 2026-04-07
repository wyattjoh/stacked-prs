import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import type { GridCell } from "../types.ts";
import { StackBand } from "./stack-band.tsx";

function cell(
  branch: string,
  row: number,
  col: number,
  parentCol: number | null,
): GridCell {
  return {
    branch,
    stackName: "alpha",
    row,
    col,
    parentCol,
    connectorStyle: "solid",
    isForkRow: parentCol !== null && row !== 0,
  };
}

describe("StackBand", () => {
  test("renders header with stack name and merge strategy", () => {
    const { lastFrame, unmount } = render(
      <StackBand
        stackName="alpha"
        mergeStrategy="squash"
        color="cyan"
        cells={[cell("a1", 0, 0, null)]}
        focusedBranch={null}
        prData={new Map()}
      />,
    );
    expect(lastFrame()).toContain("Stack: alpha");
    expect(lastFrame()).toContain("squash");
    unmount();
  });

  test("renders all branch names", () => {
    const { lastFrame, unmount } = render(
      <StackBand
        stackName="alpha"
        mergeStrategy={undefined}
        color="cyan"
        cells={[
          cell("a1", 0, 0, null),
          cell("a2", 0, 1, 0),
          cell("a3", 0, 2, 1),
        ]}
        focusedBranch={null}
        prData={new Map()}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("a1");
    expect(f).toContain("a2");
    expect(f).toContain("a3");
    unmount();
  });

  test("renders fork sub-rows", () => {
    const { lastFrame, unmount } = render(
      <StackBand
        stackName="alpha"
        mergeStrategy={undefined}
        color="cyan"
        cells={[
          cell("a1", 0, 0, null),
          cell("a2", 0, 1, 0),
          cell("a3", 1, 1, 0),
        ]}
        focusedBranch={null}
        prData={new Map()}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("a1");
    expect(f).toContain("a2");
    expect(f).toContain("a3");
    unmount();
  });
});
