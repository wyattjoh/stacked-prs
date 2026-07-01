import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  createTestRepo,
  makeMockDir,
  runGit,
} from "../lib/testdata/helpers.ts";
import {
  addLandedParent,
  runGitCommand,
  setBaseBranch,
  setMergeStrategy,
  setStackArchived,
  setStackNode,
} from "../lib/stack.ts";
import { writeFixture } from "../lib/gh.ts";
import { getAllStackStatuses, getStackStatus } from "./status.ts";

function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

describe("getStackStatus", () => {
  test("populates latestCommitAt from the stack's branches", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setStackNode(repo.dir, "feat/b", "my-stack", "feat/a");
    await setBaseBranch(repo.dir, "my-stack", "main");

    const status = await getStackStatus(repo.dir, "my-stack");
    expect(status.latestCommitAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(status.latestCommitAt!))).toBe(false);
  });

  test("returns tree-structured status with depth info for a forked tree (a -> b + c)", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    // a is a root branch, b and c are children of a
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");
    await addBranch(repo.dir, "feature/c", "feature/a");

    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
    await setStackNode(repo.dir, "feature/c", "my-stack", "feature/a");
    await setBaseBranch(repo.dir, "my-stack", "main");

    // No PR fixtures needed for basic structure tests (mock returns [])

    const status = await getStackStatus(repo.dir, "my-stack");

    expect(status.stackName).toBe("my-stack");
    expect(status.branches).toHaveLength(3);

    const branchA = status.branches.find((b) => b.branch === "feature/a");
    const branchB = status.branches.find((b) => b.branch === "feature/b");
    const branchC = status.branches.find((b) => b.branch === "feature/c");

    // feature/a is a root: depth 0, childCount 2
    expect(branchA).toBeDefined();
    expect(branchA!.depth).toBe(0);
    expect(branchA!.childCount).toBe(2);
    expect(branchA!.parent).toBe("main");

    // feature/b and feature/c are at depth 1
    expect(branchB).toBeDefined();
    expect(branchB!.depth).toBe(1);
    expect(branchB!.childCount).toBe(0);
    expect(branchB!.parent).toBe("feature/a");

    expect(branchC).toBeDefined();
    expect(branchC!.depth).toBe(1);
    expect(branchC!.childCount).toBe(0);
    expect(branchC!.parent).toBe("feature/a");

    // Siblings: b comes before c alphabetically, so b is not last, c is last
    expect(branchB!.isLastChild).toBe(false);
    expect(branchC!.isLastChild).toBe(true);
  });

  test("formats human-readable ladder output in postorder", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");

    await setStackNode(repo.dir, "feature/a", "auth-rework", "main");
    await setStackNode(repo.dir, "feature/b", "auth-rework", "feature/a");
    await setBaseBranch(repo.dir, "auth-rework", "main");
    await setMergeStrategy(repo.dir, "auth-rework", "squash");

    const status = await getStackStatus(repo.dir, "auth-rework");
    const display = stripAnsi(status.display);

    expect(display).not.toContain("Stack:");
    expect(display).toMatch(/^◯\s+feature\/b\s+up-to-date$/m);
    expect(display).toMatch(/^◯\s+feature\/a\s+up-to-date$/m);
    expect(display).toMatch(/^◉\s+main\s*$/m);
    expect(display).not.toContain("─┘");
    expect(display).not.toContain("─┴─┘");
    expect(display.indexOf("feature/b")).toBeLessThan(
      display.indexOf("feature/a"),
    );
    expect(display.indexOf("feature/a")).toBeLessThan(display.indexOf("main"));
  });

  test("keeps nested parent branches in the single connector column", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");
    await addBranch(repo.dir, "feature/c", "feature/b");

    await setStackNode(repo.dir, "feature/a", "linear-stack", "main");
    await setStackNode(repo.dir, "feature/b", "linear-stack", "feature/a");
    await setStackNode(repo.dir, "feature/c", "linear-stack", "feature/b");
    await setBaseBranch(repo.dir, "linear-stack", "main");

    const status = await getStackStatus(repo.dir, "linear-stack");
    const display = stripAnsi(status.display);

    expect(display).toMatch(/^◯\s+feature\/c\s+up-to-date$/m);
    expect(display).toMatch(/^◯\s+feature\/b\s+up-to-date$/m);
    expect(display).not.toMatch(/^│ ◯─┘\s+feature\/b/m);
    expect(display).toMatch(/^◯\s+feature\/a\s+up-to-date$/m);
  });

  test("preserves the tree root order instead of reordering by subtree size", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/a-root", "main");
    await addBranch(repo.dir, "feature/z-root", "main");
    await addBranch(repo.dir, "feature/z-child", "feature/z-root");

    await setStackNode(repo.dir, "feature/a-root", "root-order", "main");
    await setStackNode(repo.dir, "feature/z-root", "root-order", "main");
    await setStackNode(
      repo.dir,
      "feature/z-child",
      "root-order",
      "feature/z-root",
    );
    await setBaseBranch(repo.dir, "root-order", "main");

    const status = await getStackStatus(repo.dir, "root-order");
    const display = stripAnsi(status.display);

    expect(display.indexOf("feature/a-root")).toBeLessThan(
      display.indexOf("feature/z-child"),
    );
    expect(display.indexOf("feature/z-child")).toBeLessThan(
      display.indexOf("feature/z-root"),
    );
  });

  test("correctly identifies current branch with isCurrent flag", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/x", "main");
    await addBranch(repo.dir, "feature/y", "feature/x");

    await setStackNode(repo.dir, "feature/x", "curr-stack", "main");
    await setStackNode(repo.dir, "feature/y", "curr-stack", "feature/x");
    await setBaseBranch(repo.dir, "curr-stack", "main");

    // Checkout feature/y so it becomes the current branch
    await runGit(repo.dir, "checkout", "feature/y");

    const status = await getStackStatus(repo.dir, "curr-stack");

    const branchX = status.branches.find((b) => b.branch === "feature/x");
    const branchY = status.branches.find((b) => b.branch === "feature/y");

    expect(branchX!.isCurrent).toBe(false);
    expect(branchY!.isCurrent).toBe(true);

    // Display should mark the current branch with a filled circle.
    expect(stripAnsi(status.display)).toMatch(
      /^◉\s+feature\/y\s+up-to-date$/m,
    );
  });

  test("renders the base branch as the last row and marks it current", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/root", "main");

    await setStackNode(repo.dir, "feature/root", "base-stack", "main");
    await setBaseBranch(repo.dir, "base-stack", "main");

    await runGit(repo.dir, "checkout", "main");

    const status = await getStackStatus(repo.dir, "base-stack");
    const display = stripAnsi(status.display);

    expect(display).toMatch(/^◯\s+feature\/root\s+up-to-date$/m);
    expect(display).toMatch(/^◉\s+main\s*$/m);
    expect(display.indexOf("feature/root")).toBeLessThan(
      display.indexOf("main"),
    );
  });

  test("renders multiple root subtrees with deeper trunk columns like gt ls", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/a-root", "main");
    await addBranch(repo.dir, "feature/a-leaf", "feature/a-root");
    await addBranch(repo.dir, "feature/a-side", "feature/a-root");
    await addBranch(repo.dir, "feature/b-root", "main");
    await addBranch(repo.dir, "feature/b-leaf", "feature/b-root");
    await addBranch(repo.dir, "feature/c-root", "main");

    await setStackNode(repo.dir, "feature/a-root", "multi-root", "main");
    await setStackNode(
      repo.dir,
      "feature/a-leaf",
      "multi-root",
      "feature/a-root",
    );
    await setStackNode(
      repo.dir,
      "feature/a-side",
      "multi-root",
      "feature/a-root",
    );
    await setStackNode(repo.dir, "feature/b-root", "multi-root", "main");
    await setStackNode(
      repo.dir,
      "feature/b-leaf",
      "multi-root",
      "feature/b-root",
    );
    await setStackNode(repo.dir, "feature/c-root", "multi-root", "main");
    await setBaseBranch(repo.dir, "multi-root", "main");

    const status = await getStackStatus(repo.dir, "multi-root");
    const display = stripAnsi(status.display);

    expect(display).toMatch(/^◯\s+feature\/a-leaf\s+up-to-date$/m);
    expect(display).toMatch(/^│ ◯\s+feature\/a-side\s+up-to-date$/m);
    expect(display).toMatch(/^◯─┘\s+feature\/a-root\s+up-to-date$/m);
    expect(display).toMatch(/^│ ◯\s+feature\/b-leaf\s+up-to-date$/m);
    expect(display).toMatch(/^│ ◯\s+feature\/b-root\s+up-to-date$/m);
    expect(display).toMatch(/^│ │ ◯\s+feature\/c-root\s+up-to-date$/m);
    expect(display).toMatch(/^◉─┴─┘\s+main\s*$/m);
  });

  test("detects behind-parent sync status", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/step1", "main");

    // Create feature/step2 as a plain branch pointer (no extra commit)
    // so it shares the exact tip of feature/step1 at branch time.
    await runGit(repo.dir, "checkout", "feature/step1");
    await runGit(repo.dir, "checkout", "-b", "feature/step2");
    await runGit(repo.dir, "checkout", "main");

    await setStackNode(repo.dir, "feature/step1", "diverge-stack", "main");
    await setStackNode(
      repo.dir,
      "feature/step2",
      "diverge-stack",
      "feature/step1",
    );
    await setBaseBranch(repo.dir, "diverge-stack", "main");

    // Add a new commit to feature/step1 AFTER feature/step2 was branched.
    // Since feature/step2 has no extra commits, it is purely behind feature/step1.
    await runGit(repo.dir, "checkout", "feature/step1");
    await Deno.writeTextFile(`${repo.dir}/extra.txt`, "extra\n");
    await runGit(repo.dir, "add", "extra.txt");
    await runGit(repo.dir, "commit", "-m", "add extra commit to step1");
    await runGit(repo.dir, "checkout", "main");

    const status = await getStackStatus(repo.dir, "diverge-stack");

    const step2 = status.branches.find((b) => b.branch === "feature/step2");
    expect(step2).toBeDefined();
    expect(step2!.syncStatus).toBe("behind-parent");
  });

  test("handles branches with no PR", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/solo", "main");

    await setStackNode(repo.dir, "feature/solo", "solo-stack", "main");
    await setBaseBranch(repo.dir, "solo-stack", "main");

    // No fixture written — gh mock returns "[]"

    const status = await getStackStatus(repo.dir, "solo-stack", "test", "repo");

    expect(status.branches).toHaveLength(1);
    expect(status.branches[0].pr).toBeNull();
  });

  test("does not load PR info unless explicitly enabled", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feature/pr1", "main");

    await setStackNode(repo.dir, "feature/pr1", "pr-stack", "main");
    await setBaseBranch(repo.dir, "pr-stack", "main");

    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feature/pr1", "--repo", "test/repo"],
      [{
        number: 101,
        url: "https://github.com/test/repo/pull/101",
        state: "OPEN",
        isDraft: false,
      }],
    );

    const status = await getStackStatus(repo.dir, "pr-stack", "test", "repo");

    expect(status.branches[0].pr).toBeNull();
    expect(stripAnsi(status.display)).not.toContain("#101");
  });

  test("includes PR info in annotations and display", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feature/pr1", "main");

    await setStackNode(repo.dir, "feature/pr1", "pr-stack", "main");
    await setBaseBranch(repo.dir, "pr-stack", "main");

    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feature/pr1", "--repo", "test/repo"],
      [{
        number: 101,
        url: "https://github.com/test/repo/pull/101",
        state: "OPEN",
        isDraft: false,
      }],
    );

    const status = await getStackStatus(repo.dir, "pr-stack", "test", "repo", {
      loadPrs: true,
    });

    expect(status.branches[0].pr).toEqual({
      number: 101,
      url: "https://github.com/test/repo/pull/101",
      state: "OPEN",
      isDraft: false,
    });

    // Display should include the PR number and sync metadata.
    const display = stripAnsi(status.display);
    expect(display).toContain("#101 (open)");
    expect(display).toContain("up-to-date");
    expect(display).not.toContain("PR #101");
  });

  test("surfaces merged PR when gh reports MERGED state", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feature/landed", "main");

    await setStackNode(repo.dir, "feature/landed", "landed-stack", "main");
    await setBaseBranch(repo.dir, "landed-stack", "main");

    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feature/landed", "--repo", "test/repo"],
      [{
        number: 117,
        url: "https://github.com/test/repo/pull/117",
        state: "MERGED",
        isDraft: false,
        createdAt: "2026-04-07T00:00:00Z",
      }],
    );

    const status = await getStackStatus(
      repo.dir,
      "landed-stack",
      "test",
      "repo",
      { loadPrs: true },
    );

    expect(status.branches[0].pr).toMatchObject({
      number: 117,
      state: "MERGED",
    });
  });
});

