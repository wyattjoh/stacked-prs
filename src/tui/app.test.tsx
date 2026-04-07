import React from "react";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import { addBranch, createTestRepo } from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import { setMockDir, writeFixture } from "../lib/gh.ts";
import { App } from "./app.tsx";

describe("App integration", () => {
  let repo: TestRepo;
  let mockDir: string;

  beforeEach(async () => {
    repo = await createTestRepo();
    mockDir = await Deno.makeTempDir();
    setMockDir(mockDir);
  });

  afterEach(async () => {
    setMockDir(undefined);
    await repo.cleanup();
    await Deno.remove(mockDir, { recursive: true });
  });

  test("renders 'No stacks found' when repo has no stacks", async () => {
    const { lastFrame, unmount } = render(<App dir={repo.dir} />);
    // Give useEffect time to run loadLocal.
    await new Promise((r) => setTimeout(r, 200));
    expect(lastFrame()).toContain("No stacks found");
    unmount();
  });

  test("renders stack band after local load completes", async () => {
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "alpha", "main");
    await setBaseBranch(repo.dir, "alpha", "main");
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/a"],
      [{ number: 1, url: "u", state: "OPEN", isDraft: false }],
    );

    const { lastFrame, unmount } = render(<App dir={repo.dir} />);
    await new Promise((r) => setTimeout(r, 400));

    expect(lastFrame()).toContain("Stack: alpha");
    expect(lastFrame()).toContain("feat/a");
    unmount();
  });
});
