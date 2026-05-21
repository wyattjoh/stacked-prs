import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, addTombstone, createTestRepo } from "./testdata/helpers.ts";
import { gitConfig, setBaseBranch, setStackNode } from "./stack.ts";
import { configBranchCleanup, projectTreeAfterRemoval } from "./cleanup.ts";
import { getStackTree } from "./stack.ts";

async function getStackParent(
  dir: string,
  branch: string,
): Promise<string | undefined> {
  return await gitConfig(dir, `branch.${branch}.stack-parent`);
}

describe("configBranchCleanup", () => {
  test("reparents direct children to the merged branch's parent", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");

    await configBranchCleanup(repo.dir, "s", "feat/a");

    // feat/b should now point to main, not feat/a.
    expect(await getStackParent(repo.dir, "feat/b")).toBe("main");
  });

  test("removes the merged branch from the stack config", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");

    await configBranchCleanup(repo.dir, "s", "feat/a");

    // stack-name and stack-parent config for feat/a should be gone.
    expect(await gitConfig(repo.dir, "branch.feat/a.stack-name"))
      .toBeUndefined();
    expect(await gitConfig(repo.dir, "branch.feat/a.stack-parent"))
      .toBeUndefined();
  });

  test("reparents multiple children to the merged branch's parent", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");
    await setStackNode(repo.dir, "feat/c", "s", "feat/a");

    await configBranchCleanup(repo.dir, "s", "feat/a");

    expect(await getStackParent(repo.dir, "feat/b")).toBe("main");
    expect(await getStackParent(repo.dir, "feat/c")).toBe("main");
  });

  test("accepts a prNumber argument without error (for call-site compatibility)", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");

    // prNumber is accepted but no longer recorded anywhere.
    await configBranchCleanup(repo.dir, "s", "feat/a", 42);

    // Config for feat/a is removed.
    expect(await gitConfig(repo.dir, "branch.feat/a.stack-name"))
      .toBeUndefined();
  });

  test("throws when branch is not a stack member", async () => {
    await using repo = await createTestRepo();
    await setBaseBranch(repo.dir, "s", "main");

    let caught: Error | null = null;
    try {
      await configBranchCleanup(repo.dir, "s", "feat/unknown");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("feat/unknown");
    expect(caught!.message).toContain("is not a member of stack");
  });

  test("getStackTree shows the reparented child as the new root after cleanup", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");

    await configBranchCleanup(repo.dir, "s", "feat/a");

    // feat/a is removed; feat/b is now the root.
    const tree = await getStackTree(repo.dir, "s");
    expect(tree.roots).toHaveLength(1);
    const [root] = tree.roots;
    expect(root.branch).toBe("feat/b");
    expect(root.merged).toBeFalsy();
    expect(root.parent).toBe("main");
    expect(root.children).toHaveLength(0);
  });
});

describe("projectTreeAfterRemoval", () => {
  test("walks past newly merged branches to find the live effective parent", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");

    const tree = await getStackTree(repo.dir, "s");
    const projection = projectTreeAfterRemoval(tree, new Set(["feat/a"]));

    expect(projection.newParents.get("feat/b")).toBe("main");
    expect(projection.remainingRoots).toEqual(["feat/b"]);
    expect(projection.splits).toEqual([]);
  });

  test("walks past existing tombstones as well as the newly merged set", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/b");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");
    await setStackNode(repo.dir, "feat/c", "s", "feat/b");

    // Use addTombstone to inject a legacy tombstone directly, since
    // configBranchCleanup no longer writes tombstone config.
    await addTombstone(repo.dir, "s", "feat/a", {});
    const tree = await getStackTree(repo.dir, "s");

    const projection = projectTreeAfterRemoval(tree, new Set(["feat/b"]));

    expect(projection.newParents.get("feat/c")).toBe("main");
    expect(projection.remainingRoots).toEqual(["feat/c"]);
  });

  test("returns empty newParents when removal set is disjoint from live chain", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");

    const tree = await getStackTree(repo.dir, "s");
    const projection = projectTreeAfterRemoval(tree, new Set<string>());

    expect(projection.newParents.size).toBe(0);
    expect(projection.splits).toEqual([]);
  });

  test("returns split projections when multiple live children survive", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/root", "main");
    await addBranch(repo.dir, "feat/a", "feat/root");
    await addBranch(repo.dir, "feat/b", "feat/root");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/root", "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "feat/root");
    await setStackNode(repo.dir, "feat/b", "s", "feat/root");

    const tree = await getStackTree(repo.dir, "s");
    const projection = projectTreeAfterRemoval(
      tree,
      new Set(["feat/root"]),
    );

    expect(projection.remainingRoots.sort()).toEqual(["feat/a", "feat/b"]);
    expect(projection.splits.map((s) => s.stackName).sort()).toEqual([
      "feat/a",
      "feat/b",
    ]);
  });
});