describe("getStackStatus with merged nodes", () => {
  test("returns 'landed' sync status for stack-merged branches", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await runGitCommand(
      repo.dir,
      "config",
      "branch.feature/a.stack-merged",
      "true",
    );

    const status = await getStackStatus(repo.dir, "my-stack");

    const branchA = status.branches.find((b) => b.branch === "feature/a");
    expect(branchA?.syncStatus).toBe("landed");
  });

  test("walks past tombstoned ancestors when computing sync status", async () => {
    // Reproduces the post-land state: `feature/landed` was squash-merged and
    // its local ref deleted, but `feature/live` still records it as its
    // stack-parent. computeSyncStatus would otherwise rev-list against a
    // dangling ref and fall back to "diverged"; the fix should walk to the
    // first live ancestor (main) and report up-to-date.
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/live", "main");

    await setStackNode(repo.dir, "feature/live", "s", "feature/landed");
    await setBaseBranch(repo.dir, "s", "main");
    await addLandedParent(repo.dir, "s", "feature/landed", "main");
    await addTombstone(repo.dir, "s", "feature/landed", { prNumber: 42 });

    const status = await getStackStatus(repo.dir, "s");
    const live = status.branches.find((b) => b.branch === "feature/live");
    expect(live?.syncStatus).toBe("up-to-date");
  });

  test("renders stack-level tombstone root as a landed node", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/live", "main");
    await setStackNode(repo.dir, "feature/live", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await addTombstone(repo.dir, "my-stack", "feature/landed", {
      prNumber: 51,
    });

    const status = await getStackStatus(repo.dir, "my-stack");

    const landed = status.branches.find((b) => b.branch === "feature/landed");
    expect(landed?.syncStatus).toBe("landed");
    expect(landed?.parent).toBe("main");
    // The live subtree still renders with computed sync status.
    const live = status.branches.find((b) => b.branch === "feature/live");
    expect(live?.syncStatus).toBe("up-to-date");
  });
});

