import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo } from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import { setMockDir, writeFixture } from "../lib/gh.ts";
import type { DiscoveredNode } from "./import-discover.ts";
import { discoverChain } from "./import-discover.ts";

/** Flatten a tree of DiscoveredNode into DFS order (pre-order). */
function flattenDfs(nodes: DiscoveredNode[]): DiscoveredNode[] {
  const result: DiscoveredNode[] = [];
  for (const node of nodes) {
    result.push(node);
    result.push(...flattenDfs(node.children));
  }
  return result;
}

describe("discoverChain", () => {
  let repo: TestRepo;
  let mockDir: string;

  beforeEach(async () => {
    repo = await createTestRepo();
    mockDir = await Deno.makeTempDir();
    setMockDir(mockDir);
  });

  afterEach(async () => {
    setMockDir(undefined);
    await repo.cleanup();
    await Deno.remove(mockDir, { recursive: true });
  });

  test("discovers two branches with correct parents", async () => {
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");

    const result = await discoverChain(repo.dir, "feat/b");

    expect(result.baseBranch).toBe("main");
    expect(result.roots).toHaveLength(1);

    const root = result.roots[0];
    expect(root.branch).toBe("feat/a");
    expect(root.parent).toBe("main");
    expect(root.children).toHaveLength(1);

    const child = root.children[0];
    expect(child.branch).toBe("feat/b");
    expect(child.parent).toBe("feat/a");
    expect(child.children).toHaveLength(0);
  });

  test("middle-of-chain discovery finds all 3 branches", async () => {
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/b");

    const result = await discoverChain(repo.dir, "feat/b");

    expect(result.baseBranch).toBe("main");
    expect(result.roots).toHaveLength(1);

    const flat = flattenDfs(result.roots);
    expect(flat).toHaveLength(3);
    expect(flat[0].branch).toBe("feat/a");
    expect(flat[0].parent).toBe("main");
    expect(flat[1].branch).toBe("feat/b");
    expect(flat[1].parent).toBe("feat/a");
    expect(flat[2].branch).toBe("feat/c");
    expect(flat[2].parent).toBe("feat/b");
  });

  test("annotates PR data and warns on base mismatch", async () => {
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");

    // feat/a PR with correct base
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 10,
        url: "https://github.com/o/r/pull/10",
        title: "feat: a",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
      }],
    );

    // feat/b PR with WRONG base (says "main" but git parent is "feat/a")
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/b", "--repo", "o/r"],
      [{
        number: 11,
        url: "https://github.com/o/r/pull/11",
        title: "feat: b",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
      }],
    );

    const result = await discoverChain(repo.dir, "feat/b", "o", "r");

    const flat = flattenDfs(result.roots);
    expect(flat).toHaveLength(2);
    // PR data is annotated
    expect(flat[0].pr?.number).toBe(10);
    expect(flat[1].pr?.number).toBe(11);
    // Warning for feat/b base mismatch
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("feat/b");
    expect(result.warnings[0]).toContain('"main"');
    expect(result.warnings[0]).toContain('"feat/a"');
  });

  test("single branch off main", async () => {
    await addBranch(repo.dir, "feat/solo", "main");

    const result = await discoverChain(repo.dir, "feat/solo");

    expect(result.baseBranch).toBe("main");
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].branch).toBe("feat/solo");
    expect(result.roots[0].parent).toBe("main");
    expect(result.roots[0].children).toHaveLength(0);
  });

  test("main branch returns empty roots", async () => {
    const result = await discoverChain(repo.dir, "main");

    expect(result.baseBranch).toBe("main");
    expect(result.roots).toHaveLength(0);
  });

  test("discovers a forked tree (branch with two children)", async () => {
    // Tree shape:
    //   main
    //   └── feat/a
    //       ├── feat/b
    //       └── feat/c
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/a");

    const result = await discoverChain(repo.dir, "feat/a");

    expect(result.baseBranch).toBe("main");
    expect(result.roots).toHaveLength(1);

    const root = result.roots[0];
    expect(root.branch).toBe("feat/a");
    expect(root.parent).toBe("main");
    expect(root.children).toHaveLength(2);

    const childBranches = root.children.map((c) => c.branch).sort();
    expect(childBranches).toEqual(["feat/b", "feat/c"]);

    for (const child of root.children) {
      expect(child.parent).toBe("feat/a");
      expect(child.children).toHaveLength(0);
    }
  });

  test("tree structure: discovers fork from interior node when starting at leaf", async () => {
    // Tree shape:
    //   main
    //   └── feat/a
    //       ├── feat/b
    //       │   └── feat/d
    //       └── feat/c
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/a");
    await addBranch(repo.dir, "feat/d", "feat/b");

    const result = await discoverChain(repo.dir, "feat/d");

    expect(result.baseBranch).toBe("main");
    expect(result.roots).toHaveLength(1);

    const flat = flattenDfs(result.roots);
    const branchNames = flat.map((n) => n.branch);

    // All branches in the tree must be discovered
    expect(branchNames).toContain("feat/a");
    expect(branchNames).toContain("feat/b");
    expect(branchNames).toContain("feat/c");
    expect(branchNames).toContain("feat/d");

    // Verify structure
    const root = result.roots[0];
    expect(root.branch).toBe("feat/a");
    expect(root.children).toHaveLength(2);

    const childBranches = root.children.map((c) => c.branch).sort();
    expect(childBranches).toEqual(["feat/b", "feat/c"]);

    const featB = root.children.find((c) => c.branch === "feat/b")!;
    expect(featB.children).toHaveLength(1);
    expect(featB.children[0].branch).toBe("feat/d");
  });

  test("two independent roots off main discovered together", async () => {
    // Tree shape:
    //   main
    //   ├── feat/x
    //   └── feat/y
    // When starting at feat/x, feat/y should NOT be discovered (different subtree)
    await addBranch(repo.dir, "feat/x", "main");
    await addBranch(repo.dir, "feat/y", "main");

    const result = await discoverChain(repo.dir, "feat/x");

    // feat/y is an independent branch off main; it is not in feat/x's subtree
    // walkUp only picks up branches whose closest parent is IN the discovered set.
    // Since feat/y's closest parent is "main" (base branch), it is excluded.
    expect(result.baseBranch).toBe("main");
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].branch).toBe("feat/x");
    expect(result.roots[0].children).toHaveLength(0);
  });
});
