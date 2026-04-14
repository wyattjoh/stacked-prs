import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  commitFile,
  createTestRepo,
  makeTempDir,
} from "../lib/testdata/helpers.ts";
import { runGitCommand, setBaseBranch, setStackNode } from "../lib/stack.ts";
import { computeSyncPlan, renderSyncPlan } from "./sync.ts";

async function setupStack(
  dir: string,
  stack: string,
  branches: Array<[string, string]>,
): Promise<void> {
  await setBaseBranch(dir, stack, "main");
  for (const [b, parent] of branches) {
    await setStackNode(dir, b, stack, parent);
  }
}

describe("computeSyncPlan", () => {
  test("collects all stacks and their base branches", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "a/1", "main");
    await addBranch(repo.dir, "b/1", "main");
    await setupStack(repo.dir, "stack-a", [["a/1", "main"]]);
    await setupStack(repo.dir, "stack-b", [["b/1", "main"]]);

    // Wire up origin/main so planRestack's root-target resolution works.
    const bare = await makeTempDir("bare-");
    await runGitCommand(repo.dir, "init", "--bare", "-q", bare.path);
    await runGitCommand(repo.dir, "remote", "add", "origin", bare.path);
    await runGitCommand(repo.dir, "push", "origin", "main");

    const plan = await computeSyncPlan(repo.dir);
    expect(plan.baseBranches).toEqual(["main"]);
    expect(plan.stacks.map((s) => s.stackName).sort()).toEqual([
      "stack-a",
      "stack-b",
    ]);
    expect(plan.isNoOp).toBe(true);

    await bare[Symbol.asyncDispose]();
  });

  test("marks stacks behind their base as needing a push", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setupStack(repo.dir, "s", [["feat/a", "main"]]);

    const bare = await makeTempDir("bare-");
    await runGitCommand(repo.dir, "init", "--bare", "-q", bare.path);
    await runGitCommand(repo.dir, "remote", "add", "origin", bare.path);
    await runGitCommand(repo.dir, "push", "origin", "main");

    // Advance origin/main past the stack by committing on main and pushing.
    await runGitCommand(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "drift.txt", "drift");
    await runGitCommand(repo.dir, "push", "origin", "main");
    await runGitCommand(repo.dir, "checkout", "feat/a");

    const plan = await computeSyncPlan(repo.dir);
    const s = plan.stacks.find((s) => s.stackName === "s")!;
    expect(s.branchesToPush).toEqual(["feat/a"]);
    expect(plan.isNoOp).toBe(false);

    await bare[Symbol.asyncDispose]();
  });

  test("renderSyncPlan reports no-op", () => {
    expect(
      renderSyncPlan({ stacks: [], baseBranches: [], isNoOp: true }),
    ).toContain("All stacks are already synced");
  });
});
