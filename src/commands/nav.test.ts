import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo } from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import type { StackNode, StackTree } from "../lib/stack.ts";
import { setMockDir, writeFixture } from "../lib/gh.ts";
import { buildNavPlan, generateNavMarkdown } from "./nav.ts";

/** Build a minimal StackTree for unit tests (no git required). */
function makeTree(
  stackName: string,
  nodes: Array<{ branch: string; parent: string; children?: string[] }>,
): StackTree {
  const nodeMap = new Map(
    nodes.map((n) => [
      n.branch,
      {
        branch: n.branch,
        stackName,
        parent: n.parent,
        children: [] as ReturnType<typeof makeTree>["roots"],
      },
    ]),
  );

  // Wire up children
  for (const n of nodes) {
    const child = nodeMap.get(n.branch)!;
    const parentNode = nodeMap.get(n.parent);
    if (parentNode) {
      parentNode.children.push(child);
    }
  }

  // Roots are nodes whose parent is not in the nodeMap (i.e., the base branch)
  const roots = nodes
    .filter((n) => !nodeMap.has(n.parent))
    .map((n) => nodeMap.get(n.branch)!);

  return {
    stackName,
    baseBranch: roots[0]?.parent ?? "main",
    mergeStrategy: undefined,
    roots,
  };
}

