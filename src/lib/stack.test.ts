import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo, runGit } from "./testdata/helpers.ts";
import {
  addLandedBranch,
  addLandedParent,
  addLandedPr,
  effectiveParent,
  findNode,
  getAllNodes,
  getAllStackTrees,
  getBaseBranch,
  getLandedBranches,
  getLandedParents,
  getLandedPrs,
  getLeaves,
  getLiveSubtreeRoots,
  getMergeStrategy,
  getPathTo,
  getStackTree,
  getSubtree,
  listAllStacks,
  removeStackBranch,
  renderTree,
  runGitCommand,
  setBaseBranch,
  setMergeStrategy,
  setStackBranch,
  setStackNode,
  validateStackTree,
  walkDFS,
} from "./stack.ts";
import type { StackNode, StackTree } from "./stack.ts";

describe("stack", () => {
  test("merge strategy: writes and reads", async () => {
    await using repo = await createTestRepo();
    await setMergeStrategy(repo.dir, "my-stack", "squash");
    const strategy = await getMergeStrategy(repo.dir, "my-stack");
    expect(strategy).toBe("squash");
  });

  test("merge strategy: returns undefined for unset", async () => {
    await using repo = await createTestRepo();
    const strategy = await getMergeStrategy(repo.dir, "no-such-stack");
    expect(strategy).toBeUndefined();
  });

  describe("removeStackBranch", () => {
    test("removes stack metadata for a branch", async () => {
      await using repo = await createTestRepo();
      await addBranch(repo.dir, "feature/auth", "main");
      await setBaseBranch(repo.dir, "auth-stack", "main");
      await setStackNode(repo.dir, "feature/auth", "auth-stack", "main");

      await removeStackBranch(repo.dir, "feature/auth");

      const tree = await getStackTree(repo.dir, "auth-stack");
      expect(tree.roots).toHaveLength(0);
    });

    test("does not affect other branches in the stack", async () => {
      await using repo = await createTestRepo();
      await addBranch(repo.dir, "feature/step1", "main");
      await addBranch(repo.dir, "feature/step2", "feature/step1");

      await setBaseBranch(repo.dir, "my-stack", "main");
      await setStackNode(repo.dir, "feature/step1", "my-stack", "main");
      await setStackNode(
        repo.dir,
        "feature/step2",
        "my-stack",
        "feature/step1",
      );

      await removeStackBranch(repo.dir, "feature/step1");

      // step1's config keys should be gone
      const step1Name = await runGitCommand(
        repo.dir,
        "config",
        "branch.feature/step1.stack-name",
      );
      expect(step1Name.code).not.toBe(0);

      // step2's config keys should still be intact
      const step2Name = await runGitCommand(
        repo.dir,
        "config",
        "branch.feature/step2.stack-name",
      );
      expect(step2Name.code).toBe(0);
      expect(step2Name.stdout).toBe("my-stack");
    });
  });
});

describe("validateStackTree", () => {
  test("valid tree passes validation", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/step1", "main");
    await addBranch(repo.dir, "feature/step2", "feature/step1");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/step1", "my-stack", "main");
    await setStackNode(repo.dir, "feature/step2", "my-stack", "feature/step1");

    const tree = await getStackTree(repo.dir, "my-stack");
    const result = await validateStackTree(repo.dir, tree);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("detects missing git ref", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/real", "main");
    await setBaseBranch(repo.dir, "ghost-stack", "main");
    await setStackNode(repo.dir, "feature/real", "ghost-stack", "main");

    const tree = await getStackTree(repo.dir, "ghost-stack");

    // Manually mutate the tree to reference a branch that doesn't exist
    tree.roots[0] = { ...tree.roots[0], branch: "feature/ghost" };

    const result = await validateStackTree(repo.dir, tree);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e: string) => e.includes("feature/ghost")),
    ).toBe(true);
    expect(
      result.errors.some((e: string) => e.includes("does not exist")),
    ).toBe(true);
  });

  test("detects orphaned branch", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/base", "main");
    await addBranch(repo.dir, "feature/child", "feature/base");
    await setBaseBranch(repo.dir, "orphan-stack", "main");
    await setStackNode(repo.dir, "feature/base", "orphan-stack", "main");
    // feature/child claims parent "feature/nonexistent" which is not in the
    // stack, so it won't appear in the tree but will still have config keys
    await setStackNode(
      repo.dir,
      "feature/child",
      "orphan-stack",
      "feature/nonexistent",
    );

    const tree = await getStackTree(repo.dir, "orphan-stack");
    const result = await validateStackTree(repo.dir, tree);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e: string) => e.includes("feature/child")),
    ).toBe(true);
    expect(result.errors.some((e: string) => e.includes("orphan"))).toBe(true);
  });
});

