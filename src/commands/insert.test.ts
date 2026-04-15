import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo, runGit } from "../lib/testdata/helpers.ts";
import { insert, planInsert } from "./insert.ts";

/** Register a linear 2-branch stack: main <- feat/a <- feat/c. */
async function setupTwoBranchStack(dir: string): Promise<void> {
  await addBranch(dir, "feat/a", "main");
  await addBranch(dir, "feat/c", "feat/a");
  await runGit(dir, "config", "branch.feat/a.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/a.stack-parent", "main");
  await runGit(dir, "config", "branch.feat/c.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/c.stack-parent", "feat/a");
  await runGit(dir, "config", "stack.my-stack.base-branch", "main");
  await runGit(dir, "config", "stack.my-stack.merge-strategy", "merge");
}

describe("insert — plan", () => {
  test("plans inserting feat/b between feat/a and feat/c", async () => {
    await using repo = await createTestRepo();
    await setupTwoBranchStack(repo.dir);

    const result = await planInsert(repo.dir, {
      stackName: "my-stack",
      child: "feat/c",
      branch: "feat/b",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.parent).toBe("feat/a");
    expect(result.plan?.commands).toEqual([
      "git checkout -b feat/b feat/a",
      "git config branch.feat/b.stack-name my-stack",
      "git config branch.feat/b.stack-parent feat/a",
      "git config branch.feat/c.stack-parent feat/b",
    ]);
  });

  test("rejects invalid branch name", async () => {
    await using repo = await createTestRepo();
    await setupTwoBranchStack(repo.dir);
    const result = await planInsert(repo.dir, {
      stackName: "my-stack",
      child: "feat/c",
      branch: "has spaces",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-branch-name");
  });

  test("rejects existing branch name", async () => {
    await using repo = await createTestRepo();
    await setupTwoBranchStack(repo.dir);
    const result = await planInsert(repo.dir, {
      stackName: "my-stack",
      child: "feat/c",
      branch: "feat/a",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("branch-exists");
  });

  test("rejects child not in stack", async () => {
    await using repo = await createTestRepo();
    await setupTwoBranchStack(repo.dir);
    const result = await planInsert(repo.dir, {
      stackName: "my-stack",
      child: "feat/x",
      branch: "feat/b",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("child-not-in-stack");
  });
});

describe("insert — execute (real git)", () => {
  test("creates branch and rewires parent/child config", async () => {
    await using repo = await createTestRepo();
    await setupTwoBranchStack(repo.dir);

    const result = await insert(repo.dir, {
      stackName: "my-stack",
      child: "feat/c",
      branch: "feat/b",
    });
    expect(result.ok).toBe(true);

    // Branch ref created off feat/a.
    const current = await runGit(repo.dir, "branch", "--show-current");
    expect(current).toBe("feat/b");

    // Config wired up.
    expect(
      await runGit(repo.dir, "config", "branch.feat/b.stack-name"),
    ).toBe("my-stack");
    expect(
      await runGit(repo.dir, "config", "branch.feat/b.stack-parent"),
    ).toBe("feat/a");
    expect(
      await runGit(repo.dir, "config", "branch.feat/c.stack-parent"),
    ).toBe("feat/b");
  });

  test("dry-run mutates nothing", async () => {
    await using repo = await createTestRepo();
    await setupTwoBranchStack(repo.dir);

    const result = await insert(repo.dir, {
      stackName: "my-stack",
      child: "feat/c",
      branch: "feat/b",
      dryRun: true,
    });
    expect(result.ok).toBe(true);

    const probe = await runGit(
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/feat/b",
    ).catch(() => "");
    expect(probe).toBe("");

    const cParent = await runGit(
      repo.dir,
      "config",
      "branch.feat/c.stack-parent",
    );
    expect(cParent).toBe("feat/a");
  });
});
