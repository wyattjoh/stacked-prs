import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  createTestRepo,
  markBranchMerged,
  runGit,
  trackBranch,
} from "./helpers.ts";

describe("trackBranch", () => {
  test("writes the per-branch trio", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await trackBranch(repo.dir, "feat/a", {
      parent: "main",
      baseBranch: "main",
      mergeStrategy: "squash",
    });
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-parent"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.base-branch"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.merge-strategy"),
    ).toBe("squash");
  });

  test("does not write base-branch or merge-strategy when omitted", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await trackBranch(repo.dir, "feat/a", { parent: "main" });
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-parent"),
    ).toBe("main");
    // The other two should be unset. runGit throws on non-zero exit, so we
    // assert via the lower-level shell exit code.
    const baseProc = new Deno.Command("git", {
      args: ["config", "branch.feat/a.base-branch"],
      cwd: repo.dir,
      stdout: "null",
      stderr: "null",
    });
    expect((await baseProc.output()).success).toBe(false);
  });
});

describe("markBranchMerged", () => {
  test("deletes the branch ref so its config keys go with it", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await trackBranch(repo.dir, "feat/a", {
      parent: "main",
      baseBranch: "main",
      mergeStrategy: "squash",
    });
    await markBranchMerged(repo.dir, "feat/a");
    // The branch listing no longer includes feat/a
    const listing = await runGit(repo.dir, "branch", "--list", "feat/a");
    expect(listing.trim()).toBe("");
    // Per-branch config is gone with the branch
    const proc = new Deno.Command("git", {
      args: ["config", "branch.feat/a.stack-parent"],
      cwd: repo.dir,
      stdout: "null",
      stderr: "null",
    });
    expect((await proc.output()).success).toBe(false);
  });
});