describe("getStackTree migration", () => {
  test("auto-migrates old format (with stack-order) to tree format", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/step1", "main");
    await addBranch(repo.dir, "feature/step2", "feature/step1");
    await addBranch(repo.dir, "feature/step3", "feature/step2");

    // Set up branches with old-format metadata (stack-order present, no base-branch)
    await setStackBranch(repo.dir, "feature/step1", {
      stackName: "migrate-stack",
      parent: "main",
      order: 1,
    });
    await setStackBranch(repo.dir, "feature/step2", {
      stackName: "migrate-stack",
      parent: "feature/step1",
      order: 2,
    });
    await setStackBranch(repo.dir, "feature/step3", {
      stackName: "migrate-stack",
      parent: "feature/step2",
      order: 3,
    });

    // Call getStackTree - should auto-migrate without throwing
    const tree = await getStackTree(repo.dir, "migrate-stack");

    // Verify tree structure is correct
    expect(tree.stackName).toBe("migrate-stack");
    expect(tree.baseBranch).toBe("main");
    expect(tree.roots).toHaveLength(1);
    const root = tree.roots[0];
    expect(root.branch).toBe("feature/step1");
    expect(root.children).toHaveLength(1);
    expect(root.children[0].branch).toBe("feature/step2");
    expect(root.children[0].children).toHaveLength(1);
    expect(root.children[0].children[0].branch).toBe("feature/step3");

    // Verify stack-order keys are removed (runGitCommand config read should fail)
    const orderCheck = await runGitCommand(
      repo.dir,
      "config",
      "branch.feature/step1.stack-order",
    );
    expect(orderCheck.code).not.toBe(0);

    // Verify base-branch was written
    const baseBranch = await getBaseBranch(repo.dir, "migrate-stack");
    expect(baseBranch).toBe("main");
  });

  test("does not migrate if already in tree format", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/step1", "main");
    await addBranch(repo.dir, "feature/step2", "feature/step1");
    await setBaseBranch(repo.dir, "tree-stack", "main");
    await setStackNode(repo.dir, "feature/step1", "tree-stack", "main");
    await setStackNode(
      repo.dir,
      "feature/step2",
      "tree-stack",
      "feature/step1",
    );

    // Should work without migration (no stack-order keys present)
    const tree = await getStackTree(repo.dir, "tree-stack");

    expect(tree.stackName).toBe("tree-stack");
    expect(tree.baseBranch).toBe("main");
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].branch).toBe("feature/step1");
    expect(tree.roots[0].children[0].branch).toBe("feature/step2");

    // Verify no stack-order keys were written during this call
    const orderCheck = await runGitCommand(
      repo.dir,
      "config",
      "branch.feature/step1.stack-order",
    );
    expect(orderCheck.code).not.toBe(0);
  });
});

