import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import { TabBar } from "./tab-bar.tsx";

describe("TabBar", () => {
  test("renders [All] and each stack name", () => {
    const { lastFrame, unmount } = render(
      <TabBar
        stacks={["alpha", "beta"]}
        activeTab="all"
        loadingCount={0}
        totalLoadCount={0}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("All");
    expect(f).toContain("alpha");
    expect(f).toContain("beta");
    unmount();
  });

  test("shows loading counter when loadingCount > 0", () => {
    const { lastFrame, unmount } = render(
      <TabBar
        stacks={["alpha"]}
        activeTab="all"
        loadingCount={3}
        totalLoadCount={10}
      />,
    );
    expect(lastFrame()).toContain("loading PRs 3/10");
    unmount();
  });

  test("highlights active tab", () => {
    const { lastFrame, unmount } = render(
      <TabBar
        stacks={["alpha"]}
        activeTab={{ stack: "alpha" }}
        loadingCount={0}
        totalLoadCount={0}
      />,
    );
    expect(lastFrame()).toContain("alpha");
    unmount();
  });
});
