import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo } from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import {
  getAllNodes,
  getMergeStrategy,
  getStackTree,
  gitConfig,
  runGitCommand,
  setBaseBranch,
  setStackNode,
} from "../lib/stack.ts";
import {
  configFoldBranch,
  configGet,
  configInsertBranch,
  configLandCleanup,
  configMoveBranch,
  configRemoveBranch,
  configSetBranch,
  configSetStrategy,
  configSplitStack,
} from "./config.ts";

describe("config", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("configSetBranch: writes metadata readable by getStackTree", async () => {
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
    await addBranch(repo.dir, "feature/a", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");

    await configRemoveBranch(repo.dir, "feature/a");

    const tree = await getStackTree(repo.dir, "my-stack");
    expect(getAllNodes(tree)).toHaveLength(0);
  });

  test("configSetStrategy: writes strategy readable by getMergeStrategy", async () => {
    await configSetStrategy(repo.dir, "my-stack", "squash");

    const strategy = await getMergeStrategy(repo.dir, "my-stack");
    expect(strategy).toBe("squash");
  });

  test("configGet: returns tree JSON", async () => {
    await addBranch(repo.dir, "feature/a", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");

    const result = await configGet(repo.dir, "my-stack");
    const expected = await getStackTree(repo.dir, "my-stack");

    expect(result).toEqual(expected);
  });

  describe("configInsertBranch", () => {
    test("inserts branch between parent and child (reparents child)", async () => {
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
    test("single root remains after landing: no split", async () => {
      // Tree: main -> feature/a -> feature/b -> feature/c
      // Land feature/a, feature/b becomes new live root (feature/a stays as merged)
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

      // Stack has 3 nodes: feature/a (merged), feature/b, feature/c
      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);
      expect(nodes).toHaveLength(3);
      const byBranch = Object.fromEntries(nodes.map((n) => [n.branch, n]));
      expect(byBranch["feature/a"].merged).toBe(true);
      expect(byBranch["feature/b"].parent).toBe("main");
      expect(byBranch["feature/c"].parent).toBe("feature/b");
    });

    test("multi-root after landing: splits into separate stacks", async () => {
      // Tree: main -> feature/a -> feature/b
      //                         -> feature/c
      // Land feature/a, leaves two live roots: feature/b and feature/c
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
      expect(result.splitInto).toHaveLength(2);

      // Each sub-stack should have one live branch (the merged feature/a is not split into new stacks)
      const stackNames = result.splitInto.map((s) => s.stackName);
      // Derived from branch names (strip feature/ prefix)
      expect(stackNames).toContain("b");
      expect(stackNames).toContain("c");

      for (const split of result.splitInto) {
        expect(split.branches).toHaveLength(1);
        const tree = await getStackTree(repo.dir, split.stackName);
        const nodes = getAllNodes(tree);
        // Each new stack's root should have "main" as parent
        expect(nodes[0].parent).toBe("main");
      }
    });

    test("reparents direct children of landed root to base branch", async () => {
      // Linear: main -> feature/a -> feature/b
      // Land feature/a (marked merged); feature/b reparented to main
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

      const result = await configLandCleanup(
        repo.dir,
        "my-stack",
        "feature/a",
      );

      expect(result.removed).toBe("feature/a");
      expect(result.splitInto).toHaveLength(0);

      // Both nodes remain: feature/a (merged root) and feature/b (live root)
      const tree = await getStackTree(repo.dir, "my-stack");
      expect(tree.roots).toHaveLength(2);
      const liveRoots = tree.roots.filter((n) => !n.merged);
      expect(liveRoots).toHaveLength(1);
      expect(liveRoots[0].branch).toBe("feature/b");
      expect(liveRoots[0].parent).toBe("main");
    });
  });

  describe("configLandCleanup (deferred cleanup)", () => {
    test("writes stack-level tombstone instead of branch-level stack-merged", async () => {
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setBaseBranch(repo.dir, "my-stack", "main");

      await configLandCleanup(repo.dir, "my-stack", "feature/a");

      // Tombstone is at the stack level, not branch level
      const { stdout } = await runGitCommand(
        repo.dir,
        "config",
        "--get-all",
        "stack.my-stack.landed-branches",
      );
      expect(stdout).toBe("feature/a");

      // feature/b must have been reparented to main
      const tree = await getStackTree(repo.dir, "my-stack");
      const nodeB = tree.roots.find((n) =>
        n.branch === "feature/b" && !n.merged
      );
      expect(nodeB).toBeDefined();
      expect(nodeB!.parent).toBe("main");
    });

    test("does not split when only one live root remains after landing", async () => {
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setBaseBranch(repo.dir, "my-stack", "main");

      const result = await configLandCleanup(
        repo.dir,
        "my-stack",
        "feature/a",
      );

      expect(result.removed).toBe("feature/a");
      expect(result.splitInto).toHaveLength(0);
    });
  });

  describe("configSplitStack", () => {
    test("splits multi-root stack into per-subtree stacks", async () => {
      // Tree: main -> feature/x -> feature/y
      //                         -> feature/z
      await addBranch(repo.dir, "feature/x", "main");
      await addBranch(repo.dir, "feature/y", "feature/x");
      await addBranch(repo.dir, "feature/z", "feature/x");

      await setBaseBranch(repo.dir, "multi", "main");
      await setStackNode(repo.dir, "feature/x", "multi", "main");
      await setStackNode(repo.dir, "feature/y", "multi", "feature/x");
      await setStackNode(repo.dir, "feature/z", "multi", "feature/x");

      // Now make feature/x a second root too (to have 2 roots from the start)
      // Actually let's just test split on existing multi-root stack:
      // Set up so both feature/y and feature/z are roots under main directly
      await setStackNode(repo.dir, "feature/y", "multi", "main");
      await setStackNode(repo.dir, "feature/z", "multi", "main");
      // feature/x is no longer in stack (was replaced)
      // Remove feature/x's metadata
      await configRemoveBranch(repo.dir, "feature/x");

      // Now the stack has 2 roots: feature/y and feature/z
      const result = await configSplitStack(repo.dir, "multi");

      expect(result).toHaveLength(2);
      const stackNames = result.map((s) => s.stackName);
      expect(stackNames).toContain("y");
      expect(stackNames).toContain("z");

      for (const split of result) {
        const tree = await getStackTree(repo.dir, split.stackName);
        const nodes = getAllNodes(tree);
        expect(nodes[0].parent).toBe("main");
      }
    });

    test("copies tombstones to each new split stack", async () => {
      // Tree: main -> feature/a (will be tombstoned) -> feature/b, -> feature/c
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await addBranch(repo.dir, "feature/c", "feature/a");

      await setBaseBranch(repo.dir, "multi", "main");
      await setStackNode(repo.dir, "feature/a", "multi", "main");
      await setStackNode(repo.dir, "feature/b", "multi", "feature/a");
      await setStackNode(repo.dir, "feature/c", "multi", "feature/a");

      // Reparent feature/b and feature/c to main to simulate post-land state
      await setStackNode(repo.dir, "feature/b", "multi", "main");
      await setStackNode(repo.dir, "feature/c", "multi", "main");
      // feature/a is tombstoned, no longer a live node
      const { removeStackBranch, addLandedBranch, getLandedBranches } =
        await import("../lib/stack.ts");
      await removeStackBranch(repo.dir, "feature/a");
      await addLandedBranch(repo.dir, "multi", "feature/a");

      const result = await configSplitStack(repo.dir, "multi");

      expect(result).toHaveLength(2);
      const stackNames = result.map((s) => s.stackName);
      expect(stackNames).toContain("b");
      expect(stackNames).toContain("c");

      // Each new split stack should have feature/a in its tombstones
      for (const name of stackNames) {
        const landed = await getLandedBranches(repo.dir, name);
        expect(landed).toEqual(["feature/a"]);
      }

      // Original stack's config must be fully unset
      const origLanded = await getLandedBranches(repo.dir, "multi");
      expect(origLanded).toEqual([]);
      const origBase = await gitConfig(repo.dir, "stack.multi.base-branch");
      expect(origBase).toBeUndefined();
    });
  });
});