describe("getStackTree", () => {
  test("builds a single-node tree", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/auth", "main");
    await setBaseBranch(repo.dir, "auth-stack", "main");
    await setStackNode(repo.dir, "feature/auth", "auth-stack", "main");

    const tree = await getStackTree(repo.dir, "auth-stack");

    expect(tree.stackName).toBe("auth-stack");
    expect(tree.baseBranch).toBe("main");
    expect(tree.mergeStrategy).toBeUndefined();
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].branch).toBe("feature/auth");
    expect(tree.roots[0].stackName).toBe("auth-stack");
    expect(tree.roots[0].parent).toBe("main");
    expect(tree.roots[0].children).toHaveLength(0);
  });

  test("builds a linear chain as a tree", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/step1", "main");
    await addBranch(repo.dir, "feature/step2", "feature/step1");
    await addBranch(repo.dir, "feature/step3", "feature/step2");
    await setBaseBranch(repo.dir, "linear-stack", "main");
    await setStackNode(repo.dir, "feature/step1", "linear-stack", "main");
    await setStackNode(
      repo.dir,
      "feature/step2",
      "linear-stack",
      "feature/step1",
    );
    await setStackNode(
      repo.dir,
      "feature/step3",
      "linear-stack",
      "feature/step2",
    );

    const tree = await getStackTree(repo.dir, "linear-stack");

    expect(tree.roots).toHaveLength(1);
    const root = tree.roots[0];
    expect(root.branch).toBe("feature/step1");
    expect(root.children).toHaveLength(1);
    expect(root.children[0].branch).toBe("feature/step2");
    expect(root.children[0].children).toHaveLength(1);
    expect(root.children[0].children[0].branch).toBe("feature/step3");
    expect(root.children[0].children[0].children).toHaveLength(0);
  });

  test("builds a forked tree with alphabetical sibling order", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/base", "main");
    await addBranch(repo.dir, "feature/zebra", "feature/base");
    await addBranch(repo.dir, "feature/alpha", "feature/base");
    await setBaseBranch(repo.dir, "fork-stack", "main");
    await setStackNode(repo.dir, "feature/base", "fork-stack", "main");
    await setStackNode(
      repo.dir,
      "feature/zebra",
      "fork-stack",
      "feature/base",
    );
    await setStackNode(
      repo.dir,
      "feature/alpha",
      "fork-stack",
      "feature/base",
    );

    const tree = await getStackTree(repo.dir, "fork-stack");

    expect(tree.roots).toHaveLength(1);
    const base = tree.roots[0];
    expect(base.branch).toBe("feature/base");
    expect(base.children).toHaveLength(2);
    // Children should be sorted alphabetically
    expect(base.children[0].branch).toBe("feature/alpha");
    expect(base.children[1].branch).toBe("feature/zebra");
  });

  test("handles multiple roots", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/root-a", "main");
    await addBranch(repo.dir, "feature/root-b", "main");
    await setBaseBranch(repo.dir, "multi-root-stack", "main");
    await setStackNode(repo.dir, "feature/root-a", "multi-root-stack", "main");
    await setStackNode(repo.dir, "feature/root-b", "multi-root-stack", "main");

    const tree = await getStackTree(repo.dir, "multi-root-stack");

    expect(tree.roots).toHaveLength(2);
    const rootBranches = tree.roots.map((r) => r.branch).sort();
    expect(rootBranches).toEqual(["feature/root-a", "feature/root-b"]);
  });

  test("detects stack name from current branch", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/current", "main");
    await setBaseBranch(repo.dir, "current-stack", "main");
    await setStackNode(repo.dir, "feature/current", "current-stack", "main");

    // Switch to the branch so getStackTree can detect the stack name
    await runGit(repo.dir, "checkout", "feature/current");

    const tree = await getStackTree(repo.dir);

    expect(tree.stackName).toBe("current-stack");
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].branch).toBe("feature/current");
  });
});

describe("tree traversal utilities", () => {
  // Build an in-memory tree for testing (no git repo needed):
  //
  //   auth (root)
  //   ├── auth-api (leaf)
  //   └── auth-tests
  //       └── auth-ui (leaf)

  const authUi: StackNode = {
    branch: "auth-ui",
    stackName: "auth-stack",
    parent: "auth-tests",
    children: [],
  };

  const authApi: StackNode = {
    branch: "auth-api",
    stackName: "auth-stack",
    parent: "auth",
    children: [],
  };

  const authTests: StackNode = {
    branch: "auth-tests",
    stackName: "auth-stack",
    parent: "auth",
    children: [authUi],
  };

  const auth: StackNode = {
    branch: "auth",
    stackName: "auth-stack",
    parent: "main",
    children: [authApi, authTests],
  };

  const tree: StackTree = {
    stackName: "auth-stack",
    baseBranch: "main",
    mergeStrategy: undefined,
    roots: [auth],
  };

  test("walkDFS returns pre-order traversal of a single node", () => {
    const result = walkDFS(auth);
    expect(result.map((n) => n.branch)).toEqual([
      "auth",
      "auth-api",
      "auth-tests",
      "auth-ui",
    ]);
  });

  test("getLeaves returns only leaf nodes", () => {
    const leaves = getLeaves(tree);
    expect(leaves.map((n) => n.branch).sort()).toEqual(["auth-api", "auth-ui"]);
  });

  test("getAllNodes returns all 4 nodes in DFS order", () => {
    const nodes = getAllNodes(tree);
    expect(nodes.map((n) => n.branch)).toEqual([
      "auth",
      "auth-api",
      "auth-tests",
      "auth-ui",
    ]);
  });

  test("getPathTo returns path from root to target branch", () => {
    const path = getPathTo(tree, "auth-ui");
    expect(path?.map((n) => n.branch)).toEqual([
      "auth",
      "auth-tests",
      "auth-ui",
    ]);
  });

  test("getPathTo returns undefined for nonexistent branch", () => {
    const path = getPathTo(tree, "nonexistent");
    expect(path).toBeUndefined();
  });

  test("getSubtree returns node rooted at the given branch", () => {
    const subtree = getSubtree(tree, "auth-tests");
    expect(subtree?.branch).toBe("auth-tests");
    expect(subtree?.children).toHaveLength(1);
    expect(subtree?.children[0].branch).toBe("auth-ui");
  });

  test("findNode returns the correct node by branch name", () => {
    const node = findNode(tree, "auth-api");
    expect(node?.branch).toBe("auth-api");
    expect(node?.parent).toBe("auth");
    expect(node?.children).toHaveLength(0);
  });
});

