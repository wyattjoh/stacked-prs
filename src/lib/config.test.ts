import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo } from "./testdata/helpers.ts";
import {
  getAllNodes,
  getMergeStrategy,
  getStackTree,
  gitConfig,
  setBaseBranch,
  setStackNode,
} from "./stack.ts";
import {
  configFoldBranch,
  configGet,
  configInsertBranch,
  configLandCleanup,
  configMoveBranch,
  configRemoveBranch,
  configSetBranch,
  configSetStrategy,
} from "./config.ts";

describe("config", () => {
  test("configSetBranch: writes metadata readable by getStackTree", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");

    await configSetBranch(repo.dir, {
      branch: "feature/a",
      stack: "my-stack",
      parent: "main",
    });

    const tree = await getStackTree(repo.dir, "my-stack");
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].branch).toBe("feature/a");
    expect(tree.roots[0].parent).toBe("main");
  });

  test("configRemoveBranch: removes branch from stack", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");

    await configRemoveBranch(repo.dir, "feature/a");

    const tree = await getStackTree(repo.dir, "my-stack");
    expect(getAllNodes(tree)).toHaveLength(0);
  });

  test("configSetStrategy: writes strategy readable by getMergeStrategy", async () => {
    await using repo = await createTestRepo();
    await configSetStrategy(repo.dir, "my-stack", "squash");

    const strategy = await getMergeStrategy(repo.dir, "my-stack");
    expect(strategy).toBe("squash");
  });

  test("configGet: returns tree JSON", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");

    const result = await configGet(repo.dir, "my-stack");
    const expected = await getStackTree(repo.dir, "my-stack");

    expect(result).toEqual(expected);
  });

  describe("configInsertBranch", () => {
    test("inserts branch between parent and child (reparents child)", async () => {
      await using repo = await createTestRepo();
      // Tree: main -> feature/a -> feature/b
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await addBranch(repo.dir, "feature/z", "feature/a");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

      // Insert feature/z between feature/a and feature/b
      await configInsertBranch(repo.dir, {
        stack: "my-stack",
        branch: "feature/z",
        parent: "feature/a",
        child: "feature/b",
      });

      // Tree should now be: main -> feature/a -> feature/z -> feature/b
      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);
      const byBranch = Object.fromEntries(nodes.map((n) => [n.branch, n]));

      expect(byBranch["feature/a"].parent).toBe("main");
      expect(byBranch["feature/z"].parent).toBe("feature/a");
      expect(byBranch["feature/b"].parent).toBe("feature/z");
    });

    test("inserts branch as new root (reparents old root)", async () => {
      await using repo = await createTestRepo();
      // Tree: main -> feature/a
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/z", "main");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");

      // Insert feature/z between main (base) and feature/a
      await configInsertBranch(repo.dir, {
        stack: "my-stack",
        branch: "feature/z",
        parent: "main",
        child: "feature/a",
      });

      // Tree should now be: main -> feature/z -> feature/a
      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);
      const byBranch = Object.fromEntries(nodes.map((n) => [n.branch, n]));

      expect(byBranch["feature/z"].parent).toBe("main");
      expect(byBranch["feature/a"].parent).toBe("feature/z");
    });
  });

  describe("configFoldBranch", () => {
    test("reparents children of folded branch to its parent, then removes it", async () => {
      await using repo = await createTestRepo();
      // Tree: main -> feature/a -> feature/b -> feature/c
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await addBranch(repo.dir, "feature/c", "feature/b");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setStackNode(repo.dir, "feature/c", "my-stack", "feature/b");

      const result = await configFoldBranch(repo.dir, "my-stack", "feature/b");

      expect(result.removed).toBe("feature/b");

      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);
      expect(nodes).toHaveLength(2);
      const byBranch = Object.fromEntries(nodes.map((n) => [n.branch, n]));

      expect(byBranch["feature/a"].parent).toBe("main");
      expect(byBranch["feature/c"].parent).toBe("feature/a");
    });

    test("folds leaf branch (no children): just removes it", async () => {
      await using repo = await createTestRepo();
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

      const result = await configFoldBranch(repo.dir, "my-stack", "feature/b");

      expect(result.removed).toBe("feature/b");

      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].branch).toBe("feature/a");
    });

    test("folds middle branch with multiple children: reparents all children", async () => {
      await using repo = await createTestRepo();
      // Tree: main -> feature/a -> feature/b -> feature/c
      //                                      -> feature/d
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await addBranch(repo.dir, "feature/c", "feature/b");
      await addBranch(repo.dir, "feature/d", "feature/b");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setStackNode(repo.dir, "feature/c", "my-stack", "feature/b");
      await setStackNode(repo.dir, "feature/d", "my-stack", "feature/b");

      const result = await configFoldBranch(repo.dir, "my-stack", "feature/b");

      expect(result.removed).toBe("feature/b");

      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);
      expect(nodes).toHaveLength(3);
      const byBranch = Object.fromEntries(nodes.map((n) => [n.branch, n]));

      expect(byBranch["feature/a"].parent).toBe("main");
      // Both children should now point to feature/a
      expect(byBranch["feature/c"].parent).toBe("feature/a");
      expect(byBranch["feature/d"].parent).toBe("feature/a");
    });
  });

  describe("configMoveBranch", () => {
    test("moves branch to a new parent (detaches from old, reattaches)", async () => {
      await using repo = await createTestRepo();
      // Tree: main -> feature/a -> feature/b -> feature/c
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await addBranch(repo.dir, "feature/c", "feature/b");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setStackNode(repo.dir, "feature/c", "my-stack", "feature/b");

      // Move feature/b to be a child of feature/c (swap order of b and c)
      await configMoveBranch(repo.dir, {
        stack: "my-stack",
        branch: "feature/b",
        newParent: "feature/c",
      });

      // Tree should be: main -> feature/a -> feature/c -> feature/b
      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);
      const byBranch = Object.fromEntries(nodes.map((n) => [n.branch, n]));

      expect(byBranch["feature/a"].parent).toBe("main");
      expect(byBranch["feature/c"].parent).toBe("feature/a");
      expect(byBranch["feature/b"].parent).toBe("feature/c");
    });

    test("moves root branch to be child of another branch", async () => {
      await using repo = await createTestRepo();
      // Tree: main -> feature/a
      //            -> feature/b (also root, second root scenario)
      // Actually make a linear tree and move the root to be a leaf
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

      // Move feature/a to be a child of feature/b
      await configMoveBranch(repo.dir, {
        stack: "my-stack",
        branch: "feature/a",
        newParent: "feature/b",
      });

      // Tree should be: main -> feature/b -> feature/a
      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);
      const byBranch = Object.fromEntries(nodes.map((n) => [n.branch, n]));

      expect(byBranch["feature/b"].parent).toBe("main");
      expect(byBranch["feature/a"].parent).toBe("feature/b");
    });
  });

  describe("configLandCleanup", () => {
    test("reparents children to merged branch's parent and removes its config", async () => {
      await using repo = await createTestRepo();
      // Tree: main -> feature/a -> feature/b -> feature/c
      // Land feature/a; feature/b and feature/c are reparented (feature/b to
      // main since it was a direct child; feature/c keeps pointing at
      // feature/b which still exists in this scenario).
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await addBranch(repo.dir, "feature/c", "feature/b");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setStackNode(repo.dir, "feature/c", "my-stack", "feature/b");

      const result = await configLandCleanup(
        repo.dir,
        "my-stack",
        "feature/a",
      );

      expect(result.removed).toBe("feature/a");
      expect(result.splitInto).toHaveLength(0);

      // feature/a's config is gone; feature/b now points at main; feature/c
      // still points at feature/b.
      expect(await gitConfig(repo.dir, "branch.feature/a.stack-parent"))
        .toBeUndefined();
      expect(await gitConfig(repo.dir, "branch.feature/b.stack-parent"))
        .toBe("main");
      expect(await gitConfig(repo.dir, "branch.feature/c.stack-parent"))
        .toBe("feature/b");
    });

    test("reparents fan-out children to the merged branch's parent", async () => {
      await using repo = await createTestRepo();
      // Tree: main -> feature/a -> feature/b
      //                         -> feature/c
      // Land feature/a; both children get reparented to main.
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await addBranch(repo.dir, "feature/c", "feature/a");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setStackNode(repo.dir, "feature/c", "my-stack", "feature/a");

      const result = await configLandCleanup(
        repo.dir,
        "my-stack",
        "feature/a",
      );

      expect(result.removed).toBe("feature/a");
      expect(result.splitInto).toHaveLength(0);

      expect(await gitConfig(repo.dir, "branch.feature/a.stack-parent"))
        .toBeUndefined();
      expect(await gitConfig(repo.dir, "branch.feature/b.stack-parent"))
        .toBe("main");
      expect(await gitConfig(repo.dir, "branch.feature/c.stack-parent"))
        .toBe("main");
    });

    test("landing a leaf branch removes only its own config", async () => {
      await using repo = await createTestRepo();
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

      const result = await configLandCleanup(
        repo.dir,
        "my-stack",
        "feature/b",
      );

      expect(result.removed).toBe("feature/b");
      expect(await gitConfig(repo.dir, "branch.feature/b.stack-parent"))
        .toBeUndefined();
      expect(await gitConfig(repo.dir, "branch.feature/a.stack-parent"))
        .toBe("main");
    });
  });
});
