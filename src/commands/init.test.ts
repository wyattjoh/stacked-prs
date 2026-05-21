import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  createTestRepo,
  runGit,
} from "../lib/testdata/helpers.ts";
import { setBranchBaseBranch } from "../lib/stack.ts";
import { init, planInit } from "./init.ts";

describe("init — plan", () => {
  test("plans init for current branch, defaulting merge strategy", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await planInit(repo.dir, {});
    expect(result.ok).toBe(true);
    expect(result.plan?.branch).toBe("feat/a");
    expect(result.plan?.stackName).toBe("feat/a");
    expect(result.plan?.baseBranch).toBe("main");
    expect(result.plan?.mergeStrategy).toBe("squash");
    expect(result.plan?.commands).toEqual([
      "git config branch.feat/a.stack-parent main",
      "git config branch.feat/a.base-branch main",
      "git config branch.feat/a.merge-strategy squash",
    ]);
  });

  test("honors stack.default-merge-strategy git config override", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");
    await runGit(
      repo.dir,
      "config",
      "stack.default-merge-strategy",
      "merge",
    );

    const result = await planInit(repo.dir, {});
    expect(result.ok).toBe(true);
    expect(result.plan?.mergeStrategy).toBe("merge");
  });

  test("honors --merge-strategy", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await planInit(repo.dir, { mergeStrategy: "squash" });
    expect(result.ok).toBe(true);
    expect(result.plan?.stackName).toBe("feat/a");
    expect(result.plan?.mergeStrategy).toBe("squash");
  });

  test("rejects running on the base branch", async () => {
    await using repo = await createTestRepo();
    const result = await planInit(repo.dir, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("on-base-branch");
  });

  test("rejects when branch already tracked", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");
    await runGit(repo.dir, "config", "branch.feat/a.stack-parent", "main");

    const result = await planInit(repo.dir, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("already-in-stack");
  });
});

describe("init — execute (real git)", () => {
  test("writes stack metadata", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await init(repo.dir, { mergeStrategy: "squash" });
    expect(result.ok).toBe(true);

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

  test("dry-run mutates nothing", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await init(repo.dir, { dryRun: true });
    expect(result.ok).toBe(true);

    const probe = await runGit(
      repo.dir,
      "config",
      "branch.feat/a.stack-parent",
    ).catch(() => "");
    expect(probe).toBe("");
  });

  test("initializes a new stack while an unrelated stack has tombstones", async () => {
    await using repo = await createTestRepo();
    await setBranchBaseBranch(repo.dir, "feat/old", "main");
    await addTombstone(repo.dir, "old-stack", "feat/old", { prNumber: 81 });

    await addBranch(repo.dir, "feat/new", "main");
    await runGit(repo.dir, "checkout", "feat/new");

    const result = await init(repo.dir, {});
    expect(result.ok).toBe(true);
    expect(
      await runGit(repo.dir, "config", "branch.feat/new.stack-parent"),
    ).toBe("main");
  });
});
