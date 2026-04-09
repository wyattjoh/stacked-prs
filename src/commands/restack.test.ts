import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  commitFile,
  createTestRepo,
  runGit,
} from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import {
  setBaseBranch,
  setStackNode,
  type StackNode,
  type StackTree,
} from "../lib/stack.ts";
import {
  decomposeSegments,
  executeRestack,
  planRestack,
  restack,
  topologicalOrder,
} from "./restack.ts";

// ---------------------------------------------------------------------------
// Helpers to build minimal StackTree objects for pure-logic unit tests
// ---------------------------------------------------------------------------

function makeTree(
  baseBranch: string,
  roots: StackNode[],
): StackTree {
  return {
    stackName: "test",
    baseBranch,
    mergeStrategy: undefined,
    roots,
  };
}

function makeNode(
  branch: string,
  parent: string,
  children: StackNode[] = [],
): StackNode {
  return { branch, stackName: "test", parent, children };
}

// ---------------------------------------------------------------------------
// Unit tests: decomposeSegments (no git required)
// ---------------------------------------------------------------------------

describe("decomposeSegments", () => {
  test("linear chain produces a single segment", () => {
    // main -> a -> b -> c
    const tree = makeTree("main", [
      makeNode("a", "main", [
        makeNode("b", "a", [
          makeNode("c", "b"),
        ]),
      ]),
    ]);

    const segments = decomposeSegments(tree);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({
      tip: "c",
      base: "main",
      branches: ["a", "b", "c"],
    });
  });

  test("fork produces multiple segments", () => {
    // main -> auth -> auth-tests -> auth-ui
    //                            -> auth-api  (fork at auth)
    const tree = makeTree("main", [
      makeNode("auth", "main", [
        makeNode("auth-tests", "auth", [
          makeNode("auth-ui", "auth-tests"),
        ]),
        makeNode("auth-api", "auth"),
      ]),
    ]);

    const segments = decomposeSegments(tree);

    expect(segments).toHaveLength(3);

    const seg1 = segments.find((s) => s.tip === "auth");
    expect(seg1).toEqual({ tip: "auth", base: "main", branches: ["auth"] });

    const seg2 = segments.find((s) => s.tip === "auth-ui");
    expect(seg2).toEqual({
      tip: "auth-ui",
      base: "auth",
      branches: ["auth-tests", "auth-ui"],
    });

    const seg3 = segments.find((s) => s.tip === "auth-api");
    expect(seg3).toEqual({
      tip: "auth-api",
      base: "auth",
      branches: ["auth-api"],
    });
  });

  test("deep fork (fork from fork) produces correct segments", () => {
    // main -> a -> b -> c
    //                -> d -> e
    //                     -> f
    const tree = makeTree("main", [
      makeNode("a", "main", [
        makeNode("b", "a", [
          makeNode("c", "b"),
          makeNode("d", "b", [
            makeNode("e", "d"),
            makeNode("f", "d"),
          ]),
        ]),
      ]),
    ]);

    const segments = decomposeSegments(tree);

    // Expected segments:
    // 1. {tip: "b", base: "main", branches: ["a", "b"]}
    // 2. {tip: "c", base: "b", branches: ["c"]}
    // 3. {tip: "d", base: "b", branches: ["d"]}
    // 4. {tip: "e", base: "d", branches: ["e"]}
    // 5. {tip: "f", base: "d", branches: ["f"]}
    expect(segments).toHaveLength(5);

    expect(segments.find((s) => s.tip === "b")).toEqual({
      tip: "b",
      base: "main",
      branches: ["a", "b"],
    });
    expect(segments.find((s) => s.tip === "c")).toEqual({
      tip: "c",
      base: "b",
      branches: ["c"],
    });
    expect(segments.find((s) => s.tip === "d")).toEqual({
      tip: "d",
      base: "b",
      branches: ["d"],
    });
    expect(segments.find((s) => s.tip === "e")).toEqual({
      tip: "e",
      base: "d",
      branches: ["e"],
    });
    expect(segments.find((s) => s.tip === "f")).toEqual({
      tip: "f",
      base: "d",
      branches: ["f"],
    });
  });

  test("single root node produces single segment", () => {
    const tree = makeTree("main", [makeNode("feature", "main")]);
    const segments = decomposeSegments(tree);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({
      tip: "feature",
      base: "main",
      branches: ["feature"],
    });
  });

  test("empty tree produces no segments", () => {
    const tree = makeTree("main", []);
    const segments = decomposeSegments(tree);
    expect(segments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: restack against real git repos
// ---------------------------------------------------------------------------

async function setupStack(
  dir: string,
  stackName: string,
  baseBranch: string,
): Promise<void> {
  await setBaseBranch(dir, stackName, baseBranch);
}

async function addStackBranch(
  dir: string,
  stackName: string,
  branch: string,
  parent: string,
): Promise<void> {
  await addBranch(dir, branch, parent);
  await setStackNode(dir, branch, stackName, parent);
}

describe("restack integration", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("linear chain already synced returns ok with no rebases", async () => {
    await addStackBranch(repo.dir, "my-stack", "feature/a", "main");
    await addStackBranch(repo.dir, "my-stack", "feature/b", "feature/a");
    await setupStack(repo.dir, "my-stack", "main");

    const result = await restack(repo.dir, "my-stack");

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.skipped).toHaveLength(0);
  });

  test("successful restack of a linear chain after base moves", async () => {
    await addStackBranch(repo.dir, "my-stack", "feature/a", "main");
    await addStackBranch(repo.dir, "my-stack", "feature/b", "feature/a");
    await setupStack(repo.dir, "my-stack", "main");

    // Advance main to make feature/a stale
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-update.txt", "main update\n");

    // feature/a should now be rebased onto updated main
    const result = await restack(repo.dir, "my-stack");

    expect(result.ok).toBe(true);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].exitCode).toBe(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("successful restack of a forked tree", async () => {
    // main -> auth -> auth-a
    //              -> auth-b
    await addStackBranch(repo.dir, "my-stack", "auth", "main");
    await addStackBranch(repo.dir, "my-stack", "auth-a", "auth");
    await addStackBranch(repo.dir, "my-stack", "auth-b", "auth");
    await setupStack(repo.dir, "my-stack", "main");

    // Advance main so auth becomes stale
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-update.txt", "main update\n");

    const result = await restack(repo.dir, "my-stack");

    expect(result.ok).toBe(true);
    expect(result.skipped).toHaveLength(0);
    // Segments: auth segment (stale), auth-a (already synced after rebase), auth-b (already synced)
    const failed = result.segments.filter((s) => s.exitCode !== 0);
    expect(failed).toHaveLength(0);
  });

  test("--upstack-from filters to subtree only", async () => {
    // main -> a -> b -> c
    await addStackBranch(repo.dir, "my-stack", "a", "main");
    await addStackBranch(repo.dir, "my-stack", "b", "a");
    await addStackBranch(repo.dir, "my-stack", "c", "b");
    await setupStack(repo.dir, "my-stack", "main");

    // Advance 'a' to make b and c stale (but a is still synced with main)
    await runGit(repo.dir, "checkout", "a");
    await commitFile(repo.dir, "a-update.txt", "a update\n");
    await runGit(repo.dir, "checkout", "main");

    const result = await restack(repo.dir, "my-stack", { upstackFrom: "b" });

    expect(result.ok).toBe(true);
    // Should only process segments with tip "c" (b+c in one segment since linear)
    // The single segment covers b and c (tip=c, base=a)
    const processedTips = result.segments.map((s) => s.tip);
    expect(processedTips).toContain("c");
    // Should not have processed the auth/a segment
    expect(processedTips).not.toContain("a");
  });

  test("conflict detection and reporting", async () => {
    // Set up a branch that will conflict during rebase
    await addStackBranch(repo.dir, "my-stack", "feature", "main");
    await setupStack(repo.dir, "my-stack", "main");

    // Add a conflicting change to main on the same file
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "feature.txt", "main version of file\n");

    // Also modify the same file on feature (addBranch already created feature.txt)
    await runGit(repo.dir, "checkout", "feature");
    // feature.txt was created as "Branch: feature\n" by addBranch
    // Now main has a different feature.txt commit; rebase will conflict
    // Overwrite with yet another version to guarantee conflict
    await commitFile(repo.dir, "feature.txt", "feature version of file\n");
    await runGit(repo.dir, "checkout", "main");

    const result = await restack(repo.dir, "my-stack");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("conflict");
    expect(result.recovery).toBeDefined();
    expect(result.recovery?.abort).toContain("git rebase --abort");
    expect(result.recovery?.resolve).toContain("git rebase --continue");

    // Abort the rebase so the repo is clean for teardown
    await runGit(repo.dir, "rebase", "--abort").catch(() => {});
  });

  test("segments dependent on failed base are skipped", async () => {
    // main -> auth -> auth-a
    //              -> auth-b
    // auth will conflict; auth-a and auth-b should be skipped
    await addStackBranch(repo.dir, "my-stack", "auth", "main");
    await addStackBranch(repo.dir, "my-stack", "auth-a", "auth");
    await addStackBranch(repo.dir, "my-stack", "auth-b", "auth");
    await setupStack(repo.dir, "my-stack", "main");

    // Make auth stale with a conflict on auth.txt
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "auth.txt", "main version\n");

    await runGit(repo.dir, "checkout", "auth");
    await commitFile(repo.dir, "auth.txt", "auth version\n");
    await runGit(repo.dir, "checkout", "main");

    const result = await restack(repo.dir, "my-stack");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("conflict");
    // auth-a and auth-b should be in skipped
    const skippedTips = result.skipped.map((s) => s.tip);
    expect(skippedTips).toContain("auth-a");
    expect(skippedTips).toContain("auth-b");

    await runGit(repo.dir, "rebase", "--abort").catch(() => {});
  });
});

describe("topologicalOrder", () => {
  test("linear chain yields parents before children", () => {
    const tree = makeTree("main", [
      makeNode("a", "main", [
        makeNode("b", "a", [
          makeNode("c", "b"),
        ]),
      ]),
    ]);

    const order = topologicalOrder(tree).map((n) => n.branch);

    expect(order).toEqual(["a", "b", "c"]);
  });

  test("fork yields parent before both children, left subtree before right", () => {
    const tree = makeTree("main", [
      makeNode("auth", "main", [
        makeNode("auth-api", "auth"),
        makeNode("auth-tests", "auth", [
          makeNode("auth-ui", "auth-tests"),
        ]),
      ]),
    ]);

    const order = topologicalOrder(tree).map((n) => n.branch);

    // auth comes first; auth-api (left) before auth-tests subtree
    expect(order[0]).toBe("auth");
    expect(order.indexOf("auth-api")).toBeLessThan(order.indexOf("auth-tests"));
    expect(order.indexOf("auth-tests")).toBeLessThan(order.indexOf("auth-ui"));
  });

  test("multiple roots yield each root's subtree in order", () => {
    const tree = makeTree("main", [
      makeNode("x", "main"),
      makeNode("y", "main", [makeNode("y1", "y")]),
    ]);

    const order = topologicalOrder(tree).map((n) => n.branch);

    expect(order).toEqual(["x", "y", "y1"]);
  });
});

describe("planRestack (dry-run)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("linear chain already in sync returns all skipped-clean", async () => {
    // main -> a -> b
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    const plan = await planRestack(repo.dir, "test", {});

    expect(plan.rebases).toHaveLength(2);
    expect(plan.rebases.every((r) => r.status === "skipped-clean")).toBe(true);
    expect(plan.ok).toBe(true);
  });

  test("base moved: both branches planned, snapshot uses original parent", async () => {
    // main -> a -> b, then add a commit directly to main
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    const originalA = await runGit(repo.dir, "rev-parse", "a");

    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");

    const plan = await planRestack(repo.dir, "test", {});

    expect(plan.rebases).toHaveLength(2);
    const a = plan.rebases.find((r) => r.branch === "a")!;
    const b = plan.rebases.find((r) => r.branch === "b")!;
    expect(a.status).toBe("planned");
    expect(b.status).toBe("planned");
    // b's old parent sha should match a's current (pre-rebase) SHA, since
    // b's tree parent is a and we snapshot the parent ref at plan time.
    expect(b.oldParentSha).toBe(originalA);
  });

  test("dry-run makes no mutation", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");

    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");

    const aBefore = await runGit(repo.dir, "rev-parse", "a");
    const mainBefore = await runGit(repo.dir, "rev-parse", "main");

    await planRestack(repo.dir, "test", {});

    const aAfter = await runGit(repo.dir, "rev-parse", "a");
    const mainAfter = await runGit(repo.dir, "rev-parse", "main");

    expect(aAfter).toBe(aBefore);
    expect(mainAfter).toBe(mainBefore);
  });
});