describe("renderTree", () => {
  // Reuse the same in-memory tree as tree traversal tests:
  //
  //   auth (root)
  //   ├── auth-api (leaf)
  //   └── auth-tests
  //       └── auth-ui (leaf)

  const authUi: StackNode = {
    branch: "auth-ui",
    stackName: "auth-stack",
    parent: "auth-tests",
    children: [],
  };

  const authApi: StackNode = {
    branch: "auth-api",
    stackName: "auth-stack",
    parent: "auth",
    children: [],
  };

  const authTests: StackNode = {
    branch: "auth-tests",
    stackName: "auth-stack",
    parent: "auth",
    children: [authUi],
  };

  const auth: StackNode = {
    branch: "auth",
    stackName: "auth-stack",
    parent: "main",
    children: [authApi, authTests],
  };

  const tree: StackTree = {
    stackName: "auth-stack",
    baseBranch: "main",
    mergeStrategy: undefined,
    roots: [auth],
  };

  test("basic tree renders with correct box-drawing characters", () => {
    const output = renderTree(tree, {});
    const lines = output.split("\n");
    expect(lines[0]).toBe("auth");
    expect(lines[1]).toBe("├── auth-api");
    expect(lines[2]).toBe("└── auth-tests");
    expect(lines[3]).toBe("    └── auth-ui");
  });

  test("annotations appear next to branch names with padding", () => {
    const annotations = new Map([
      ["auth", "PR #101 (open)"],
      ["auth-api", "PR #103 (open)"],
      ["auth-tests", "PR #102 (draft)"],
      ["auth-ui", "(no PR)"],
    ]);
    const output = renderTree(tree, { annotations });
    const lines = output.split("\n");
    expect(lines[0]).toContain("auth");
    expect(lines[0]).toContain("PR #101 (open)");
    expect(lines[1]).toContain("auth-api");
    expect(lines[1]).toContain("PR #103 (open)");
    expect(lines[2]).toContain("auth-tests");
    expect(lines[2]).toContain("PR #102 (draft)");
    expect(lines[3]).toContain("auth-ui");
    expect(lines[3]).toContain("(no PR)");
  });

  test("currentBranch adds '<- you are here' marker", () => {
    const output = renderTree(tree, { currentBranch: "auth-tests" });
    const lines = output.split("\n");
    expect(lines[2]).toContain("<- you are here");
    expect(lines[0]).not.toContain("<- you are here");
    expect(lines[1]).not.toContain("<- you are here");
    expect(lines[3]).not.toContain("<- you are here");
  });

  test("highlightBranch adds '◄' marker", () => {
    const output = renderTree(tree, { highlightBranch: "auth-api" });
    const lines = output.split("\n");
    expect(lines[1]).toContain("◄");
    expect(lines[0]).not.toContain("◄");
    expect(lines[2]).not.toContain("◄");
    expect(lines[3]).not.toContain("◄");
  });

  test("statusIcons appear before branch names", () => {
    const statusIcons = new Map([
      ["auth", "✓"],
      ["auth-api", "✗"],
      ["auth-tests", "✓"],
      ["auth-ui", "✓"],
    ]);
    const output = renderTree(tree, { statusIcons });
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/^✓ auth/);
    expect(lines[1]).toMatch(/✗ auth-api/);
    expect(lines[2]).toMatch(/✓ auth-tests/);
    expect(lines[3]).toMatch(/✓ auth-ui/);
  });

  test("linear chain uses only '└──' connectors", () => {
    const step2: StackNode = {
      branch: "step2",
      stackName: "s",
      parent: "step1",
      children: [],
    };
    const step1: StackNode = {
      branch: "step1",
      stackName: "s",
      parent: "main",
      children: [step2],
    };
    const linearTree: StackTree = {
      stackName: "s",
      baseBranch: "main",
      mergeStrategy: undefined,
      roots: [step1],
    };
    const output = renderTree(linearTree, {});
    const lines = output.split("\n");
    expect(lines[0]).toBe("step1");
    expect(lines[1]).toBe("└── step2");
    expect(output).not.toContain("├──");
  });

  test("all options combined: annotations, currentBranch, and statusIcons", () => {
    const annotations = new Map([["auth-tests", "PR #102 (draft)"]]);
    const statusIcons = new Map([["auth-tests", "✓"]]);
    const output = renderTree(tree, {
      annotations,
      currentBranch: "auth-tests",
      statusIcons,
    });
    const line = output.split("\n")[2];
    expect(line).toContain("✓");
    expect(line).toContain("auth-tests");
    expect(line).toContain("PR #102 (draft)");
    expect(line).toContain("<- you are here");
  });
});

