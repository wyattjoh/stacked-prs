import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  commitFile,
  createTestRepo,
  makeMockDir,
  makeTempDir,
} from "../lib/testdata/helpers.ts";
import { runGitCommand, setBaseBranch, setStackNode } from "../lib/stack.ts";
import { writeFixture } from "../lib/gh.ts";
import {
  computeSyncPlan,
  executeSync,
  renderSyncPlan,
  type SyncPlan,
} from "./sync.ts";

async function setupStack(
  dir: string,
  stack: string,
  branches: Array<[string, string]>,
): Promise<void> {
  await setBaseBranch(dir, stack, "main");
  for (const [b, parent] of branches) {
    await setStackNode(dir, b, stack, parent);
  }
}

/** Hook up a bare remote and publish `main` to `origin/main`. */
async function wireOrigin(
  repoDir: string,
): Promise<AsyncDisposable & { path: string }> {
  const bare = await makeTempDir("bare-");
  await runGitCommand(repoDir, "init", "--bare", "-q", bare.path);
  await runGitCommand(repoDir, "remote", "add", "origin", bare.path);
  await runGitCommand(repoDir, "push", "origin", "main");
  return bare;
}

/**
 * Write a PR-list fixture for a branch. Uses the same fixture key scheme
 * that gh.fixtureKey produces from a `gh pr list --head <branch>` call.
 */
async function writePrListFixture(
  mockDir: string,
  branch: string,
  prs: Array<{
    number: number;
    state: string;
    url?: string;
    isDraft?: boolean;
    createdAt?: string;
  }>,
): Promise<void> {
  const filled = prs.map((p, i) => ({
    number: p.number,
    url: p.url ?? `https://github.com/o/r/pull/${p.number}`,
    state: p.state,
    isDraft: p.isDraft ?? false,
    createdAt: p.createdAt ?? new Date(2025, 0, 1 + i).toISOString(),
  }));
  await writeFixture(
    mockDir,
    ["pr", "list", "--head", branch, "--repo", "o/r"],
    filled,
  );
}

/** Write the repo-view fixture so resolveRepo() succeeds inside the planner. */
async function writeRepoViewFixture(mockDir: string): Promise<void> {
  await writeFixture(mockDir, ["repo", "view"], {
    owner: { login: "o" },
    name: "r",
  });
}