/**
 * Set up a local "origin" remote pointing at a bare clone of this repo so
 * the restack algorithm can resolve `origin/main`. Called by any test that
 * exercises the origin/<base> resolution path.
 */
async function setupFakeOrigin(dir: string): Promise<void> {
  const bareDir = await Deno.makeTempDir({ prefix: "stacked-prs-origin-" });
  await runGit(dir, "clone", "--bare", dir, bareDir);
  await runGit(dir, "remote", "add", "origin", bareDir);
  await runGit(dir, "fetch", "origin");
}

describe("executeRestack (clean cases)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("linear chain already synced is a no-op", async () => {
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    await setupFakeOrigin(repo.dir);

    const bBefore = await runGit(repo.dir, "rev-parse", "b");

    const result = await executeRestack(repo.dir, "test", {});

    const bAfter = await runGit(repo.dir, "rev-parse", "b");

    expect(result.ok).toBe(true);
    expect(bAfter).toBe(bBefore);
    expect(result.rebases.every((r) => r.status === "skipped-clean")).toBe(
      true,
    );
  });

  test("base advanced: all branches rebased, commits preserved", async () => {
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    // Simulate `origin/main` advancing by creating an `origin` remote.
    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    // Rewind local main so origin/main is ahead.
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const result = await executeRestack(repo.dir, "test", {});

    expect(result.ok).toBe(true);
    expect(result.rebases.map((r) => r.status))
      .toEqual(["rebased", "rebased"]);

    // Both branches should contain the new main-extra.txt commit.
    const aLog = await runGit(repo.dir, "log", "--format=%s", "a");
    const bLog = await runGit(repo.dir, "log", "--format=%s", "b");
    expect(aLog).toContain("add main-extra.txt");
    expect(bLog).toContain("add main-extra.txt");
    expect(bLog).toContain("add a.txt");
    expect(bLog).toContain("add b.txt");
  });

  test("regression: middle-branch drift is propagated upward", async () => {
    // main -> a -> b -> c, then commit directly to a without propagating.
    // Old segment-based restack would drop the commit; per-branch must keep it.
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await addBranch(repo.dir, "c", "b");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");
    await setStackNode(repo.dir, "c", "test", "b");

    // Add an unpropagated commit on a
    await runGit(repo.dir, "checkout", "a");
    await commitFile(repo.dir, "a-drift.txt", "drift\n");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await runGit(repo.dir, "push", "origin", "main");

    const result = await executeRestack(repo.dir, "test", {});

    expect(result.ok).toBe(true);

    // The drift commit must end up in both b and c's history.
    const bLog = await runGit(repo.dir, "log", "--format=%s", "b");
    const cLog = await runGit(repo.dir, "log", "--format=%s", "c");
    expect(bLog).toContain("add a-drift.txt");
    expect(cLog).toContain("add a-drift.txt");
    // And must not be duplicated.
    expect(bLog.match(/add a-drift\.txt/g)).toHaveLength(1);
    expect(cLog.match(/add a-drift\.txt/g)).toHaveLength(1);
  });
});

