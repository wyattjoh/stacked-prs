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
import { executeRestack, planRestack, topologicalOrder } from "./restack.ts";

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

  test("regression: inserted branch with new commit propagates to reparented upstack children", async () => {
    // Scenario from conversation: a new branch is inserted between two existing
    // stack branches, then a commit is added to the inserted branch. Old
    // segment-based restack left the reparented children diverged; per-branch
    // --onto must rebase them correctly.
    //
    // Stack before insert: main -> a -> b -> c
    // After inserting x between a and b: main -> a -> x -> b -> c
    //   (b is reparented in config but still based on a's old tip)
    // After adding a commit to x, b and c don't have that commit yet.

    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await addBranch(repo.dir, "c", "b");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");
    await setStackNode(repo.dir, "c", "test", "b");

    // Simulate inserting x between a and b: create x from a, reparent b to x.
    await runGit(repo.dir, "checkout", "-b", "x", "a");
    await setStackNode(repo.dir, "x", "test", "a");
    await setStackNode(repo.dir, "b", "test", "x");

    // Add a commit to x (b and c still don't have this commit).
    await commitFile(repo.dir, "x-fix.txt", "inserted fix\n");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await runGit(repo.dir, "push", "origin", "main");

    const result = await executeRestack(repo.dir, "test", {});

    expect(result.ok).toBe(true);

    // b and c must have x's commit propagated upward.
    const bLog = await runGit(repo.dir, "log", "--format=%s", "b");
    const cLog = await runGit(repo.dir, "log", "--format=%s", "c");
    expect(bLog).toContain("add x-fix.txt");
    expect(cLog).toContain("add x-fix.txt");

    // The x commit must appear exactly once in each upstack branch history.
    expect(bLog.match(/add x-fix\.txt/g)).toHaveLength(1);
    expect(cLog.match(/add x-fix\.txt/g)).toHaveLength(1);
  });

  test("preserves merge commits in stack branches", async () => {
    // main initial commit already exists from createTestRepo.

    // Create a side branch off main with a commit. This is NOT in the stack,
    // it's just something the stack branch will merge in.
    await runGit(repo.dir, "checkout", "-b", "side", "main");
    await commitFile(repo.dir, "side.txt", "side\n");

    // Create the stack branch off main with its own commit.
    await runGit(repo.dir, "checkout", "-b", "feat/a", "main");
    await commitFile(repo.dir, "a.txt", "a\n");

    // While on feat/a, merge `side` with --no-ff to force a merge commit.
    await runGit(
      repo.dir,
      "merge",
      "--no-ff",
      "side",
      "-m",
      "merge side into feat/a",
    );

    // Confirm the merge commit exists pre-restack.
    const preMergeCount =
      (await runGit(repo.dir, "log", "--merges", "--format=%H", "feat/a"))
        .split("\n")
        .filter(Boolean).length;
    expect(preMergeCount).toBe(1);

    // Configure stack
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "feat/a", "test", "main");

    // Advance origin/main so feat/a needs rebasing.
    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "main extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const result = await executeRestack(repo.dir, "test", {});

    expect(result.ok).toBe(true);
    expect(result.rebases).toHaveLength(1);
    expect(result.rebases[0].status).toBe("rebased");

    // After rebase, the merge commit must still exist.
    const postMergeCount =
      (await runGit(repo.dir, "log", "--merges", "--format=%H", "feat/a"))
        .split("\n")
        .filter(Boolean).length;
    expect(postMergeCount).toBe(1);

    // The merge commit's two parents should still be present.
    const mergeSha =
      (await runGit(repo.dir, "log", "--merges", "--format=%H", "feat/a"))
        .split("\n")[0];
    const parents =
      (await runGit(repo.dir, "rev-list", "--parents", "-n", "1", mergeSha))
        .split(" ");
    // Output: <merge-sha> <parent1> <parent2>
    expect(parents.length).toBe(3);

    // The new main commit should be in feat/a's history (rebase moved it).
    const log = await runGit(repo.dir, "log", "--format=%s", "feat/a");
    expect(log).toContain("add main-extra.txt");
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
});