describe("computeSyncPlan", () => {
  test("collects all stacks and their base branches", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "a/1", "main");
    await addBranch(repo.dir, "b/1", "main");
    await setupStack(repo.dir, "stack-a", [["a/1", "main"]]);
    await setupStack(repo.dir, "stack-b", [["b/1", "main"]]);

    await using _bare = await wireOrigin(repo.dir);

    const plan = await computeSyncPlan(repo.dir);
    expect(plan.baseBranches).toEqual(["main"]);
    expect(plan.stacks.map((s) => s.stackName).sort()).toEqual([
      "stack-a",
      "stack-b",
    ]);
    expect(plan.isNoOp).toBe(true);
  });

  test("marks stacks behind their base as needing a push", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "feat/a", "main");
    await setupStack(repo.dir, "s", [["feat/a", "main"]]);

    await using _bare = await wireOrigin(repo.dir);

    // Advance origin/main past the stack by committing on main and pushing.
    await runGitCommand(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "drift.txt", "drift");
    await runGitCommand(repo.dir, "push", "origin", "main");
    await runGitCommand(repo.dir, "checkout", "feat/a");

    const plan = await computeSyncPlan(repo.dir);
    const s = plan.stacks.find((s) => s.stackName === "s")!;
    expect(s.branchesToPush).toEqual(["feat/a"]);
    expect(plan.isNoOp).toBe(false);
  });

  test("prunes a middle merged branch and reparents its child", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/b");
    await setupStack(repo.dir, "s", [
      ["feat/a", "main"],
      ["feat/b", "feat/a"],
      ["feat/c", "feat/b"],
    ]);
    await using _bare = await wireOrigin(repo.dir);

    await writePrListFixture(mock.path, "feat/a", [{
      number: 1,
      state: "OPEN",
    }]);
    await writePrListFixture(mock.path, "feat/b", [{
      number: 2,
      state: "MERGED",
    }]);
    await writePrListFixture(mock.path, "feat/c", [{
      number: 3,
      state: "OPEN",
    }]);

    const plan = await computeSyncPlan(repo.dir);
    const s = plan.stacks.find((s) => s.stackName === "s")!;

    expect(s.pruneSteps).toHaveLength(1);
    expect(s.pruneSteps[0].branch).toBe("feat/b");
    expect(s.pruneSteps[0].prNumber).toBe(2);
    expect(s.pruneSteps[0].childReparents).toEqual([
      { branch: "feat/c", oldParent: "feat/b", newParent: "feat/a" },
    ]);

    expect(s.prBaseUpdates).toHaveLength(1);
    expect(s.prBaseUpdates[0]).toMatchObject({
      branch: "feat/c",
      prNumber: 3,
      oldBase: "feat/b",
      newBase: "feat/a",
    });
  });

  test("walks up through merged ancestors when reparenting", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/b");
    await setupStack(repo.dir, "s", [
      ["feat/a", "main"],
      ["feat/b", "feat/a"],
      ["feat/c", "feat/b"],
    ]);
    await using _bare = await wireOrigin(repo.dir);

    await writePrListFixture(mock.path, "feat/a", [{
      number: 1,
      state: "MERGED",
    }]);
    await writePrListFixture(mock.path, "feat/b", [{
      number: 2,
      state: "MERGED",
    }]);
    await writePrListFixture(mock.path, "feat/c", [{
      number: 3,
      state: "OPEN",
    }]);

    const plan = await computeSyncPlan(repo.dir);
    const s = plan.stacks.find((s) => s.stackName === "s")!;

    expect(s.pruneSteps.map((p) => p.branch)).toEqual(["feat/a", "feat/b"]);
    expect(s.prBaseUpdates).toHaveLength(1);
    expect(s.prBaseUpdates[0]).toMatchObject({
      branch: "feat/c",
      oldBase: "feat/b",
      newBase: "main",
    });
  });

  test("no merged PRs: no prune steps or prBaseUpdates", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "feat/a", "main");
    await setupStack(repo.dir, "s", [["feat/a", "main"]]);
    await using _bare = await wireOrigin(repo.dir);

    await writePrListFixture(mock.path, "feat/a", [{
      number: 1,
      state: "OPEN",
    }]);

    const plan = await computeSyncPlan(repo.dir);
    const s = plan.stacks.find((s) => s.stackName === "s")!;
    expect(s.pruneSteps).toEqual([]);
    expect(s.prBaseUpdates).toEqual([]);
  });

  test("baseFastForwards: marks local main as ff when origin is ahead", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "feat/a", "main");
    await setupStack(repo.dir, "s", [["feat/a", "main"]]);
    await using _bare = await wireOrigin(repo.dir);

    // Advance origin/main beyond local main by committing on main, pushing,
    // then resetting local main back one commit (so origin is ahead).
    await runGitCommand(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "remote-ahead.txt", "remote ahead");
    await runGitCommand(repo.dir, "push", "origin", "main");
    await runGitCommand(repo.dir, "reset", "--hard", "HEAD~1");

    const plan = await computeSyncPlan(repo.dir);
    const ff = plan.baseFastForwards.find((f) => f.branch === "main")!;
    expect(ff.status).toBe("ff");
  });

  test("renderSyncPlan shows prune, reparent, and ff sections", () => {
    const plan: SyncPlan = {
      baseFastForwards: [
        { branch: "main", status: "ff", localSha: "aaa", originSha: "bbb" },
      ],
      baseBranches: ["main"],
      isNoOp: false,
      stacks: [
        {
          stackName: "s",
          baseBranch: "main",
          pruneSteps: [
            {
              branch: "feat/b",
              prNumber: 2,
              isCurrentBranch: false,
              childReparents: [
                {
                  branch: "feat/c",
                  oldParent: "feat/b",
                  newParent: "feat/a",
                },
              ],
            },
          ],
          prBaseUpdates: [
            {
              branch: "feat/c",
              prNumber: 3,
              oldBase: "feat/b",
              newBase: "feat/a",
              wasDraft: false,
              flipToReady: false,
            },
          ],
          navUpdates: [],
          rebases: [
            {
              branch: "feat/c",
              oldParentSha: "zzz",
              newTarget: "feat/a",
              status: "planned",
            },
          ],
          branchesToPush: ["feat/c"],
          excludeBranches: [],
          reparented: {},
          isNoOp: false,
        },
      ],
    };

    const out = renderSyncPlan(plan);
    expect(out).toContain("Base branches:");
    expect(out).toContain("→ main (fast-forward from origin)");
    expect(out).toContain("Delete feat/b (PR #2, merged)");
    expect(out).toContain("feat/c: feat/b → feat/a");
    expect(out).toContain("Retarget PR #3: feat/b → feat/a");
    expect(out).toContain("Push (--force-with-lease): feat/c");
  });

  test("renderSyncPlan reports no-op", () => {
    expect(
      renderSyncPlan({
        baseFastForwards: [],
        stacks: [],
        baseBranches: [],
        isNoOp: true,
      }),
    ).toContain("All stacks are already synced");
  });
});