describe("executeRestack (conflict handling)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    // Abort any in-progress rebase so cleanup() can succeed.
    await runGit(repo.dir, "rebase", "--abort").catch(() => {});
    await repo.cleanup();
  });

  test("conflict stops the walk; siblings are deferred to resume", async () => {
    // main -> root -> { leftConflict, rightClean }
    // Add a commit on main that touches the same file as leftConflict.
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "shared.txt", "initial\n");

    await addBranch(repo.dir, "root", "main");

    await runGit(repo.dir, "checkout", "-b", "leftConflict", "root");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "left version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "left edits shared");

    await runGit(repo.dir, "checkout", "-b", "leftChild", "leftConflict");
    await commitFile(repo.dir, "leftChild.txt", "lc\n");

    await addBranch(repo.dir, "rightClean", "root");

    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "root", "test", "main");
    await setStackNode(repo.dir, "leftConflict", "test", "root");
    await setStackNode(repo.dir, "leftChild", "test", "leftConflict");
    await setStackNode(repo.dir, "rightClean", "test", "root");

    // Advance origin/main with a conflicting change to shared.txt.
    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "main version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "main edits shared");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const rightCleanBefore = await runGit(repo.dir, "rev-parse", "rightClean");

    const result = await executeRestack(repo.dir, "test", {});

    expect(result.ok).toBe(false);
    expect(result.error).toBe("conflict");

    const byBranch = new Map(result.rebases.map((r) => [r.branch, r]));
    expect(byBranch.get("root")!.status).toBe("rebased");
    expect(byBranch.get("leftConflict")!.status).toBe("conflict");
    expect(byBranch.get("leftChild")!.status).toBe("skipped-due-to-conflict");
    // rightClean is independent of the conflicted subtree but the walk stops
    // at the first conflict so the mid-rebase state stays visible and
    // `git rebase --continue` keeps working.
    expect(byBranch.get("rightClean")!.status).toBe("skipped-due-to-conflict");

    // rightClean must not have been touched.
    const rightCleanAfter = await runGit(repo.dir, "rev-parse", "rightClean");
    expect(rightCleanAfter).toBe(rightCleanBefore);

    expect(result.recovery).toBeDefined();
    expect(result.recovery!.resolve).toContain("rebase --continue");
  });
});