describe("executeRestack (codex review fixes)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await runGit(repo.dir, "rebase", "--abort").catch(() => {});
    await repo.cleanup();
  });

  test("[fix1] resume correctly identifies conflicted branch when a clean branch precedes it", async () => {
    // main -> a (clean) -> b (clean) -> c (conflict).
    // `a` and `b` will be skipped-clean, `c` hits a conflict. On resume, the
    // old "first non-completed in plan order" inference would incorrectly mark
    // `a` as just-continued; with conflictedBranch in resume-state we mark `c`.
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "shared.txt", "initial\n");

    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");

    await runGit(repo.dir, "checkout", "-b", "c", "b");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "c version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "c edits shared");

    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");
    await setStackNode(repo.dir, "c", "test", "b");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "main version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "main edits shared");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const first = await executeRestack(repo.dir, "test", {});
    expect(first.ok).toBe(false);
    expect(first.error).toBe("conflict");
    // Confirm it was c that conflicted.
    const byBranch = new Map(first.rebases.map((r) => [r.branch, r]));
    expect(byBranch.get("c")!.status).toBe("conflict");

    // Verify resume-state now includes conflictedBranch = "c".
    const stateRaw = await runGit(
      repo.dir,
      "config",
      "stack.test.resume-state",
    );
    const state = JSON.parse(stateRaw) as { conflictedBranch?: string };
    expect(state.conflictedBranch).toBe("c");

    // Resolve the conflict.
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "c version\n");
    await runGit(repo.dir, "add", "shared.txt");

    const second = await executeRestack(repo.dir, "test", { resume: true });
    expect(second.ok).toBe(true);

    // c must contain both commits; importantly, c is the one that got rebased,
    // not a (which was already rebased previously or left alone).
    const cLog = await runGit(repo.dir, "log", "--format=%s", "c");
    expect(cLog).toContain("c edits shared");
    expect(cLog).toContain("main edits shared");
  });

  test("[fix2] missing origin/base fails preflight without persisting resume-state", async () => {
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    // Advance main so `a` is planned, but do NOT set up an origin remote so
    // `origin/main` cannot resolve at runtime.
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");

    let threw = false;
    let message = "";
    try {
      await executeRestack(repo.dir, "test", {});
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("origin");

    // resume-state must not have been persisted.
    let stateExists = false;
    try {
      await runGit(repo.dir, "config", "stack.test.resume-state");
      stateExists = true;
    } catch {
      // not set, good
    }
    expect(stateExists).toBe(false);
  });

  test("[fix3] force-push between sessions is detected by the resume guard", async () => {
    // Trigger a conflict on `c`, then before resuming, force-push `rightClean`
    // so its tip no longer matches the snapshot. Resume should refuse to
    // touch rightClean.
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

    const first = await executeRestack(repo.dir, "test", {});
    expect(first.ok).toBe(false);
    expect(first.error).toBe("conflict");

    // Now force-push rightClean by rewriting it. The rebase is still mid-
    // conflict on leftConflict, so we can't switch branches; instead, use
    // update-ref to move rightClean to a new commit created via a detached
    // HEAD path.
    const rightCleanSha = await runGit(repo.dir, "rev-parse", "rightClean");
    // Create a new commit object by reset + commit on a temporary branch.
    // We need to stay on the current rebase, so use update-ref directly.
    const newSha = await runGit(
      repo.dir,
      "commit-tree",
      `${rightCleanSha}^{tree}`,
      "-p",
      `${rightCleanSha}`,
      "-m",
      "force-pushed rightClean",
    );
    await runGit(repo.dir, "update-ref", "refs/heads/rightClean", newSha);

    // Resolve the leftConflict conflict.
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "left version\n");
    await runGit(repo.dir, "add", "shared.txt");

    const second = await executeRestack(repo.dir, "test", { resume: true });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("other");

    // rightClean must show up in the rebases with a force-push error in stderr.
    const rightEntry = second.rebases.find((r) => r.branch === "rightClean");
    expect(rightEntry).toBeDefined();
    expect(rightEntry!.stderr?.toLowerCase() ?? "").toContain("force-push");

    // Resume-state must be cleared so the user can start a fresh walk.
    let stateExists = false;
    try {
      await runGit(repo.dir, "config", "stack.test.resume-state");
      stateExists = true;
    } catch {
      // cleared
    }
    expect(stateExists).toBe(false);
  });

  test("[fix4] resume after manual git rebase --abort clears state and throws", async () => {
    // Trigger a conflict to get resume-state + an in-progress rebase.
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "shared.txt", "initial\n");
    await addBranch(repo.dir, "root", "main");

    await runGit(repo.dir, "checkout", "-b", "leftConflict", "root");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "left version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "left edits shared");

    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "root", "test", "main");
    await setStackNode(repo.dir, "leftConflict", "test", "root");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "main version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "main edits shared");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const first = await executeRestack(repo.dir, "test", {});
    expect(first.ok).toBe(false);
    expect(first.error).toBe("conflict");

    // User manually aborts the rebase.
    await runGit(repo.dir, "rebase", "--abort");

    let threw = false;
    let message = "";
    try {
      await executeRestack(repo.dir, "test", { resume: true });
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("No rebase in progress");

    // resume-state must be cleared.
    let stateExists = false;
    try {
      await runGit(repo.dir, "config", "stack.test.resume-state");
      stateExists = true;
    } catch {
      // cleared
    }
    expect(stateExists).toBe(false);
  });

  test("[fix5] dirty worktree blocks executeRestack with a clear error", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    // Check out `a` so the primary worktree is on an in-scope branch, then
    // dirty it.
    await runGit(repo.dir, "checkout", "a");
    await Deno.writeTextFile(`${repo.dir}/dirty.txt`, "uncommitted\n");

    let threw = false;
    let message = "";
    try {
      await executeRestack(repo.dir, "test", {});
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("uncommitted changes");
    expect(message).toContain("dirty.txt");

    // Clean up dirty file before afterEach cleanup.
    await Deno.remove(`${repo.dir}/dirty.txt`);
  });

  test("[fix5] skipWorktreeCheck bypasses the dirty worktree guard", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "main-extra.txt", "extra\n");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    // Check out a branch we won't touch so the dirty file doesn't collide
    // with the rebase. Then dirty main (out of scope anyway).
    await runGit(repo.dir, "checkout", "a");
    // Write an untracked file that doesn't conflict with rebase content.
    await Deno.writeTextFile(`${repo.dir}/untracked.txt`, "untracked\n");

    const result = await executeRestack(repo.dir, "test", {
      skipWorktreeCheck: true,
    });
    expect(result.ok).toBe(true);

    await Deno.remove(`${repo.dir}/untracked.txt`).catch(() => {});
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

