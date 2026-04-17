import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo } from "./testdata/helpers.ts";
import {
  getLandedBranches,
  gitConfig,
  setBaseBranch,
  setStackNode,
} from "./stack.ts";
import { configBranchCleanup, projectTreeAfterRemoval } from "./cleanup.ts";
import { getStackTree } from "./stack.ts";

async function getStackParent(
  dir: string,
  branch: string,
): Promise<string | undefined> {
  return await gitConfig(dir, `branch.${branch}.stack-parent`);
}

describe("configBranchCleanup", () => {
  test("records the branch as a tombstone in landed-branches", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");

    await configBranchCleanup(repo.dir, "s", "feat/a");

    const landed = await getLandedBranches(repo.dir, "s");
    expect(landed).toContain("feat/a");
  });

  test("preserves the tombstoned branch's own stack-name/stack-parent config", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");

    await configBranchCleanup(repo.dir, "s", "feat/a");

    expect(await gitConfig(repo.dir, "branch.feat/a.stack-name")).toBe("s");
    expect(await gitConfig(repo.dir, "branch.feat/a.stack-parent")).toBe(
      "main",
    );
  });

  test("leaves live children's stack-parent pointing at the tombstone", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");

    await configBranchCleanup(repo.dir, "s", "feat/a");

    expect(await getStackParent(repo.dir, "feat/b")).toBe("feat/a");
  });

  test("is idempotent when called twice for the same branch", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");

    await configBranchCleanup(repo.dir, "s", "feat/a");
    await configBranchCleanup(repo.dir, "s", "feat/a");

    const landed = await getLandedBranches(repo.dir, "s");
    expect(landed.filter((b) => b === "feat/a")).toHaveLength(1);
  });

  test("records landed-pr when prNumber is supplied", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");

    const { getLandedPrs } = await import("./stack.ts");
    await configBranchCleanup(repo.dir, "s", "feat/a", 42);

    const prs = await getLandedPrs(repo.dir, "s");
    expect(prs.get("feat/a")).toBe(42);
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

  test("getStackTree renders the tombstone with live children nested under it", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");

    await configBranchCleanup(repo.dir, "s", "feat/a");

    const tree = await getStackTree(repo.dir, "s");
    expect(tree.roots).toHaveLength(1);
    const [root] = tree.roots;
    expect(root.branch).toBe("feat/a");
    expect(root.merged).toBe(true);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].branch).toBe("feat/b");
    expect(root.children[0].merged).toBeFalsy();
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

    // feat/a is already a tombstone; feat/b is newly merged. feat/c's live
    // effective parent should walk past both to main.
    await configBranchCleanup(repo.dir, "s", "feat/a");
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