describe("executeRestack (resume)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await runGit(repo.dir, "rebase", "--abort").catch(() => {});
    await repo.cleanup();
  });

  test("resume after manual conflict resolution continues the walk", async () => {
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "shared.txt", "initial\n");
    await addBranch(repo.dir, "root", "main");

    await runGit(repo.dir, "checkout", "-b", "leftConflict", "root");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "left version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "left edits shared");

    await addBranch(repo.dir, "rightClean", "root");

    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "root", "test", "main");
    await setStackNode(repo.dir, "leftConflict", "test", "root");
    await setStackNode(repo.dir, "rightClean", "test", "root");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "main version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "main edits shared");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    // First run: leftConflict fails.
    const first = await executeRestack(repo.dir, "test", {});
    expect(first.ok).toBe(false);
    expect(first.error).toBe("conflict");

    // Simulate the user resolving the conflict.
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "left version\n");
    await runGit(repo.dir, "add", "shared.txt");

    // Second run with --resume
    const second = await executeRestack(repo.dir, "test", { resume: true });

    expect(second.ok).toBe(true);
    const leftConflictLog = await runGit(
      repo.dir,
      "log",
      "--format=%s",
      "leftConflict",
    );
    expect(leftConflictLog).toContain("left edits shared");
    expect(leftConflictLog).toContain("main edits shared");

    // rightClean must have been rebased in the resume walk.
    const rightCleanLog = await runGit(
      repo.dir,
      "log",
      "--format=%s",
      "rightClean",
    );
    expect(rightCleanLog).toContain("main edits shared");

    // Resume state should be cleared after success.
    let resumeStateExists = false;
    try {
      await runGit(repo.dir, "config", "stack.test.resume-state");
      resumeStateExists = true;
    } catch {
      // not set, good
    }
    expect(resumeStateExists).toBe(false);
  });

  test("resume without in-progress state throws", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setupFakeOrigin(repo.dir);

    let threw = false;
    try {
      await executeRestack(repo.dir, "test", { resume: true });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("No restack in progress");
    }
    expect(threw).toBe(true);
  });
});

