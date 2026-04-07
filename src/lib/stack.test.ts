import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo, runGit } from "./testdata/helpers.ts";
import type { TestRepo } from "./testdata/helpers.ts";
import {
  findNode,
  getAllNodes,
  getAllStackTrees,
  getBaseBranch,
  getLeaves,
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
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("merge strategy: writes and reads", async () => {
    await setMergeStrategy(repo.dir, "my-stack", "squash");
    const strategy = await getMergeStrategy(repo.dir, "my-stack");
    expect(strategy).toBe("squash");
  });

  test("merge strategy: returns undefined for unset", async () => {
    const strategy = await getMergeStrategy(repo.dir, "no-such-stack");
    expect(strategy).toBeUndefined();
  });

  describe("removeStackBranch", () => {
    test("removes stack metadata for a branch", async () => {
      await addBranch(repo.dir, "feature/auth", "main");
      await setBaseBranch(repo.dir, "auth-stack", "main");
      await setStackNode(repo.dir, "feature/auth", "auth-stack", "main");

      await removeStackBranch(repo.dir, "feature/auth");

      const tree = await getStackTree(repo.dir, "auth-stack");
      expect(tree.roots).toHaveLength(0);
    });

    test("does not affect other branches in the stack", async () => {
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
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("valid tree passes validation", async () => {
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
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("auto-migrates old format (with stack-order) to tree format", async () => {
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
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("builds a single-node tree", async () => {
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
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("returns empty list when no stacks configured", async () => {
    const names = await listAllStacks(repo.dir);
    expect(names).toEqual([]);
  });

  test("returns sorted unique stack names", async () => {
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
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("returns empty list when no stacks", async () => {
    const trees = await getAllStackTrees(repo.dir);
    expect(trees).toEqual([]);
  });

  test("returns one StackTree per stack", async () => {
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
