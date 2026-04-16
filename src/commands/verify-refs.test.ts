import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  commitFile,
  createTestRepo,
  runGit,
} from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import { verifyRefs } from "./verify-refs.ts";

describe("verifyRefs", () => {
  test("all branches up-to-date returns valid", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

    const result = await verifyRefs(repo.dir, "my-stack");

    expect(result.valid).toBe(true);
    expect(result.repairs).toHaveLength(0);
    expect(result.branches).toHaveLength(2);
    expect(result.branches.find((b) => b.branch === "feature/a")?.status).toBe(
      "ok",
    );
    expect(result.branches.find((b) => b.branch === "feature/b")?.status).toBe(
      "ok",
    );
  });

  test("detects stale branch after parent moves ahead", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

    // Add a new commit to feature/a so feature/b is now stale
    await runGit(repo.dir, "checkout", "feature/a");
    await commitFile(repo.dir, "extra.txt", "extra content\n");
    await runGit(repo.dir, "checkout", "main");

    const result = await verifyRefs(repo.dir, "my-stack");

    expect(result.valid).toBe(false);
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0].branch).toBe("feature/b");
    expect(result.repairs[0].command).toContain("git rebase --onto");
    expect(result.repairs[0].command).toContain("feature/a");
    expect(result.repairs[0].command).toContain("feature/b");
    expect(result.branches.find((b) => b.branch === "feature/b")?.status).toBe(
      "stale",
    );
  });

  test("multiple stale branches", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");
    await addBranch(repo.dir, "feature/c", "feature/b");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
    await setStackNode(repo.dir, "feature/c", "my-stack", "feature/b");

    // Add a new commit to feature/a so both b and c are stale
    await runGit(repo.dir, "checkout", "feature/a");
    await commitFile(repo.dir, "extra.txt", "extra content\n");
    await runGit(repo.dir, "checkout", "main");

    const result = await verifyRefs(repo.dir, "my-stack");

    expect(result.valid).toBe(false);
    expect(result.repairs).toHaveLength(2);
    expect(result.repairs.map((r) => r.branch)).toContain("feature/b");
    expect(result.repairs.map((r) => r.branch)).toContain("feature/c");
  });

  test("clean stack has no duplicates", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

    const result = await verifyRefs(repo.dir, "my-stack");

    expect(result.valid).toBe(true);
    expect(result.duplicates).toHaveLength(0);
  });

  test("detects duplicate patches across branches", async () => {
    await using repo = await createTestRepo();
    // Create A off main with a unique file
    await runGit(repo.dir, "checkout", "-b", "feature/a", "main");
    await commitFile(repo.dir, "shared.txt", "shared content\n");

    // Create B off A with its own commit
    await runGit(repo.dir, "checkout", "-b", "feature/b", "feature/a");
    await commitFile(repo.dir, "b-only.txt", "b content\n");

    // Simulate duplicate: revert A's change on B, then re-apply it.
    // This creates a commit on B whose patch-id matches A's commit.
    const aCommitHash = (
      await runGit(repo.dir, "log", "--format=%H", "main..feature/a")
    ).split("\n")[0];
    await runGit(repo.dir, "revert", "--no-edit", aCommitHash);
    await commitFile(repo.dir, "shared.txt", "shared content\n");

    await runGit(repo.dir, "checkout", "main");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

    const result = await verifyRefs(repo.dir, "my-stack");

    // Ancestry is correct (A is ancestor of B) but patches are duplicated
    expect(result.branches.every((b) => b.status === "ok")).toBe(true);
    expect(result.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(result.duplicates[0].branch).toBe("feature/b");
    expect(result.duplicates[0].originalBranch).toBe("feature/a");
    expect(result.valid).toBe(false);
  });

  test("single-branch stack is always valid", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");

    const result = await verifyRefs(repo.dir, "my-stack");

    expect(result.valid).toBe(true);
    expect(result.repairs).toHaveLength(0);
  });

  test("forked tree: ancestry checked across branches at different depths", async () => {
    await using repo = await createTestRepo();
    // Tree shape:
    //   main
    //   └── feature/a
    //       ├── feature/b
    //       └── feature/c
    //           └── feature/d
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");
    await addBranch(repo.dir, "feature/c", "feature/a");
    await addBranch(repo.dir, "feature/d", "feature/c");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
    await setStackNode(repo.dir, "feature/c", "my-stack", "feature/a");
    await setStackNode(repo.dir, "feature/d", "my-stack", "feature/c");

    const result = await verifyRefs(repo.dir, "my-stack");

    expect(result.valid).toBe(true);
    expect(result.repairs).toHaveLength(0);
    expect(result.branches).toHaveLength(4);
    expect(result.branches.every((b) => b.status === "ok")).toBe(true);

    // Now advance feature/a so that feature/b, feature/c, and feature/d are stale
    await runGit(repo.dir, "checkout", "feature/a");
    await commitFile(repo.dir, "extra.txt", "extra content\n");
    await runGit(repo.dir, "checkout", "main");

    const staleResult = await verifyRefs(repo.dir, "my-stack");

    expect(staleResult.valid).toBe(false);
    const staleBranches = staleResult.branches
      .filter((b) => b.status === "stale")
      .map((b) => b.branch);
    expect(staleBranches).toContain("feature/b");
    expect(staleBranches).toContain("feature/c");
    expect(staleBranches).toContain("feature/d");
  });

  test("skips tombstone roots whose refs no longer exist", async () => {
    // Regression: verifyRefs previously iterated tombstone roots and crashed
    // on `git merge-base` against the deleted ref. It must skip merged nodes
    // and only verify the live subtree.
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/live", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/live", "my-stack", "main");
    await addTombstone(repo.dir, "my-stack", "feature/landed", {
      prNumber: 42,
    });

    const result = await verifyRefs(repo.dir, "my-stack");

    expect(result.valid).toBe(true);
    expect(result.branches.map((b) => b.branch)).toEqual(["feature/live"]);
  });

  test("tombstone plus stale live child still reports the stale child", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
    await addTombstone(repo.dir, "my-stack", "feature/legacy", {
      prNumber: 99,
    });

    // Make feature/b stale relative to feature/a.
    await runGit(repo.dir, "checkout", "feature/a");
    await commitFile(repo.dir, "extra.txt", "x\n");
    await runGit(repo.dir, "checkout", "main");

    const result = await verifyRefs(repo.dir, "my-stack");

    expect(result.valid).toBe(false);
    expect(result.repairs.map((r) => r.branch)).toEqual(["feature/b"]);
    // Tombstone never appears in the verified set.
    expect(result.branches.map((b) => b.branch)).not.toContain(
      "feature/legacy",
    );
  });
});