describe("listAllStacks", () => {
  test("returns empty list when no stacks configured", async () => {
    await using repo = await createTestRepo();
    const names = await listAllStacks(repo.dir);
    expect(names).toEqual([]);
  });

  test("returns sorted unique stack names", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "main");
    await addBranch(repo.dir, "feat/c", "main");

    await setStackNode(repo.dir, "feat/a", "zebra", "main");
    await setStackNode(repo.dir, "feat/b", "alpha", "main");
    await setStackNode(repo.dir, "feat/c", "alpha", "main");
    await setBaseBranch(repo.dir, "zebra", "main");
    await setBaseBranch(repo.dir, "alpha", "main");

    const names = await listAllStacks(repo.dir);
    expect(names).toEqual(["alpha", "zebra"]);
  });
});

describe("getAllStackTrees", () => {
  test("returns empty list when no stacks", async () => {
    await using repo = await createTestRepo();
    const trees = await getAllStackTrees(repo.dir);
    expect(trees).toEqual([]);
  });

  test("returns one StackTree per stack", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "main");

    await setStackNode(repo.dir, "feat/a", "alpha", "main");
    await setBaseBranch(repo.dir, "alpha", "main");
    await setStackNode(repo.dir, "feat/b", "beta", "main");
    await setBaseBranch(repo.dir, "beta", "main");

    const trees = await getAllStackTrees(repo.dir);
    expect(trees).toHaveLength(2);
    expect(trees.map((t) => t.stackName).sort()).toEqual(["alpha", "beta"]);
  });

  test("skips stacks with broken metadata", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "main");

    // Valid stack
    await setStackNode(repo.dir, "feat/a", "alpha", "main");
    await setBaseBranch(repo.dir, "alpha", "main");

    // Broken stack: has stack-name metadata but no base-branch configured
    await setStackNode(repo.dir, "feat/b", "broken", "main");

    const trees = await getAllStackTrees(repo.dir);
    expect(trees).toHaveLength(1);
    expect(trees[0].stackName).toBe("alpha");
  });
});

describe("getStackTree merged field", () => {
  test("backwards compat: reads branch-level stack-merged flag", async () => {
    await using repo = await createTestRepo();
    {
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");
      // Old-format: write directly to branch-level config
      await runGitCommand(
        repo.dir,
        "config",
        "branch.feature/a.stack-merged",
        "true",
      );

      const tree = await getStackTree(repo.dir, "my-stack");
      const nodeA = tree.roots.find((n) => n.branch === "feature/a");
      const nodeB = tree.roots.find((n) => n.branch === "feature/b");
      expect(nodeA?.merged).toBe(true);
      expect(nodeB?.merged).toBeUndefined();
    }
  });

  test("stack-level tombstone does not duplicate when live config exists", async () => {
    await using repo = await createTestRepo();
    {
      await addBranch(repo.dir, "feature/a", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");
      // Write both old and new format
      await runGitCommand(
        repo.dir,
        "config",
        "branch.feature/a.stack-merged",
        "true",
      );
      await addLandedBranch(repo.dir, "my-stack", "feature/a");

      const tree = await getStackTree(repo.dir, "my-stack");
      // Should appear exactly once (live node with merged flag from branch-level)
      const matching = getAllNodes(tree).filter(
        (n) => n.branch === "feature/a",
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].merged).toBe(true);
    }
  });
});