describe("executeSync", () => {
  test("prunes merged middle branch, reparents child, pushes", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);

    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/b");
    await setupStack(repo.dir, "s", [
      ["feat/a", "main"],
      ["feat/b", "feat/a"],
      ["feat/c", "feat/b"],
    ]);
    await using _bare = await wireOrigin(repo.dir);
    // Publish the feature branches so force-pushes have something to update.
    await runGitCommand(
      repo.dir,
      "push",
      "origin",
      "feat/a",
      "feat/b",
      "feat/c",
    );

    await writePrListFixture(mock.path, "feat/a", [{
      number: 1,
      state: "OPEN",
    }]);
    await writePrListFixture(mock.path, "feat/b", [{
      number: 2,
      state: "MERGED",
    }]);
    await writePrListFixture(mock.path, "feat/c", [{
      number: 3,
      state: "OPEN",
    }]);

    // Stay off feat/b so the prune doesn't need a base-checkout.
    await runGitCommand(repo.dir, "checkout", "feat/a");

    const plan = await computeSyncPlan(repo.dir);
    const result = await executeSync(repo.dir, plan);

    expect(result.ok).toBe(true);
    const stack = result.stacks.find((s) => s.stackName === "s")!;
    expect(stack.ok).toBe(true);
    expect(stack.prunedBranches).toContain("feat/b");

    // Local feat/b is deleted.
    const { code: verifyCode } = await runGitCommand(
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      "feat/b",
    );
    expect(verifyCode).not.toBe(0);

    // feat/c's recorded parent is now feat/a.
    const { stdout: parentOut } = await runGitCommand(
      repo.dir,
      "config",
      "branch.feat/c.stack-parent",
    );
    expect(parentOut.trim()).toBe("feat/a");
  });

  test("fetch failure short-circuits before running any stack work", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    // No origin remote configured: fetch will fail.

    const plan: SyncPlan = {
      baseBranches: ["main"],
      baseFastForwards: [],
      stacks: [
        {
          stackName: "s",
          baseBranch: "main",
          pruneSteps: [],
          prBaseUpdates: [],
          navUpdates: [],
          rebases: [],
          branchesToPush: [],
          excludeBranches: [],
          reparented: {},
          isNoOp: false,
        },
      ],
      isNoOp: false,
    };

    const result = await executeSync(repo.dir, plan);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe("fetch origin main");
    expect(result.stacks).toEqual([]);
  });

  test("divergent local base: no fast-forward, rebases still target origin", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "feat/a", "main");
    await setupStack(repo.dir, "s", [["feat/a", "main"]]);
    await using _bare = await wireOrigin(repo.dir);
    await runGitCommand(repo.dir, "push", "origin", "feat/a");

    // Advance origin/main beyond the common ancestor.
    await runGitCommand(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "remote-only.txt", "remote only");
    await runGitCommand(repo.dir, "push", "origin", "main");
    // Step local main sideways so origin and local share only the root.
    await runGitCommand(repo.dir, "reset", "--hard", "HEAD~1");
    await commitFile(repo.dir, "local-only.txt", "local only");
    // Get back off main so executeSync's ff path takes the update-ref branch.
    await runGitCommand(repo.dir, "checkout", "feat/a");

    const plan = await computeSyncPlan(repo.dir);
    expect(
      plan.baseFastForwards.find((f) => f.branch === "main")?.status,
    ).toBe("skip-diverged");

    const result = await executeSync(repo.dir, plan);
    expect(result.fastForwarded).not.toContain("main");
    // The rebase itself targets origin/main by default and should succeed.
    expect(result.ok).toBe(true);
  });

  test("current-branch protection: checks out base before deleting", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setupStack(repo.dir, "s", [
      ["feat/a", "main"],
      ["feat/b", "feat/a"],
    ]);
    await using _bare = await wireOrigin(repo.dir);
    await runGitCommand(repo.dir, "push", "origin", "feat/a", "feat/b");

    await writePrListFixture(mock.path, "feat/a", [{
      number: 1,
      state: "OPEN",
    }]);
    await writePrListFixture(mock.path, "feat/b", [{
      number: 2,
      state: "MERGED",
    }]);

    // User is checked out on the merged branch.
    await runGitCommand(repo.dir, "checkout", "feat/b");

    const plan = await computeSyncPlan(repo.dir);
    const result = await executeSync(repo.dir, plan);

    expect(result.ok).toBe(true);
    // feat/b is gone.
    const { code } = await runGitCommand(
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      "feat/b",
    );
    expect(code).not.toBe(0);
  });
});
