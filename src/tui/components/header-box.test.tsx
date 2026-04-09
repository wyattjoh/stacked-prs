import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import { HeaderBox } from "./header-box.tsx";

describe("HeaderBox", () => {
  const baseColors = new Map<string, string>([
    ["alpha", "cyan"],
    ["beta", "magenta"],
  ]);

  test("renders stacked-prs label and selected stack name", () => {
    const { lastFrame, unmount } = render(
      <HeaderBox
        stacks={["alpha", "beta"]}
        activeTab={{ stack: "alpha" }}
        loadingCount={0}
        totalLoadCount={0}
        focused
        colorByStack={baseColors}
        primaryColor="white"
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("stacked-prs");
    expect(f).toContain("alpha");
    unmount();
  });

  test("shows position indicator [2/3] when second stack tab is active", () => {
    // Cycle order is ["all", "alpha", "beta"], so alpha is index 2 of 3.
    const { lastFrame, unmount } = render(
      <HeaderBox
        stacks={["alpha", "beta"]}
        activeTab={{ stack: "alpha" }}
        loadingCount={0}
        totalLoadCount={0}
        focused
        colorByStack={baseColors}
        primaryColor="white"
      />,
    );
    expect(lastFrame()).toContain("[2/3]");
    unmount();
  });

  test("renders 'All stacks' label with [1/N] when All tab is active", () => {
    const { lastFrame, unmount } = render(
      <HeaderBox
        stacks={["alpha", "beta"]}
        activeTab="all"
        loadingCount={0}
        totalLoadCount={0}
        focused
        colorByStack={baseColors}
        primaryColor="white"
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("All stacks");
    expect(f).toContain("[1/3]");
    unmount();
  });

  test("shows loading segment when loadingCount > 0", () => {
    const { lastFrame, unmount } = render(
      <HeaderBox
        stacks={["alpha"]}
        activeTab="all"
        loadingCount={3}
        totalLoadCount={10}
        focused
        colorByStack={baseColors}
        primaryColor="white"
      />,
    );
    expect(lastFrame()).toContain("3/10");
    unmount();
  });

  test("hides loading segment when loadingCount is 0", () => {
    const { lastFrame, unmount } = render(
      <HeaderBox
        stacks={["alpha"]}
        activeTab="all"
        loadingCount={0}
        totalLoadCount={0}
        focused
        colorByStack={baseColors}
        primaryColor="white"
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).not.toContain("loading");
    unmount();
  });

  test("always renders the cycle hint", () => {
    const { lastFrame, unmount } = render(
      <HeaderBox
        stacks={["alpha"]}
        activeTab={{ stack: "alpha" }}
        loadingCount={0}
        totalLoadCount={0}
        focused
        colorByStack={baseColors}
        primaryColor="white"
      />,
    );
    expect(lastFrame()).toContain("views");
    unmount();
  });

  test("renders three lines (top border + content + bottom border)", () => {
    const { lastFrame, unmount } = render(
      <HeaderBox
        stacks={["alpha"]}
        activeTab={{ stack: "alpha" }}
        loadingCount={0}
        totalLoadCount={0}
        focused
        colorByStack={baseColors}
        primaryColor="white"
      />,
    );
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.length > 0);
    // Top border (╭...╮), content, bottom border (╰...╯).
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatch(/[╭╮─]/);
    expect(lines[2]).toMatch(/[╰╯─]/);
    unmount();
  });
});