describe("addLandedBranch", () => {
  test("writes branch name to stack-level config", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");

      const { stdout } = await runGitCommand(
        repo.dir,
        "config",
        "--get-all",
        "stack.my-stack.landed-branches",
      );
      expect(stdout).toBe("feature/a");
    }
  });

  test("supports multiple landed branches", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");
      await addLandedBranch(repo.dir, "my-stack", "feature/b");

      const { stdout } = await runGitCommand(
        repo.dir,
        "config",
        "--get-all",
        "stack.my-stack.landed-branches",
      );
      const branches = stdout.split("\n");
      expect(branches).toContain("feature/a");
      expect(branches).toContain("feature/b");
    }
  });

  test("is idempotent: skips duplicate branch names", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");

      const { stdout } = await runGitCommand(
        repo.dir,
        "config",
        "--get-all",
        "stack.my-stack.landed-branches",
      );
      expect(stdout).toBe("feature/a");
    }
  });

  test("getLandedBranches returns empty array when no tombstones exist", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      const result = await getLandedBranches(repo.dir, "my-stack");
      expect(result).toEqual([]);
    }
  });

  test("getLandedBranches returns all landed branches for a stack", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");
      await addLandedBranch(repo.dir, "my-stack", "feature/b");

      const result = await getLandedBranches(repo.dir, "my-stack");
      expect(result).toContain("feature/a");
      expect(result).toContain("feature/b");
      expect(result).toHaveLength(2);
    }
  });

  test("getStackTree reconstructs merged root from stack-level tombstone", async () => {
    await using repo = await createTestRepo();
    {
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");

      // Simulate land: add tombstone, then delete branch (wipes branch config)
      await addLandedBranch(repo.dir, "my-stack", "feature/a");
      await runGit(repo.dir, "checkout", "main");
      await runGit(repo.dir, "branch", "-D", "feature/a");

      const tree = await getStackTree(repo.dir, "my-stack");
      const nodeA = tree.roots.find((n) => n.branch === "feature/a");
      const nodeB = tree.roots.find((n) => n.branch === "feature/b");

      expect(nodeA).toBeDefined();
      expect(nodeA!.merged).toBe(true);
      expect(nodeA!.parent).toBe("main");
      expect(nodeA!.children).toEqual([]);

      expect(nodeB).toBeDefined();
      expect(nodeB!.merged).toBeUndefined();
    }
  });

  test("legacy tombstone with live descendant attaches the descendant under the synthesized root", async () => {
    // Regression for a manual-edit / partial-write scenario: the
    // tombstone has only a `landed-branches` record (no branch-level
    // config, no `landed-parent`), but a live descendant still points at
    // it via stack-parent. Without the attachment fix the live branch
    // would be silently dropped from the tree.
    await using repo = await createTestRepo();
    {
      await addBranch(repo.dir, "feature/b", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setBaseBranch(repo.dir, "my-stack", "main");

      // No branch-level config for feature/a, no landed-parent either.
      await addLandedBranch(repo.dir, "my-stack", "feature/a");

      const tree = await getStackTree(repo.dir, "my-stack");
      expect(tree.roots).toHaveLength(1);
      const [root] = tree.roots;
      expect(root.branch).toBe("feature/a");
      expect(root.merged).toBe(true);
      expect(root.children.map((c) => c.branch)).toEqual(["feature/b"]);
      expect(root.children[0].merged).toBeFalsy();
    }
  });

  test("getStackTree deduplicates a tombstoned branch that still has live config", async () => {
    await using repo = await createTestRepo();
    {
      await addBranch(repo.dir, "feature/a", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");

      // Record the branch in landed-branches while its stack-name config
      // is still present. This is the normal tombstone shape in the new
      // model: branch-level config is preserved so the tombstone remains
      // a structural node rather than being synthesized as a legacy root.
      await addLandedBranch(repo.dir, "my-stack", "feature/a");

      const tree = await getStackTree(repo.dir, "my-stack");
      const nodes = getAllNodes(tree);

      const matching = nodes.filter((n) => n.branch === "feature/a");
      expect(matching).toHaveLength(1);
      // Marked merged because it's recorded as a tombstone.
      expect(matching[0].merged).toBe(true);
      expect(matching[0].parent).toBe("main");
    }
  });

  test("getStackTree shows tombstoned non-root branches with their live children nested", async () => {
    await using repo = await createTestRepo();
    {
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "feature/a");
      await addBranch(repo.dir, "feature/c", "feature/b");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
      await setStackNode(repo.dir, "feature/c", "my-stack", "feature/b");
      await setBaseBranch(repo.dir, "my-stack", "main");

      // Tombstone a non-root branch; its live child should stay nested
      // under it rather than being promoted or duplicated.
      await addLandedBranch(repo.dir, "my-stack", "feature/b");

      const tree = await getStackTree(repo.dir, "my-stack");
      const matching = getAllNodes(tree).filter((n) =>
        n.branch === "feature/b"
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].merged).toBe(true);
      expect(matching[0].parent).toBe("feature/a");
      // No duplicate tombstone root should appear for feature/b.
      const rootB = tree.roots.find((n) => n.branch === "feature/b");
      expect(rootB).toBeUndefined();
      // feature/c keeps pointing at feature/b (the tombstone).
      const nodeC = getAllNodes(tree).find((n) => n.branch === "feature/c");
      expect(nodeC?.parent).toBe("feature/b");
      expect(nodeC?.merged).toBeFalsy();
    }
  });

  test("getLandedBranches isolates per stack", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "stack-a", "main");
      await setBaseBranch(repo.dir, "stack-b", "main");
      await addLandedBranch(repo.dir, "stack-a", "feature/x");
      await addLandedBranch(repo.dir, "stack-b", "feature/y");

      const aResult = await getLandedBranches(repo.dir, "stack-a");
      const bResult = await getLandedBranches(repo.dir, "stack-b");

      expect(aResult).toEqual(["feature/x"]);
      expect(bResult).toEqual(["feature/y"]);
    }
  });
});

