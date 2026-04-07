import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import { Node } from "./node.tsx";

describe("Node", () => {
  test("renders branch name on top line", () => {
    const { lastFrame, unmount } = render(
      <Node
        branch="alpha-root"
        stackColor="cyan"
        focused={false}
        prCell={{ status: "loaded", pr: null }}
      />,
    );
    expect(lastFrame()).toContain("alpha-root");
    unmount();
  });

  test("shows #N open when PR loaded and open", () => {
    const { lastFrame, unmount } = render(
      <Node
        branch="alpha-root"
        stackColor="cyan"
        focused={false}
        prCell={{
          status: "loaded",
          pr: { number: 42, url: "u", state: "OPEN", isDraft: false },
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("#42");
    expect(frame).toContain("open");
    unmount();
  });

  test("shows draft glyph when PR is draft", () => {
    const { lastFrame, unmount } = render(
      <Node
        branch="alpha-root"
        stackColor="cyan"
        focused={false}
        prCell={{
          status: "loaded",
          pr: { number: 7, url: "u", state: "OPEN", isDraft: true },
        }}
      />,
    );
    expect(lastFrame()).toContain("draft");
    unmount();
  });

  test("shows 'no PR' when loaded but null", () => {
    const { lastFrame, unmount } = render(
      <Node
        branch="alpha-root"
        stackColor="cyan"
        focused={false}
        prCell={{ status: "loaded", pr: null }}
      />,
    );
    expect(lastFrame()).toContain("no PR");
    unmount();
  });

  test("shows loading text when status is loading", () => {
    const { lastFrame, unmount } = render(
      <Node
        branch="alpha-root"
        stackColor="cyan"
        focused={false}
        prCell={{ status: "loading" }}
      />,
    );
    expect(lastFrame()).toContain("loading");
    unmount();
  });

  test("shows error text when status is error", () => {
    const { lastFrame, unmount } = render(
      <Node
        branch="alpha-root"
        stackColor="cyan"
        focused={false}
        prCell={{ status: "error", message: "boom" }}
      />,
    );
    expect(lastFrame()).toContain("gh error");
    unmount();
  });
});
