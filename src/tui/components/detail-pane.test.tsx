import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import { DetailPane } from "./detail-pane.tsx";

describe("DetailPane", () => {
  test("shows header with branch name and sync status", () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        branch="alpha-3"
        prCell={{
          status: "loaded",
          pr: { number: 42, url: "u", state: "OPEN", isDraft: true },
        }}
        syncStatus="behind-parent"
        commitsCell={{ status: "loaded", commits: [] }}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("alpha-3");
    expect(f).toContain("#42");
    expect(f).toContain("draft");
    expect(f).toContain("behind-parent");
    unmount();
  });

  test("shows commits", () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        branch="alpha-3"
        prCell={{ status: "loaded", pr: null }}
        syncStatus="up-to-date"
        commitsCell={{
          status: "loaded",
          commits: [
            { sha: "abc1234", subject: "feat: add thing" },
            { sha: "def5678", subject: "test: cover thing" },
          ],
        }}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("abc1234");
    expect(f).toContain("feat: add thing");
    expect(f).toContain("def5678");
    unmount();
  });

  test("shows placeholder when no branch focused", () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        branch={null}
        prCell={undefined}
        syncStatus={undefined}
        commitsCell={undefined}
      />,
    );
    expect(lastFrame()).toContain("no branch selected");
    unmount();
  });
});