describe("addLandedPr / getLandedPrs", () => {
  test("records and reads PR number per landed branch", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedPr(repo.dir, "my-stack", "feature/a", 101);
      await addLandedPr(repo.dir, "my-stack", "feature/b", 102);

      const prs = await getLandedPrs(repo.dir, "my-stack");
      expect(prs.get("feature/a")).toBe(101);
      expect(prs.get("feature/b")).toBe(102);
      expect(prs.size).toBe(2);
    }
  });

  test("is idempotent: first PR number wins", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedPr(repo.dir, "my-stack", "feature/a", 101);
      await addLandedPr(repo.dir, "my-stack", "feature/a", 999);

      const prs = await getLandedPrs(repo.dir, "my-stack");
      expect(prs.get("feature/a")).toBe(101);
      expect(prs.size).toBe(1);
    }
  });

  test("returns empty map when no landed-pr entries exist", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      const prs = await getLandedPrs(repo.dir, "my-stack");
      expect(prs.size).toBe(0);
    }
  });

  test("survives branch deletion (lives under stack namespace)", async () => {
    await using repo = await createTestRepo();
    {
      await addBranch(repo.dir, "feature/a", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");

      await addLandedPr(repo.dir, "my-stack", "feature/a", 101);
      await runGit(repo.dir, "checkout", "main");
      await runGit(repo.dir, "branch", "-D", "feature/a");

      const prs = await getLandedPrs(repo.dir, "my-stack");
      expect(prs.get("feature/a")).toBe(101);
    }
  });
});

describe("addLandedParent / getLandedParents", () => {
  test("records and reads the parent per landed branch", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedParent(repo.dir, "my-stack", "feature/a", "main");
      await addLandedParent(repo.dir, "my-stack", "feature/b", "feature/a");

      const parents = await getLandedParents(repo.dir, "my-stack");
      expect(parents.get("feature/a")).toBe("main");
      expect(parents.get("feature/b")).toBe("feature/a");
    }
  });

  test("returns an empty map when no parents are recorded", async () => {
    await using repo = await createTestRepo();
    const parents = await getLandedParents(repo.dir, "my-stack");
    expect(parents.size).toBe(0);
  });

  test("first recorded parent wins on repeat calls", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedParent(repo.dir, "my-stack", "feature/a", "main");
      await addLandedParent(repo.dir, "my-stack", "feature/a", "other");

      const parents = await getLandedParents(repo.dir, "my-stack");
      expect(parents.get("feature/a")).toBe("main");
    }
  });

  test("isolates values per stack", async () => {
    await using repo = await createTestRepo();
    {
      await setBaseBranch(repo.dir, "stack-a", "main");
      await setBaseBranch(repo.dir, "stack-b", "main");
      await addLandedParent(repo.dir, "stack-a", "feature/x", "main");
      await addLandedParent(repo.dir, "stack-b", "feature/y", "main");

      const a = await getLandedParents(repo.dir, "stack-a");
      const b = await getLandedParents(repo.dir, "stack-b");
      expect(a.get("feature/x")).toBe("main");
      expect(a.get("feature/y")).toBeUndefined();
      expect(b.get("feature/y")).toBe("main");
    }
  });

  test("survives a subsequent `git branch -D`", async () => {
    await using repo = await createTestRepo();
    {
      await addBranch(repo.dir, "feature/a", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedParent(repo.dir, "my-stack", "feature/a", "main");

      await runGit(repo.dir, "checkout", "main");
      await runGit(repo.dir, "branch", "-D", "feature/a");

      const parents = await getLandedParents(repo.dir, "my-stack");
      expect(parents.get("feature/a")).toBe("main");
    }
  });
});