describe("executeRestack (filters)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("--upstack-from rebases the target subtree, leaves ancestors alone", async () => {
    // main -> a -> b -> c. Advance main so all three become stale, then scope
    // the restack to `b`'s upstack (b and c). `a` must stay untouched.
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await addBranch(repo.dir, "c", "b");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");
    await setStackNode(repo.dir, "c", "test", "b");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const aBefore = await runGit(repo.dir, "rev-parse", "a");

    const result = await executeRestack(repo.dir, "test", { upstackFrom: "b" });

    expect(result.ok).toBe(true);
    expect(result.rebases.map((r) => r.branch)).toEqual(["b", "c"]);

    const aAfter = await runGit(repo.dir, "rev-parse", "a");
    expect(aAfter).toBe(aBefore);
  });

  test("--upstack-from on a forked tree includes all descendants", async () => {
    // main -> auth -> auth-a
    //              -> auth-b
    // Scope to `auth`; both auth-a and auth-b must be in scope, auth too.
    await addBranch(repo.dir, "auth", "main");
    await addBranch(repo.dir, "auth-a", "auth");
    await addBranch(repo.dir, "auth-b", "auth");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "auth", "test", "main");
    await setStackNode(repo.dir, "auth-a", "test", "auth");
    await setStackNode(repo.dir, "auth-b", "test", "auth");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const result = await executeRestack(repo.dir, "test", {
      upstackFrom: "auth",
    });

    expect(result.ok).toBe(true);
    const branches = result.rebases.map((r) => r.branch).sort();
    expect(branches).toEqual(["auth", "auth-a", "auth-b"]);
  });

  test("--downstack-from rebases the path from root to the target", async () => {
    // main -> a -> b -> c. Scope to `b`'s downstack (a and b). `c` must stay
    // untouched.
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await addBranch(repo.dir, "c", "b");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");
    await setStackNode(repo.dir, "c", "test", "b");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const cBefore = await runGit(repo.dir, "rev-parse", "c");

    const result = await executeRestack(repo.dir, "test", {
      downstackFrom: "b",
    });

    expect(result.ok).toBe(true);
    expect(result.rebases.map((r) => r.branch)).toEqual(["a", "b"]);

    const cAfter = await runGit(repo.dir, "rev-parse", "c");
    expect(cAfter).toBe(cBefore);
  });

  test("--only rebases just the named branch", async () => {
    // main -> a -> b -> c. Scope to `a`. Neither `b` nor `c` may move.
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await addBranch(repo.dir, "c", "b");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");
    await setStackNode(repo.dir, "c", "test", "b");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const bBefore = await runGit(repo.dir, "rev-parse", "b");
    const cBefore = await runGit(repo.dir, "rev-parse", "c");

    const result = await executeRestack(repo.dir, "test", { only: "a" });

    expect(result.ok).toBe(true);
    expect(result.rebases.map((r) => r.branch)).toEqual(["a"]);

    const bAfter = await runGit(repo.dir, "rev-parse", "b");
    const cAfter = await runGit(repo.dir, "rev-parse", "c");
    expect(bAfter).toBe(bBefore);
    expect(cAfter).toBe(cBefore);
  });

  test("--upstack-from with a non-existent branch produces no rebases", async () => {
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const aBefore = await runGit(repo.dir, "rev-parse", "a");
    const bBefore = await runGit(repo.dir, "rev-parse", "b");

    const result = await executeRestack(repo.dir, "test", {
      upstackFrom: "does-not-exist",
    });

    expect(result.ok).toBe(true);
    expect(result.rebases).toHaveLength(0);

    const aAfter = await runGit(repo.dir, "rev-parse", "a");
    const bAfter = await runGit(repo.dir, "rev-parse", "b");
    expect(aAfter).toBe(aBefore);
    expect(bAfter).toBe(bBefore);
  });
});
