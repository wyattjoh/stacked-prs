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
        worktree={undefined}
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
        worktree={undefined}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("abc1234");
    expect(f).toContain("feat: add thing");
    expect(f).toContain("def5678");
    unmount();
  });

  test("renders clean worktree line", () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        branch="alpha-3"
        prCell={{ status: "loaded", pr: null }}
        syncStatus="up-to-date"
        commitsCell={{ status: "loaded", commits: [] }}
        worktree={{ displayPath: "~/Code/repo", dirty: false }}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("worktree");
    expect(f).toContain("~/Code/repo");
    expect(f.includes("*")).toBe(false);
    unmount();
  });

  test("renders dirty worktree line with marker", () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        branch="alpha-3"
        prCell={{ status: "loaded", pr: null }}
        syncStatus="up-to-date"
        commitsCell={{ status: "loaded", commits: [] }}
        worktree={{ displayPath: "../repo-feat", dirty: true }}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("../repo-feat");
    expect(f).toContain("*");
    unmount();
  });

  test("shows placeholder when no branch focused", () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        branch={null}
        prCell={undefined}
        syncStatus={undefined}
        commitsCell={undefined}
        worktree={undefined}
      />,
    );
    expect(lastFrame()).toContain("no branch selected");
    unmount();
  });

  test("renders the markdown description between worktree and commits", () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        branch="feat/a"
        prCell={undefined}
        syncStatus="up-to-date"
        commitsCell={{
          status: "loaded",
          commits: [{ sha: "abc1234", subject: "Add cache" }],
        }}
        worktree={undefined}
        description={["reduce upstream calls", "", "- cache reads"].join("\n")}
        width={60}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("reduce upstream calls");
    expect(frame).toContain("• cache reads");
    expect(frame).toContain("abc1234 Add cache");
    unmount();
  });

  test("overflow marker row carries the j/k navigation hint", () => {
    const commits = Array.from({ length: 12 }, (_, i) => ({
      sha: `sha${i}00`,
      subject: `commit ${i}`,
    }));
    const { lastFrame, unmount } = render(
      <DetailPane
        branch="feat/a"
        prCell={undefined}
        syncStatus="up-to-date"
        commitsCell={{ status: "loaded", commits }}
        worktree={undefined}
        description="a description line"
        width={60}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("more");
    expect(frame).toContain("j/k for navigation");
    unmount();
  });

  test("scrollY reaches description rows pushed out of the viewport", () => {
    const commits = Array.from({ length: 12 }, (_, i) => ({
      sha: `sha${i}00`,
      subject: `commit ${i}`,
    }));
    const { lastFrame, unmount } = render(
      <DetailPane
        branch="feat/a"
        prCell={undefined}
        syncStatus="up-to-date"
        commitsCell={{ status: "loaded", commits }}
        worktree={undefined}
        description="the description"
        width={60}
        scrollY={3}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("↑");
    expect(frame).toContain("commit");
    unmount();
  });

  test("no description leaves the pane unchanged", () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        branch="feat/a"
        prCell={undefined}
        syncStatus="up-to-date"
        commitsCell={{ status: "loaded", commits: [] }}
        worktree={undefined}
        width={60}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("j/k");
    unmount();
  });
});