describe("generateNavMarkdown", () => {
  test("generates tree-shaped nav with highlight marker on the current PR", () => {
    const tree = makeTree("auth-rework", [
      { branch: "auth", parent: "main" },
      { branch: "auth-api", parent: "auth" },
      { branch: "auth-tests", parent: "auth" },
      { branch: "auth-ui", parent: "auth-tests" },
    ]);

    const prMap = new Map<string, number>([
      ["auth", 101],
      ["auth-tests", 102],
      ["auth-api", 103],
    ]);

    const result = generateNavMarkdown(tree, prMap, 102);

    expect(result).toContain("<!-- stack-nav:start -->");
    expect(result).toContain("<!-- stack-nav:end -->");
    // Should show the highlight marker on the current PR
    expect(result).toContain("👈 this PR");
    // #102 is the current PR, should be bolded with the marker
    expect(result).toMatch(/\*\*#102 👈 this PR\*\*/);
  });

  test("renders PR references as plain markdown links, not in a code block", () => {
    const tree = makeTree("auth-rework", [
      { branch: "auth", parent: "main" },
      { branch: "auth-api", parent: "auth" },
    ]);

    const prMap = new Map<string, number>([
      ["auth", 101],
      ["auth-api", 103],
    ]);

    const result = generateNavMarkdown(tree, prMap, 101);

    // PR numbers must appear as bare `#N` so GitHub auto-links them
    expect(result).toContain("#101");
    expect(result).toContain("#103");
    // The old "(#N)" parenthesized form must be gone
    expect(result).not.toContain("(#101)");
    // No fenced code block — that would break GitHub PR auto-linking
    expect(result).not.toMatch(/^```/m);
  });

  test("omits branches that have no PR", () => {
    const tree = makeTree("auth-rework", [
      { branch: "auth", parent: "main" },
      { branch: "auth-ui", parent: "auth" },
    ]);

    // Only auth has a PR; auth-ui does not
    const prMap = new Map<string, number>([
      ["auth", 101],
    ]);

    const result = generateNavMarkdown(tree, prMap, 101);

    // Branch names are not rendered at all, so neither name should appear
    // outside the stack header.
    expect(result).not.toContain("auth-ui");
    expect(result).toContain("#101");
    // The stack header is the only place "auth" appears (as part of the
    // stack name), and the rendered list itself contains only #N references.
    expect(result).not.toMatch(/^- `?auth`?/m);
  });

  test("promotes PR-bearing descendants of a hidden no-PR node", () => {
    // root (PR) -> middle (no PR) -> leaf (PR)
    // The middle node is hidden, but its child should still appear,
    // promoted up so the visible tree stays connected.
    const tree = makeTree("auth-rework", [
      { branch: "root", parent: "main" },
      { branch: "middle", parent: "root" },
      { branch: "leaf", parent: "middle" },
    ]);

    const prMap = new Map<string, number>([
      ["root", 101],
      ["leaf", 102],
    ]);

    const result = generateNavMarkdown(tree, prMap, 101);

    // Neither hidden nor PR-bearing nodes should leak their branch names
    expect(result).not.toContain("middle");
    expect(result).not.toContain("root");
    expect(result).not.toContain("leaf");
    // Both PRs should be present, with #102 promoted up under #101
    expect(result).toContain("#101");
    expect(result).toContain("#102");
    // #102 should be indented one level deeper than #101 (skipping middle)
    expect(result).toMatch(/^- \*\*#101 👈 this PR\*\*\n {2}- #102$/m);
  });

  test("contains the stack-nav HTML comment markers", () => {
    const tree = makeTree("my-stack", [
      { branch: "feature/a", parent: "main" },
    ]);

    const prMap = new Map<string, number>([["feature/a", 200]]);

    const result = generateNavMarkdown(tree, prMap, 200);

    expect(result).toContain("<!-- stack-nav:start -->");
    expect(result).toContain("<!-- stack-nav:end -->");
  });

  test("contains the Part of a stacked PR chain footer", () => {
    const tree = makeTree("my-stack", [
      { branch: "feature/a", parent: "main" },
    ]);

    const prMap = new Map<string, number>([["feature/a", 200]]);

    const result = generateNavMarkdown(tree, prMap, 200);

    expect(result).toContain("Part of a stacked PR chain");
  });

  test("includes the stack name in the header", () => {
    const tree = makeTree("auth-rework", [
      { branch: "auth", parent: "main" },
    ]);

    const prMap = new Map<string, number>([["auth", 101]]);

    const result = generateNavMarkdown(tree, prMap, 101);

    expect(result).toContain("**Stack: auth-rework**");
  });

  test("renders merged nodes with strikethrough and places them before live roots", () => {
    const nodeA: StackNode = {
      branch: "feature/a",
      stackName: "my-stack",
      parent: "main",
      children: [],
      merged: true,
    };
    const nodeB: StackNode = {
      branch: "feature/b",
      stackName: "my-stack",
      parent: "main",
      children: [],
    };
    const tree: StackTree = {
      stackName: "my-stack",
      baseBranch: "main",
      mergeStrategy: undefined,
      roots: [nodeA, nodeB],
    };

    const prMap = new Map<string, number>([
      ["feature/a", 122],
      ["feature/b", 143],
    ]);

    const result = generateNavMarkdown(tree, prMap, 143);

    // Merged PR renders with strikethrough
    expect(result).toContain("~~#122~~");
    // Live PR renders normally
    expect(result).toContain("**#143 👈 this PR**");
    // Merged comes before live in the output
    expect(result.indexOf("~~#122~~")).toBeLessThan(result.indexOf("**#143"));
  });
});

describe("buildNavPlan", () => {
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

  test("plans create actions for PRs with no existing comment", async () => {
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");

    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feature/a", "--repo", "o/r"],
      [{
        number: 101,
        url: "...",
        title: "feat: auth",
        state: "OPEN",
        isDraft: false,
      }],
    );
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feature/b", "--repo", "o/r"],
      [{
        number: 102,
        url: "...",
        title: "feat: auth UI",
        state: "OPEN",
        isDraft: false,
      }],
    );

    // Empty comment arrays - no existing nav comment
    await writeFixture(
      mockDir,
      ["api", "repos/o/r/issues/101/comments"],
      [],
    );
    await writeFixture(
      mockDir,
      ["api", "repos/o/r/issues/102/comments"],
      [],
    );

    const plan = await buildNavPlan(repo.dir, "my-stack", "o", "r");

    expect(plan).toHaveLength(2);
    expect(plan[0].action).toBe("create");
    expect(plan[0].prNumber).toBe(101);
    expect(plan[0].commentId).toBeUndefined();
    expect(plan[1].action).toBe("create");
    expect(plan[1].prNumber).toBe(102);
    expect(plan[1].commentId).toBeUndefined();
  });

  test("plans update action when comment with marker exists", async () => {
    await addBranch(repo.dir, "feature/x", "main");

    await setBaseBranch(repo.dir, "x-stack", "main");
    await setStackNode(repo.dir, "feature/x", "x-stack", "main");

    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feature/x", "--repo", "o/r"],
      [{
        number: 201,
        url: "...",
        title: "feat: x",
        state: "OPEN",
        isDraft: false,
      }],
    );

    await writeFixture(
      mockDir,
      ["api", "repos/o/r/issues/201/comments"],
      [
        {
          id: 999,
          body: "<!-- stack-nav:start -->\n## Stack\n<!-- stack-nav:end -->",
        },
      ],
    );

    const plan = await buildNavPlan(repo.dir, "x-stack", "o", "r");

    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("update");
    expect(plan[0].prNumber).toBe(201);
    expect(plan[0].commentId).toBe(999);
  });

  test("skips update when comment body is unchanged", async () => {
    await addBranch(repo.dir, "feature/x", "main");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feature/x", "my-stack", "main");

    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feature/x", "--repo", "o/r"],
      [{
        number: 301,
        url: "...",
        title: "feat: x",
        state: "OPEN",
        isDraft: false,
      }],
    );

    // Build the exact body that the new generateNavMarkdown would produce
    // so the "no-op" path triggers
    const tree = makeTree("my-stack", [
      { branch: "feature/x", parent: "main" },
    ]);
    const prMap = new Map<string, number>([["feature/x", 301]]);
    const { generateNavMarkdown: gen } = await import("./nav.ts");
    const expectedBody = gen(tree, prMap, 301);

    await writeFixture(
      mockDir,
      ["api", "repos/o/r/issues/301/comments"],
      [{ id: 500, body: expectedBody }],
    );

    const plan = await buildNavPlan(repo.dir, "my-stack", "o", "r");
    expect(plan).toHaveLength(0);
  });

  test("skips branches with no PR", async () => {
    await addBranch(repo.dir, "feature/empty", "main");

    await setBaseBranch(repo.dir, "empty-stack", "main");
    await setStackNode(repo.dir, "feature/empty", "empty-stack", "main");

    // No fixture written: gh mock returns "[]" by default

    const plan = await buildNavPlan(repo.dir, "empty-stack", "o", "r");

    expect(plan).toHaveLength(0);
  });
});