describe("branch descriptions in status", () => {
  test("ladder shows a dimmed first line under a described branch", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await runGit(
      repo.dir,
      "config",
      "branch.feat/a.description",
      "adds the **api** client\nsecond line detail",
    );

    const status = await getStackStatus(repo.dir, "my-stack");
    const lines = stripAnsi(status.display).split("\n");
    expect(status.branches[0].description).toBe(
      "adds the **api** client\nsecond line detail",
    );
    expect(lines[1]).toContain("adds the api client");
    expect(lines[1].trimStart().startsWith("│")).toBe(true);
    expect(status.display).not.toContain("second line detail");
  });

  test("no description means no extra line", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");

    const status = await getStackStatus(repo.dir, "my-stack");
    expect(stripAnsi(status.display).split("\n")).toHaveLength(2);
    expect(status.branches[0].description).toBeUndefined();
  });

  test("fullDescriptions renders the whole markdown body with rails", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await runGit(
      repo.dir,
      "config",
      "branch.feat/a.description",
      "summary line\n\n- cache reads\n- invalidate on submit",
    );

    const status = await getStackStatus(
      repo.dir,
      "my-stack",
      undefined,
      undefined,
      { fullDescriptions: true },
    );
    const display = stripAnsi(status.display);
    expect(display).toContain("summary line");
    expect(display).toContain("• cache reads");
    expect(display).toContain("• invalidate on submit");
    for (const line of display.split("\n").slice(1, -1)) {
      expect(line.trimStart().startsWith("│")).toBe(true);
    }
  });
});

