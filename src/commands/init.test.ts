import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo, runGit } from "../lib/testdata/helpers.ts";
import { init, planInit } from "./init.ts";

describe("init — plan", () => {
  test("plans init for current branch, defaulting stack name and merge strategy", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await planInit(repo.dir, {});
    expect(result.ok).toBe(true);
    expect(result.plan?.branch).toBe("feat/a");
    expect(result.plan?.stackName).toBe("feat/a");
    expect(result.plan?.baseBranch).toBe("main");
    expect(result.plan?.mergeStrategy).toBe("merge");
    expect(result.plan?.commands).toEqual([
      "git config branch.feat/a.stack-name feat/a",
      "git config branch.feat/a.stack-parent main",
      "git config stack.feat/a.base-branch main",
      "git config stack.feat/a.merge-strategy merge",
    ]);
  });

  test("honors --stack-name and --merge-strategy", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await planInit(repo.dir, {
      stackName: "my-stack",
      mergeStrategy: "squash",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.stackName).toBe("my-stack");
    expect(result.plan?.mergeStrategy).toBe("squash");
  });

  test("rejects running on the base branch", async () => {
    await using repo = await createTestRepo();
    const result = await planInit(repo.dir, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("on-base-branch");
  });

  test("rejects when branch already in a stack", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");
    await runGit(repo.dir, "config", "branch.feat/a.stack-name", "existing");

    const result = await planInit(repo.dir, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("already-in-stack");
  });

  test("rejects when stack name already exists", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");
    await runGit(repo.dir, "config", "stack.taken.base-branch", "main");

    const result = await planInit(repo.dir, { stackName: "taken" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stack-exists");
  });
});

describe("init — execute (real git)", () => {
  test("writes stack metadata", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await init(repo.dir, {
      stackName: "my-stack",
      mergeStrategy: "squash",
    });
    expect(result.ok).toBe(true);

    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-name"),
    ).toBe("my-stack");
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-parent"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "stack.my-stack.base-branch"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "stack.my-stack.merge-strategy"),
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
      "branch.feat/a.stack-name",
    ).catch(() => "");
    expect(probe).toBe("");
  });
});
