import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  createTestRepo,
  runGit,
  trackBranch,
} from "../lib/testdata/helpers.ts";
import { getStackTree } from "../lib/stack.ts";
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

async function configValue(
  dir: string,
  key: string,
): Promise<string | undefined> {
  return await runGit(dir, "config", key).catch(() => undefined);
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

  test("v3 insert keeps the root stack readable without stack-name keys", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/c", "feat/a");
    await trackBranch(repo.dir, "feat/a", {
      parent: "main",
      baseBranch: "main",
      mergeStrategy: "merge",
    });
    await trackBranch(repo.dir, "feat/c", {
      parent: "feat/a",
      baseBranch: "main",
      mergeStrategy: "merge",
    });

    const result = await insert(repo.dir, {
      stackName: "feat/a",
      child: "feat/c",
      branch: "feat/b",
    });
    expect(result.ok).toBe(true);

    const tree = await getStackTree(repo.dir, "feat/a");
    expect(tree.roots.map((root) => root.branch)).toEqual(["feat/a"]);
    expect(tree.roots[0].children.map((child) => child.branch)).toEqual([
      "feat/b",
    ]);
    expect(tree.roots[0].children[0].children.map((child) => child.branch))
      .toEqual(["feat/c"]);
    expect(await configValue(repo.dir, "branch.feat/b.stack-name"))
      .toBeUndefined();
    expect(await configValue(repo.dir, "branch.feat/b.base-branch")).toBe(
      "main",
    );
    expect(await configValue(repo.dir, "branch.feat/b.merge-strategy")).toBe(
      "merge",
    );
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

  test("inserts alongside an existing tombstone", async () => {
    await using repo = await createTestRepo();
    await setupTwoBranchStack(repo.dir);
    await addTombstone(repo.dir, "my-stack", "feat/landed", { prNumber: 101 });

    const result = await planInsert(repo.dir, {
      stackName: "my-stack",
      child: "feat/c",
      branch: "feat/b",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.parent).toBe("feat/a");
  });

  test("rejects a tombstoned branch as the child", async () => {
    await using repo = await createTestRepo();
    await setupTwoBranchStack(repo.dir);
    await addTombstone(repo.dir, "my-stack", "feat/landed", { prNumber: 102 });

    const result = await planInsert(repo.dir, {
      stackName: "my-stack",
      child: "feat/landed",
      branch: "feat/b",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("child-not-in-stack");
  });
});
