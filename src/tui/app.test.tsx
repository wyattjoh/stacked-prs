import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import {
  addBranch,
  createTestRepo,
  makeTempDir,
} from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import { setMockDir, writeFixture } from "../lib/gh.ts";
import { App } from "./app.tsx";

/** Acquire a temp mock dir, register it, and reset on disposal. */
async function makeMockDir(): Promise<AsyncDisposable & { path: string }> {
  const dir = await makeTempDir("stacked-prs-mock-");
  setMockDir(dir.path);
  return {
    path: dir.path,
    [Symbol.asyncDispose]: async () => {
      setMockDir(undefined);
      await dir[Symbol.asyncDispose]();
    },
  };
}

describe(
  "App integration",
  { sanitizeResources: false, sanitizeOps: false },
  () => {
    test("renders 'No stacks found' when repo has no stacks", async () => {
      await using repo = await createTestRepo();
      await using _mock = await makeMockDir();
      const { lastFrame, unmount } = render(<App dir={repo.dir} />);
      try {
        // Give useEffect time to run loadLocal.
        await new Promise((r) => setTimeout(r, 200));
        expect(lastFrame()).toContain("No stacks found");
      } finally {
        unmount();
      }
    });

    test("renders stack band after local load completes", async () => {
      await using repo = await createTestRepo();
      await using mock = await makeMockDir();
      await addBranch(repo.dir, "feat/a", "main");
      await setStackNode(repo.dir, "feat/a", "alpha", "main");
      await setBaseBranch(repo.dir, "alpha", "main");
      await writeFixture(
        mock.path,
        ["pr", "list", "--head", "feat/a"],
        [{ number: 1, url: "u", state: "OPEN", isDraft: false }],
      );

      const { lastFrame, unmount } = render(<App dir={repo.dir} />);
      try {
        await new Promise((r) => setTimeout(r, 400));

        expect(lastFrame()).toContain("Stack: alpha");
        expect(lastFrame()).toContain("feat/a");
      } finally {
        unmount();
      }
    });

    test("pressing L on a stack with a merged PR enters the land modal", async () => {
      await using repo = await createTestRepo();
      await using mock = await makeMockDir();
      await addBranch(repo.dir, "feat/a", "main");
      await setStackNode(repo.dir, "feat/a", "s", "main");
      await setBaseBranch(repo.dir, "s", "main");
      // Mock gh pr list for feat/a to return MERGED.
      await writeFixture(
        mock.path,
        ["pr", "list", "--head", "feat/a"],
        [
          {
            number: 10,
            url: "https://example.com/10",
            state: "MERGED",
            isDraft: false,
            createdAt: "2026-04-01T00:00:00Z",
          },
        ],
      );

      const { stdin, lastFrame, unmount } = render(<App dir={repo.dir} />);
      try {
        // Give the initial load a tick to populate PR data.
        await new Promise((r) => setTimeout(r, 300));
        stdin.write("L");
        await new Promise((r) => setTimeout(r, 100));
        const frame = lastFrame() ?? "";
        // After L, we're either in planning, confirming (plan already loaded),
        // or all the way through the all-merged fast path.
        const entered = frame.includes("Computing land plan") ||
          frame.includes("Land stack") ||
          frame.includes("Landed stack") ||
          frame.includes("Land failed");
        expect(entered).toBe(true);
      } finally {
        unmount();
      }
    });
  },
);
