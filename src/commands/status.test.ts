import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  createTestRepo,
  makeMockDir,
  runGit,
} from "../lib/testdata/helpers.ts";
import {
  runGitCommand,
  setBaseBranch,
  setMergeStrategy,
  setStackNode,
} from "../lib/stack.ts";
import { writeFixture } from "../lib/gh.ts";
import { getStackStatus } from "./status.ts";

describe("getStackStatus", () => {
  test("returns tree-structured status with depth info for a forked tree (a -> b + c)", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    // a is a root branch, b and c are children of a
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");
    await addBranch(repo.dir, "feature/c", "feature/a");

    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
    await setStackNode(repo.dir, "feature/c", "my-stack", "feature/a");
    await setBaseBranch(repo.dir, "my-stack", "main");

    // No PR fixtures needed for basic structure tests (mock returns [])

    const status = await getStackStatus(repo.dir, "my-stack");

    expect(status.stackName).toBe("my-stack");
    expect(status.branches).toHaveLength(3);

    const branchA = status.branches.find((b) => b.branch === "feature/a");
    const branchB = status.branches.find((b) => b.branch === "feature/b");
    const branchC = status.branches.find((b) => b.branch === "feature/c");

    // feature/a is a root: depth 0, childCount 2
    expect(branchA).toBeDefined();
    expect(branchA!.depth).toBe(0);
    expect(branchA!.childCount).toBe(2);
    expect(branchA!.parent).toBe("main");

    // feature/b and feature/c are at depth 1
    expect(branchB).toBeDefined();
    expect(branchB!.depth).toBe(1);
    expect(branchB!.childCount).toBe(0);
    expect(branchB!.parent).toBe("feature/a");

    expect(branchC).toBeDefined();
    expect(branchC!.depth).toBe(1);
    expect(branchC!.childCount).toBe(0);
    expect(branchC!.parent).toBe("feature/a");

    // Siblings: b comes before c alphabetically, so b is not last, c is last
    expect(branchB!.isLastChild).toBe(false);
    expect(branchC!.isLastChild).toBe(true);
  });

  test("formats human-readable tree output with Stack: header", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");

    await setStackNode(repo.dir, "feature/a", "auth-rework", "main");
    await setStackNode(repo.dir, "feature/b", "auth-rework", "feature/a");
    await setBaseBranch(repo.dir, "auth-rework", "main");
    await setMergeStrategy(repo.dir, "auth-rework", "squash");

    const status = await getStackStatus(repo.dir, "auth-rework");

    // Header must contain stack name and strategy
    expect(status.display).toContain("Stack: auth-rework (squash merge)");

    // Both branches must appear in the display
    expect(status.display).toContain("feature/a");
    expect(status.display).toContain("feature/b");

    // feature/b is the child, should have tree connector
    expect(status.display).toContain("└──");
  });

  test("correctly identifies current branch with isCurrent flag", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/x", "main");
    await addBranch(repo.dir, "feature/y", "feature/x");

    await setStackNode(repo.dir, "feature/x", "curr-stack", "main");
    await setStackNode(repo.dir, "feature/y", "curr-stack", "feature/x");
    await setBaseBranch(repo.dir, "curr-stack", "main");

    // Checkout feature/y so it becomes the current branch
    await runGit(repo.dir, "checkout", "feature/y");

    const status = await getStackStatus(repo.dir, "curr-stack");

    const branchX = status.branches.find((b) => b.branch === "feature/x");
    const branchY = status.branches.find((b) => b.branch === "feature/y");

    expect(branchX!.isCurrent).toBe(false);
    expect(branchY!.isCurrent).toBe(true);

    // Display should include the "you are here" marker for feature/y
    expect(status.display).toContain("<- you are here");
  });

  test("detects behind-parent sync status", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/step1", "main");

    // Create feature/step2 as a plain branch pointer (no extra commit)
    // so it shares the exact tip of feature/step1 at branch time.
    await runGit(repo.dir, "checkout", "feature/step1");
    await runGit(repo.dir, "checkout", "-b", "feature/step2");
    await runGit(repo.dir, "checkout", "main");

    await setStackNode(repo.dir, "feature/step1", "diverge-stack", "main");
    await setStackNode(
      repo.dir,
      "feature/step2",
      "diverge-stack",
      "feature/step1",
    );
    await setBaseBranch(repo.dir, "diverge-stack", "main");

    // Add a new commit to feature/step1 AFTER feature/step2 was branched.
    // Since feature/step2 has no extra commits, it is purely behind feature/step1.
    await runGit(repo.dir, "checkout", "feature/step1");
    await Deno.writeTextFile(`${repo.dir}/extra.txt`, "extra\n");
    await runGit(repo.dir, "add", "extra.txt");
    await runGit(repo.dir, "commit", "-m", "add extra commit to step1");
    await runGit(repo.dir, "checkout", "main");

    const status = await getStackStatus(repo.dir, "diverge-stack");

    const step2 = status.branches.find((b) => b.branch === "feature/step2");
    expect(step2).toBeDefined();
    expect(step2!.syncStatus).toBe("behind-parent");
  });

  test("handles branches with no PR", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/solo", "main");

    await setStackNode(repo.dir, "feature/solo", "solo-stack", "main");
    await setBaseBranch(repo.dir, "solo-stack", "main");

    // No fixture written — gh mock returns "[]"

    const status = await getStackStatus(repo.dir, "solo-stack", "test", "repo");

    expect(status.branches).toHaveLength(1);
    expect(status.branches[0].pr).toBeNull();
  });

  test("includes PR info in annotations and display", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feature/pr1", "main");

    await setStackNode(repo.dir, "feature/pr1", "pr-stack", "main");
    await setBaseBranch(repo.dir, "pr-stack", "main");

    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feature/pr1", "--repo", "test/repo"],
      [{
        number: 101,
        url: "https://github.com/test/repo/pull/101",
        state: "OPEN",
        isDraft: false,
      }],
    );

    const status = await getStackStatus(repo.dir, "pr-stack", "test", "repo");

    expect(status.branches[0].pr).toEqual({
      number: 101,
      url: "https://github.com/test/repo/pull/101",
      state: "OPEN",
      isDraft: false,
    });

    // Display should include the PR number
    expect(status.display).toContain("#101");
  });

  test("surfaces merged PR when gh reports MERGED state", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feature/landed", "main");

    await setStackNode(repo.dir, "feature/landed", "landed-stack", "main");
    await setBaseBranch(repo.dir, "landed-stack", "main");

    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feature/landed", "--repo", "test/repo"],
      [{
        number: 117,
        url: "https://github.com/test/repo/pull/117",
        state: "MERGED",
        isDraft: false,
        createdAt: "2026-04-07T00:00:00Z",
      }],
    );

    const status = await getStackStatus(
      repo.dir,
      "landed-stack",
      "test",
      "repo",
    );

    expect(status.branches[0].pr).toMatchObject({
      number: 117,
      state: "MERGED",
    });
  });
});

describe("getStackStatus with merged nodes", () => {
  test("returns 'landed' sync status for stack-merged branches", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await runGitCommand(
      repo.dir,
      "config",
      "branch.feature/a.stack-merged",
      "true",
    );

    const status = await getStackStatus(repo.dir, "my-stack");

    const branchA = status.branches.find((b) => b.branch === "feature/a");
    expect(branchA?.syncStatus).toBe("landed");
  });

  test("renders stack-level tombstone root as a landed node", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/live", "main");
    await setStackNode(repo.dir, "feature/live", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await addTombstone(repo.dir, "my-stack", "feature/landed", {
      prNumber: 51,
    });

    const status = await getStackStatus(repo.dir, "my-stack");

    const landed = status.branches.find((b) => b.branch === "feature/landed");
    expect(landed?.syncStatus).toBe("landed");
    expect(landed?.parent).toBe("main");
    // The live subtree still renders with computed sync status.
    const live = status.branches.find((b) => b.branch === "feature/live");
    expect(live?.syncStatus).toBe("up-to-date");
  });
});