describe("executeRestack (deleted branches)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await runGit(repo.dir, "rebase", "--abort").catch(() => {});
    await repo.cleanup();
  });

  test("planRestack throws when a stack-config branch is deleted", async () => {
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    // Delete `b`'s ref directly so its stack config survives
    // (`git branch -D` would auto-remove the branch.<name>.* config).
    await runGit(repo.dir, "checkout", "main");
    await runGit(repo.dir, "update-ref", "-d", "refs/heads/b");

    let caught: Error | undefined;
    try {
      await planRestack(repo.dir, "test", {});
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain("no longer exist");
    expect(caught!.message).toContain("b");
    expect(caught!.message).toContain("git config --unset branch.b.stack-name");
  });

  test("resume detects a deleted branch and clears state", async () => {
    // Build a stack and trigger a conflict so we have resume-state.
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "shared.txt", "initial\n");
    await addBranch(repo.dir, "root", "main");

    await runGit(repo.dir, "checkout", "-b", "leftConflict", "root");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "left\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "left edits");

    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "root", "test", "main");
    await setStackNode(repo.dir, "leftConflict", "test", "root");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "main\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "main edits");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const first = await executeRestack(repo.dir, "test", {});
    expect(first.ok).toBe(false);

    // Confirm resume-state exists.
    const beforeState = await runGit(
      repo.dir,
      "config",
      "stack.test.resume-state",
    ).catch(() => null);
    expect(beforeState).not.toBeNull();

    // User aborts the rebase and deletes the conflicted branch.
    await runGit(repo.dir, "rebase", "--abort");
    await runGit(repo.dir, "checkout", "main");
    await runGit(repo.dir, "branch", "-D", "leftConflict");

    // Resume should detect the missing branch and clear state.
    let caught: Error | undefined;
    try {
      await executeRestack(repo.dir, "test", { resume: true });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain("no longer exist");
    expect(caught!.message).toContain("leftConflict");

    // Resume-state must be cleared.
    let stateExists = false;
    try {
      await runGit(repo.dir, "config", "stack.test.resume-state");
      stateExists = true;
    } catch {
      // good, config not set
    }
    expect(stateExists).toBe(false);
  });
});