describe("getAllStackStatuses", () => {
  test("renders all stacks grouped under their shared base branch", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/auth", "main");
    await addBranch(repo.dir, "feature/auth-api", "feature/auth");
    await addBranch(repo.dir, "feature/payments", "main");

    await setStackNode(repo.dir, "feature/auth", "auth-stack", "main");
    await setStackNode(
      repo.dir,
      "feature/auth-api",
      "auth-stack",
      "feature/auth",
    );
    await setBaseBranch(repo.dir, "auth-stack", "main");
    await setMergeStrategy(repo.dir, "auth-stack", "squash");

    await setStackNode(repo.dir, "feature/payments", "payments-stack", "main");
    await setBaseBranch(repo.dir, "payments-stack", "main");

    await runGit(repo.dir, "checkout", "feature/auth-api");

    const status = await getAllStackStatuses(repo.dir);
    const display = stripAnsi(status.display);

    expect(status.stacks.map((stack) => stack.stackName)).toEqual([
      "auth-stack",
      "payments-stack",
    ]);
    expect(display).not.toContain("Base: ");
    expect(display).toMatch(/^◉\s+feature\/auth-api\s+up-to-date$/m);
    expect(display).toMatch(/^◯\s+feature\/auth\s+up-to-date$/m);
    expect(display).toMatch(/^│ ◯\s+feature\/payments\s+up-to-date$/m);
    expect(display).toMatch(/^◯─┘\s+main\s*$/m);
    expect(display).not.toContain("─┴─┘");
    expect(display).not.toContain("[auth-stack]");
    expect(display).not.toContain("[payments-stack]");
  });

  test("renders separate sections for different base branches", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/main-root", "main");
    await addBranch(repo.dir, "release/1.0", "main");
    await addBranch(repo.dir, "feature/release-root", "release/1.0");

    await setStackNode(repo.dir, "feature/main-root", "main-stack", "main");
    await setBaseBranch(repo.dir, "main-stack", "main");

    await setStackNode(
      repo.dir,
      "feature/release-root",
      "release-stack",
      "release/1.0",
    );
    await setBaseBranch(repo.dir, "release-stack", "release/1.0");

    const status = await getAllStackStatuses(repo.dir);
    const display = stripAnsi(status.display);

    expect(display).not.toContain("Base: ");
    expect(display).toMatch(/^◯\s+feature\/release-root\s+up-to-date$/m);
    expect(display).toMatch(/^◯\s+feature\/main-root\s+up-to-date$/m);
    expect(display).toMatch(/^◉\s+main\s*$/m);
    expect(display).toMatch(/^◯\s+release\/1.0\s*$/m);
    expect(display).not.toContain("[release-stack]");
    expect(display).not.toContain("(no PR)");
  });

  test("includes archived stacks in stacks[] with the flag, hidden from display by default", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "a/1", "main");
    await addBranch(repo.dir, "b/1", "main");
    await setBaseBranch(repo.dir, "stack-a", "main");
    await setStackNode(repo.dir, "a/1", "stack-a", "main");
    await setBaseBranch(repo.dir, "stack-b", "main");
    await setStackNode(repo.dir, "b/1", "stack-b", "main");
    await setStackArchived(repo.dir, "stack-b", true);

    const status = await getAllStackStatuses(repo.dir);
    // stacks[] always carries every stack with its archived flag.
    const byName = new Map(status.stacks.map((s) => [s.stackName, s]));
    expect(byName.get("stack-a")?.archived).toBe(false);
    expect(byName.get("stack-b")?.archived).toBe(true);
    // display hides the archived branch by default.
    expect(status.display).toContain("a/1");
    expect(status.display).not.toContain("b/1");
  });

  test("showArchived includes archived stacks in display", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "a/1", "main");
    await addBranch(repo.dir, "b/1", "main");
    await setBaseBranch(repo.dir, "stack-a", "main");
    await setStackNode(repo.dir, "a/1", "stack-a", "main");
    await setBaseBranch(repo.dir, "stack-b", "main");
    await setStackNode(repo.dir, "b/1", "stack-b", "main");
    await setStackArchived(repo.dir, "stack-b", true);

    const status = await getAllStackStatuses(repo.dir, undefined, undefined, {
      showArchived: true,
    });
    expect(status.display).toContain("a/1");
    expect(status.display).toContain("b/1");
  });
});
