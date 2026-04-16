import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  createTestRepo,
  runGit,
} from "../lib/testdata/helpers.ts";
import { setBaseBranch } from "../lib/stack.ts";
import { importStack, planImport } from "./import.ts";

async function setupBranchChain(dir: string): Promise<void> {
  await addBranch(dir, "feat/a", "main");
  await addBranch(dir, "feat/b", "feat/a");
  await addBranch(dir, "feat/c", "feat/b");
}

describe("import — plan", () => {
  test("plans import with flattened entries starting from leaf", async () => {
    await using repo = await createTestRepo();
    await setupBranchChain(repo.dir);
    await runGit(repo.dir, "checkout", "feat/c");

    const result = await planImport(repo.dir, {});
    expect(result.ok).toBe(true);
    expect(result.plan?.entries).toEqual([
      { branch: "feat/a", parent: "main" },
      { branch: "feat/b", parent: "feat/a" },
      { branch: "feat/c", parent: "feat/b" },
    ]);
    expect(result.plan?.baseBranch).toBe("main");
    expect(result.plan?.stackName).toBe("feat/a");
    expect(result.plan?.mergeStrategy).toBe("squash");
  });

  test("honors stack.default-merge-strategy git config override", async () => {
    await using repo = await createTestRepo();
    await setupBranchChain(repo.dir);
    await runGit(repo.dir, "checkout", "feat/c");
    await runGit(
      repo.dir,
      "config",
      "stack.default-merge-strategy",
      "merge",
    );

    const result = await planImport(repo.dir, {});
    expect(result.ok).toBe(true);
    expect(result.plan?.mergeStrategy).toBe("merge");
  });

  test("honors --stack-name and --merge-strategy", async () => {
    await using repo = await createTestRepo();
    await setupBranchChain(repo.dir);
    await runGit(repo.dir, "checkout", "feat/c");

    const result = await planImport(repo.dir, {
      stackName: "my-stack",
      mergeStrategy: "squash",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.stackName).toBe("my-stack");
    expect(result.plan?.mergeStrategy).toBe("squash");
  });

  test("rejects when no chain discovered (on base branch)", async () => {
    await using repo = await createTestRepo();
    const result = await planImport(repo.dir, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("nothing-discovered");
  });

  test("rejects when any discovered branch is already in a stack", async () => {
    await using repo = await createTestRepo();
    await setupBranchChain(repo.dir);
    await runGit(repo.dir, "config", "branch.feat/b.stack-name", "existing");
    await runGit(repo.dir, "checkout", "feat/c");

    const result = await planImport(repo.dir, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("already-in-stack");
  });

  test("rejects when stack name already exists", async () => {
    await using repo = await createTestRepo();
    await setupBranchChain(repo.dir);
    await runGit(repo.dir, "checkout", "feat/c");
    await runGit(repo.dir, "config", "stack.taken.base-branch", "main");

    const result = await planImport(repo.dir, { stackName: "taken" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stack-exists");
  });
});

describe("import — execute (real git)", () => {
  test("writes full stack metadata for discovered chain", async () => {
    await using repo = await createTestRepo();
    await setupBranchChain(repo.dir);
    await runGit(repo.dir, "checkout", "feat/c");

    const result = await importStack(repo.dir, { stackName: "my-stack" });
    expect(result.ok).toBe(true);

    for (
      const [branch, parent] of [
        ["feat/a", "main"],
        ["feat/b", "feat/a"],
        ["feat/c", "feat/b"],
      ] as const
    ) {
      expect(
        await runGit(repo.dir, "config", `branch.${branch}.stack-name`),
      ).toBe("my-stack");
      expect(
        await runGit(repo.dir, "config", `branch.${branch}.stack-parent`),
      ).toBe(parent);
    }
    expect(
      await runGit(repo.dir, "config", "stack.my-stack.base-branch"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "stack.my-stack.merge-strategy"),
    ).toBe("squash");
  });

  test("dry-run mutates nothing", async () => {
    await using repo = await createTestRepo();
    await setupBranchChain(repo.dir);
    await runGit(repo.dir, "checkout", "feat/c");

    await importStack(repo.dir, { dryRun: true });

    const probe = await runGit(
      repo.dir,
      "config",
      "branch.feat/a.stack-name",
    ).catch(() => "");
    expect(probe).toBe("");
  });

  test("imports a chain while an unrelated stack has tombstones", async () => {
    // Tombstones are stack-level config; they do not affect import-discover's
    // branch-graph traversal. A newly imported stack under a different name
    // must succeed.
    await using repo = await createTestRepo();
    await setBaseBranch(repo.dir, "old", "main");
    await addTombstone(repo.dir, "old", "feat/old", { prNumber: 91 });

    await setupBranchChain(repo.dir);
    await runGit(repo.dir, "checkout", "feat/c");

    const result = await importStack(repo.dir, { stackName: "new-stack" });
    expect(result.ok).toBe(true);
    expect(result.plan?.stackName).toBe("new-stack");
    expect(result.plan?.entries.map((e) => e.branch).sort()).toEqual([
      "feat/a",
      "feat/b",
      "feat/c",
    ]);
  });
});