describe("effectiveParent", () => {
  function makeTree(
    baseBranch: string,
    roots: StackNode[],
  ): StackTree {
    return {
      stackName: "s",
      baseBranch,
      mergeStrategy: undefined,
      roots,
    };
  }

  test("returns the raw parent for live branches rooted at base", () => {
    const root: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [],
    };
    const tree = makeTree("main", [root]);
    expect(effectiveParent(tree, root)).toBe("main");
  });

  test("returns the raw parent for live branches nested under a live parent", () => {
    const child: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/a",
      children: [],
    };
    const root: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [child],
    };
    const tree = makeTree("main", [root]);
    expect(effectiveParent(tree, child)).toBe("feat/a");
  });

  test("walks past a merged ancestor to the next live branch", () => {
    const grandchild: StackNode = {
      branch: "feat/c",
      stackName: "s",
      parent: "feat/b",
      children: [],
    };
    const child: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/a",
      children: [grandchild],
      merged: true,
    };
    const root: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [child],
    };
    const tree = makeTree("main", [root]);
    expect(effectiveParent(tree, grandchild)).toBe("feat/a");
  });

  test("returns the base branch when the entire ancestor chain is merged", () => {
    const live: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/a",
      children: [],
    };
    const tombstone: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [live],
      merged: true,
    };
    const tree = makeTree("main", [tombstone]);
    expect(effectiveParent(tree, live)).toBe("main");
  });

  test("explicit reparent overrides the walk", () => {
    const child: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/a",
      children: [],
    };
    const root: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [child],
    };
    const tree = makeTree("main", [root]);
    expect(effectiveParent(tree, child, { "feat/b": "main" })).toBe("main");
  });

  test("returns base when the parent branch is missing from the tree", () => {
    const orphan: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/ghost",
      children: [],
    };
    const tree = makeTree("main", [orphan]);
    expect(effectiveParent(tree, orphan)).toBe("main");
  });
});

describe("getLiveSubtreeRoots", () => {
  function makeTree(
    baseBranch: string,
    roots: StackNode[],
  ): StackTree {
    return {
      stackName: "s",
      baseBranch,
      mergeStrategy: undefined,
      roots,
    };
  }

  test("returns a single live root for a simple linear stack", () => {
    const leaf: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/a",
      children: [],
    };
    const root: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [leaf],
    };
    const tree = makeTree("main", [root]);
    const tops = getLiveSubtreeRoots(tree);
    expect(tops.map((n) => n.branch)).toEqual(["feat/a"]);
  });

  test("excludes merged nodes from the result", () => {
    const live: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/a",
      children: [],
    };
    const merged: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [live],
      merged: true,
    };
    const tree = makeTree("main", [merged]);
    const tops = getLiveSubtreeRoots(tree);
    // feat/b's effective parent walks past feat/a to main.
    expect(tops.map((n) => n.branch)).toEqual(["feat/b"]);
  });

  test("returns every live branch that sits directly under the base branch", () => {
    const a: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [],
    };
    const b: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "main",
      children: [],
    };
    const tree = makeTree("main", [a, b]);
    const tops = getLiveSubtreeRoots(tree);
    expect(tops.map((n) => n.branch).sort()).toEqual(["feat/a", "feat/b"]);
  });

  test("returns multiple live subtree roots that share a tombstoned parent", () => {
    const leftLive: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/a",
      children: [],
    };
    const rightLive: StackNode = {
      branch: "feat/c",
      stackName: "s",
      parent: "feat/a",
      children: [],
    };
    const merged: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [leftLive, rightLive],
      merged: true,
    };
    const tree = makeTree("main", [merged]);
    const tops = getLiveSubtreeRoots(tree);
    expect(tops.map((n) => n.branch).sort()).toEqual(["feat/b", "feat/c"]);
  });

  test("returns an empty list when every node is merged", () => {
    const child: StackNode = {
      branch: "feat/b",
      stackName: "s",
      parent: "feat/a",
      children: [],
      merged: true,
    };
    const root: StackNode = {
      branch: "feat/a",
      stackName: "s",
      parent: "main",
      children: [child],
      merged: true,
    };
    const tree = makeTree("main", [root]);
    expect(getLiveSubtreeRoots(tree)).toEqual([]);
  });
});
