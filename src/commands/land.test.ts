import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LandCase } from "./land.ts";
import {
  captureSnapshot,
  classifyLandCase,
  executeLand,
  executeLandFromCli,
  isShallowRepository,
  LandError,
  type LandProgressEvent,
  planLand,
  previewLandCleanup,
  type PrInfo,
  type PrStateByBranch,
  runLandPreflight,
  UnsupportedLandShape,
} from "./land.ts";
import {
  addBranch,
  createTestRepo,
  runGit,
  type TestRepo,
} from "../lib/testdata/helpers.ts";
import {
  getStackTree,
  runGitCommand,
  setBaseBranch,
  setStackNode,
} from "../lib/stack.ts";
import { setMockDir, writeFixture } from "../lib/gh.ts";

async function initStack(
  repo: TestRepo,
  name: string,
  branches: Array<[string, string]>,
): Promise<void> {
  await setBaseBranch(repo.dir, name, "main");
  for (const [branch, parent] of branches) {
    await setStackNode(repo.dir, branch, name, parent);
  }
}

async function createRepoWithOrigin(): Promise<TestRepo & { origin: string }> {
  const origin = await Deno.makeTempDir({ prefix: "stacked-prs-origin-" });
  await runGit(origin, "init", "--bare", "--initial-branch=main");

  const work = await createTestRepo();
  await runGit(work.dir, "remote", "add", "origin", origin);
  await runGit(work.dir, "push", "origin", "main");

  return {
    dir: work.dir,
    origin,
    cleanup: async () => {
      await work.cleanup();
      await Deno.remove(origin, { recursive: true });
    },
  };
}

describe("land types", () => {
  it("LandCase supports the two expected shapes", () => {
    const a: LandCase = "root-merged";
    const b: LandCase = "all-merged";
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
  });
});

describe("isShallowRepository", () => {
  it("returns false for a fresh non-shallow repo", async () => {
    const repo = await createTestRepo();
    try {
      expect(await isShallowRepository(repo.dir)).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("runLandPreflight", () => {
  it("returns no blockers for a clean repo", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      const report = await runLandPreflight(repo.dir, ["feat/a"]);
      expect(report.blockers).toEqual([]);
      expect(report.isShallow).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("reports a dirty worktree as a blocker", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await runGit(repo.dir, "checkout", "feat/a");
      await Deno.writeTextFile(`${repo.dir}/dirty.txt`, "untracked\n");
      const report = await runLandPreflight(repo.dir, ["feat/a"]);
      expect(report.blockers.length).toBeGreaterThanOrEqual(1);
      expect(
        report.blockers.some((b) => b.kind === "dirty-worktree"),
      ).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("classifyLandCase", () => {
  it("returns all-merged when every branch is merged", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const tree = await getStackTree(repo.dir, "s");
      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "MERGED"],
      ]);
      expect(classifyLandCase(tree, prStates)).toBe("all-merged");
    } finally {
      await repo.cleanup();
    }
  });

  it("returns root-merged when only the root is merged", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const tree = await getStackTree(repo.dir, "s");
      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      expect(classifyLandCase(tree, prStates)).toBe("root-merged");
    } finally {
      await repo.cleanup();
    }
  });

  it("throws UnsupportedLandShape when only a leaf is merged", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const tree = await getStackTree(repo.dir, "s");
      const prStates: PrStateByBranch = new Map([
        ["feat/a", "OPEN"],
        ["feat/b", "MERGED"],
      ]);
      expect(() => classifyLandCase(tree, prStates)).toThrow(
        UnsupportedLandShape,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("throws for multi-root with only one merged root", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "main");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "main"]]);
      const tree = await getStackTree(repo.dir, "s");
      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      expect(() => classifyLandCase(tree, prStates)).toThrow(
        UnsupportedLandShape,
      );
    } finally {
      await repo.cleanup();
    }
  });
});

describe("captureSnapshot", () => {
  it("records tip and parent-tip for every branch", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const tree = await getStackTree(repo.dir, "s");
      const snap = await captureSnapshot(repo.dir, tree);
      expect(snap.length).toBe(2);
      const a = snap.find((s) => s.branch === "feat/a")!;
      expect(a.recordedParent).toBe("main");
      expect(a.tipSha.length).toBe(40);
      expect(a.parentTipSha.length).toBe(40);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("buildRebaseSteps", () => {
  it("for root-merged linear stack, first child targets origin/base", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await addBranch(repo.dir, "feat/c", "feat/b");
      await initStack(repo, "s", [
        ["feat/a", "main"],
        ["feat/b", "feat/a"],
        ["feat/c", "feat/b"],
      ]);
      const tree = await getStackTree(repo.dir, "s");
      const snap = await captureSnapshot(repo.dir, tree);
      const { buildRebaseSteps } = await import("./land.ts");
      const steps = buildRebaseSteps(tree, snap, "feat/a");
      expect(steps.length).toBe(2);
      expect(steps[0].branch).toBe("feat/b");
      expect(steps[0].newTarget).toBe("origin/main");
      expect(steps[1].branch).toBe("feat/c");
      expect(steps[1].newTarget).toBe("feat/b");
      const snapA = snap.find((s) => s.branch === "feat/a")!;
      const snapB = snap.find((s) => s.branch === "feat/b")!;
      expect(steps[0].oldParentSha).toBe(snapA.tipSha);
      expect(steps[1].oldParentSha).toBe(snapB.tipSha);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("buildPushSteps", () => {
  it("returns steps in leaves-first order", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await addBranch(repo.dir, "feat/c", "feat/b");
      await initStack(repo, "s", [
        ["feat/a", "main"],
        ["feat/b", "feat/a"],
        ["feat/c", "feat/b"],
      ]);
      const tree = await getStackTree(repo.dir, "s");
      const snap = await captureSnapshot(repo.dir, tree);
      const { buildPushSteps } = await import("./land.ts");
      const pushes = buildPushSteps(tree, snap, "feat/a");
      expect(pushes.map((p) => p.branch)).toEqual(["feat/c", "feat/b"]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("buildPrUpdateSteps", () => {
  it("retargets former children of merged root to base branch", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await addBranch(repo.dir, "feat/c", "feat/b");
      await initStack(repo, "s", [
        ["feat/a", "main"],
        ["feat/b", "feat/a"],
        ["feat/c", "feat/b"],
      ]);
      const tree = await getStackTree(repo.dir, "s");
      const { buildPrUpdateSteps } = await import("./land.ts");
      const prInfoByBranch = new Map([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
        ["feat/c", { number: 30, url: "", state: "OPEN", isDraft: true }],
      ]);
      const updates = buildPrUpdateSteps(tree, prInfoByBranch, "feat/a");
      expect(updates.length).toBe(1);
      expect(updates[0].branch).toBe("feat/b");
      expect(updates[0].prNumber).toBe(20);
      expect(updates[0].newBase).toBe("main");
      expect(updates[0].flipToReady).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("does not flip non-draft children to ready", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const tree = await getStackTree(repo.dir, "s");
      const { buildPrUpdateSteps } = await import("./land.ts");
      const prInfoByBranch = new Map([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: false }],
      ]);
      const updates = buildPrUpdateSteps(tree, prInfoByBranch, "feat/a");
      expect(updates[0].flipToReady).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("previewLandCleanup", () => {
  it("returns no splits when the merged root has a single child", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const tree = await getStackTree(repo.dir, "s");
      const preview = previewLandCleanup(tree, "feat/a");
      expect(preview.splits).toEqual([]);
      expect(preview.remainingRoots).toEqual(["feat/b"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("reports two splits when the merged root has two direct children", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await addBranch(repo.dir, "feat/c", "feat/a");
      await initStack(repo, "s", [
        ["feat/a", "main"],
        ["feat/b", "feat/a"],
        ["feat/c", "feat/a"],
      ]);
      const tree = await getStackTree(repo.dir, "s");
      const preview = previewLandCleanup(tree, "feat/a");
      expect(preview.splits.length).toBe(2);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("tombstone survives branch deletion", () => {
  it("landed branch appears in tree after git branch -D", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      // Simulate what executeLand case A does:
      // 1. configLandCleanup (writes tombstone, reparents children, removes merged branch config)
      const { configLandCleanup } = await import("./config.ts");
      await configLandCleanup(repo.dir, "s", "feat/a");

      // 2. Delete the branch (destroys any remaining branch.<name>.* config)
      await runGitCommand(repo.dir, "checkout", "main");
      await runGitCommand(repo.dir, "branch", "-D", "feat/a");

      // 3. Remove remaining branch config (mirrors removeStackBranch in executeLand)
      const { removeStackBranch } = await import("../lib/stack.ts");
      await removeStackBranch(repo.dir, "feat/a");

      // Tree should still contain feat/a as a merged root
      const tree = await getStackTree(repo.dir, "s");
      const nodeA = tree.roots.find((n) => n.branch === "feat/a");
      expect(nodeA).toBeDefined();
      expect(nodeA!.merged).toBe(true);
      expect(nodeA!.parent).toBe("main");
      expect(nodeA!.children).toEqual([]);

      // feat/b should be a live root reparented to main
      const nodeB = tree.roots.find((n) => n.branch === "feat/b");
      expect(nodeB).toBeDefined();
      expect(nodeB!.merged).toBeUndefined();
      expect(nodeB!.parent).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("executeLand case B (all-merged)", () => {
  it("deletes every branch and clears stack config", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "MERGED"],
      ]);
      const plan = await planLand(repo.dir, "s", prStates, new Map());

      const events: LandProgressEvent[] = [];
      const result = await executeLand(repo.dir, plan, {
        onProgress: (e) => events.push(e),
        freshPrStates: () => Promise.resolve(prStates),
      });

      // Both branches are gone.
      const aProbe = await runGitCommand(
        repo.dir,
        "rev-parse",
        "--verify",
        "refs/heads/feat/a",
      );
      expect(aProbe.code !== 0).toBe(true);
      const bProbe = await runGitCommand(
        repo.dir,
        "rev-parse",
        "--verify",
        "refs/heads/feat/b",
      );
      expect(bProbe.code !== 0).toBe(true);

      // Stack config is gone.
      const baseProbe = await runGitCommand(
        repo.dir,
        "config",
        "stack.s.base-branch",
      );
      expect(baseProbe.code !== 0).toBe(true);

      const landedProbe = await runGitCommand(
        repo.dir,
        "config",
        "--get-all",
        "stack.s.landed-branches",
      );
      expect(landedProbe.code !== 0).toBe(true);

      // Delete events fired leaves-first.
      const deletes = events
        .filter((e) => e.step.kind === "delete" && e.status === "ok")
        .map((e) => (e.step as { kind: "delete"; branch: string }).branch);
      expect(deletes).toEqual(["feat/b", "feat/a"]);

      expect(result.plan.case).toBe("all-merged");
      expect(result.split).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("executeLand case A tombstone integration", () => {
  it("preserves merged root as tombstone after executeLand", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await runGit(env.dir, "push", "origin", "feat/a");
      await addBranch(env.dir, "feat/b", "feat/a");
      await runGit(env.dir, "push", "origin", "feat/b");
      await initStack(env, "s", [
        ["feat/a", "main"],
        ["feat/b", "feat/a"],
      ]);

      // Merge feat/a into main on origin so land can detect it as merged.
      await runGit(env.dir, "checkout", "main");
      await runGit(env.dir, "merge", "feat/a", "--no-ff", "-m", "Merge feat/a");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
      ]);

      const mockDir = await Deno.makeTempDir();
      setMockDir(mockDir);
      await writeFixture(mockDir, ["repo", "view"], {
        owner: { login: "acme" },
        name: "widgets",
      });

      try {
        const plan = await planLand(env.dir, "s", prStates, prInfo);
        await executeLand(env.dir, plan, {
          onProgress: () => {},
          freshPrStates: () => Promise.resolve(prStates),
        });
      } finally {
        setMockDir(undefined);
      }

      // feat/a local branch must be gone.
      const probe = await runGitCommand(
        env.dir,
        "rev-parse",
        "--verify",
        "refs/heads/feat/a",
      );
      expect(probe.code !== 0).toBe(true);

      // getStackTree must reconstruct feat/a as a merged root tombstone.
      const tree = await getStackTree(env.dir, "s");
      const tombstone = tree.roots.find((n) =>
        n.branch === "feat/a" && n.merged === true
      );
      expect(tombstone).toBeDefined();
      expect(tombstone!.parent).toBe("main");
      expect(tombstone!.children).toEqual([]);

      // feat/b must be a live root reparented to main.
      const liveB = tree.roots.find((n) => n.branch === "feat/b" && !n.merged);
      expect(liveB).toBeDefined();
      expect(liveB!.parent).toBe("main");
    } finally {
      await env.cleanup();
      setMockDir(undefined);
    }
  });
});

describe("fetchBase", () => {
  it("throws a clear error when origin has no base branch", async () => {
    const repo = await createTestRepo();
    try {
      const { fetchBase } = await import("./land.ts");
      let caught: Error | null = null;
      try {
        await fetchBase(repo.dir, "main");
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message.includes("fetch")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("planLand", () => {
  it("builds a root-merged plan for a linear stack", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
      ]);
      const plan = await planLand(repo.dir, "s", prStates, prInfo);
      expect(plan.case).toBe("root-merged");
      expect(plan.mergedBranches).toEqual(["feat/a"]);
      expect(plan.rebaseSteps.length).toBe(1);
      expect(plan.rebaseSteps[0].branch).toBe("feat/b");
      expect(plan.rebaseSteps[0].newTarget).toBe("origin/main");
      expect(plan.pushSteps.length).toBe(1);
      expect(plan.prUpdates.length).toBe(1);
      expect(plan.prUpdates[0].newBase).toBe("main");
      expect(plan.branchesToDelete).toEqual(["feat/a"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("builds an all-merged plan with empty rebase/push/prUpdates", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "MERGED"],
      ]);
      const plan = await planLand(repo.dir, "s", prStates, new Map());
      expect(plan.case).toBe("all-merged");
      expect(plan.rebaseSteps).toEqual([]);
      expect(plan.pushSteps).toEqual([]);
      expect(plan.prUpdates).toEqual([]);
      expect([...plan.branchesToDelete].sort()).toEqual(["feat/a", "feat/b"]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("executeLand case A conflict rollback", () => {
  it("rebase conflict rolls back every touched branch to its pre-land SHA", async () => {
    const env = await createRepoWithOrigin();
    try {
      // Create a conflict: feat/a and main both modify README.md.
      await runGit(env.dir, "checkout", "-b", "feat/a", "main");
      await Deno.writeTextFile(
        `${env.dir}/README.md`,
        "# Conflicting change from A\n",
      );
      await runGit(env.dir, "add", "README.md");
      await runGit(env.dir, "commit", "-m", "modify readme on a");
      await runGit(env.dir, "push", "origin", "feat/a");

      await runGit(env.dir, "checkout", "-b", "feat/b", "feat/a");
      await Deno.writeTextFile(
        `${env.dir}/README.md`,
        "# Further change from B\n",
      );
      await runGit(env.dir, "add", "README.md");
      await runGit(env.dir, "commit", "-m", "modify readme on b");
      await runGit(env.dir, "push", "origin", "feat/b");

      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      // Diverge main with a conflicting README change.
      await runGit(env.dir, "checkout", "main");
      await Deno.writeTextFile(
        `${env.dir}/README.md`,
        "# Main's conflicting change\n",
      );
      await runGit(env.dir, "add", "README.md");
      await runGit(env.dir, "commit", "-m", "modify readme on main");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const preLandTipB =
        (await runGitCommand(env.dir, "rev-parse", "feat/b")).stdout;

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
      ]);

      const plan = await planLand(env.dir, "s", prStates, prInfo);

      let caught: LandError | null = null;
      try {
        await executeLand(env.dir, plan, {
          onProgress: () => {},
          freshPrStates: () => Promise.resolve(prStates),
        });
      } catch (err) {
        if (err instanceof LandError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught!.name).toBe("LandError");
      expect(caught!.failedAt.kind).toBe("rebase");

      // Branch tip is restored.
      const postTipB =
        (await runGitCommand(env.dir, "rev-parse", "feat/b")).stdout;
      expect(postTipB).toBe(preLandTipB);

      // No rebase in progress.
      const rebaseHead = await runGitCommand(
        env.dir,
        "rev-parse",
        "--verify",
        "--quiet",
        "REBASE_HEAD",
      );
      expect(rebaseHead.code).not.toBe(0);
    } finally {
      await env.cleanup();
    }
  });
});

describe("executeLand case A push phase", () => {
  it("force-with-leases leaves-first", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await runGit(env.dir, "push", "origin", "feat/a");
      await addBranch(env.dir, "feat/b", "feat/a");
      await runGit(env.dir, "push", "origin", "feat/b");
      await addBranch(env.dir, "feat/c", "feat/b");
      await runGit(env.dir, "push", "origin", "feat/c");
      await initStack(env, "s", [
        ["feat/a", "main"],
        ["feat/b", "feat/a"],
        ["feat/c", "feat/b"],
      ]);

      // Merge feat/a into main on origin.
      await runGit(env.dir, "checkout", "main");
      await runGit(env.dir, "merge", "feat/a", "--no-ff", "-m", "Merge feat/a");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
        ["feat/c", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
        ["feat/c", { number: 30, url: "", state: "OPEN", isDraft: true }],
      ]);

      const mockDir = await Deno.makeTempDir();
      setMockDir(mockDir);

      const events: LandProgressEvent[] = [];
      try {
        await executeLand(
          env.dir,
          await planLand(env.dir, "s", prStates, prInfo),
          {
            onProgress: (e) => events.push(e),
            freshPrStates: () => Promise.resolve(prStates),
          },
        );
      } catch {
        // later phases still unimplemented
      } finally {
        setMockDir(undefined);
      }

      const pushOks = events
        .filter((e) => e.step.kind === "push" && e.status === "ok")
        .map((e) => (e.step as { kind: "push"; branch: string }).branch);
      expect(pushOks).toEqual(["feat/c", "feat/b"]);
    } finally {
      await env.cleanup();
      setMockDir(undefined);
    }
  });
});

describe("executeLand case A pr-update phase", () => {
  it("retargets PR base and flips draft to ready", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await runGit(env.dir, "push", "origin", "feat/a");
      await addBranch(env.dir, "feat/b", "feat/a");
      await runGit(env.dir, "push", "origin", "feat/b");
      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      await runGit(env.dir, "checkout", "main");
      await runGit(env.dir, "merge", "feat/a", "--no-ff", "-m", "Merge feat/a");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
      ]);

      const mockDir = await Deno.makeTempDir();
      setMockDir(mockDir);

      const events: LandProgressEvent[] = [];
      try {
        await executeLand(
          env.dir,
          await planLand(env.dir, "s", prStates, prInfo),
          {
            onProgress: (e) => events.push(e),
            freshPrStates: () => Promise.resolve(prStates),
          },
        );
      } catch {
        // later phases may still error
      } finally {
        setMockDir(undefined);
      }

      const prUpdate = events.find(
        (e) => e.step.kind === "pr-update" && e.status === "ok",
      );
      expect(prUpdate).toBeDefined();
    } finally {
      await env.cleanup();
      setMockDir(undefined);
    }
  });
});

describe("executeLand case A rebase phase", () => {
  it("rebases child onto origin/main for merge-strategy root-merged", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await runGit(env.dir, "push", "origin", "feat/a");
      await addBranch(env.dir, "feat/b", "feat/a");
      await runGit(env.dir, "push", "origin", "feat/b");
      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      // Simulate the merge of feat/a into main on origin.
      await runGit(env.dir, "checkout", "main");
      await runGit(env.dir, "merge", "feat/a", "--no-ff", "-m", "Merge feat/a");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
      ]);

      const mockDir = await Deno.makeTempDir();
      setMockDir(mockDir);

      const events: LandProgressEvent[] = [];
      try {
        // Later phases (push, pr-update, nav, delete) are not yet
        // implemented and will throw. We only verify the rebase phase here.
        await executeLand(
          env.dir,
          await planLand(env.dir, "s", prStates, prInfo),
          {
            onProgress: (e) => events.push(e),
            freshPrStates: () => Promise.resolve(prStates),
          },
        );
      } catch {
        // expected: later phases not yet implemented
      } finally {
        setMockDir(undefined);
      }

      const rebaseOk = events.find(
        (e) =>
          e.step.kind === "rebase" &&
          (e.step as { kind: "rebase"; branch: string }).branch === "feat/b" &&
          e.status === "ok",
      );
      expect(rebaseOk).toBeDefined();

      // feat/b is now rooted on origin/main.
      const branchShaResult = await runGitCommand(
        env.dir,
        "rev-parse",
        "feat/b",
      );
      const originMainShaResult = await runGitCommand(
        env.dir,
        "rev-parse",
        "origin/main",
      );
      const isAncestorResult = await runGitCommand(
        env.dir,
        "merge-base",
        "--is-ancestor",
        originMainShaResult.stdout,
        branchShaResult.stdout,
      );
      expect(isAncestorResult.code).toBe(0);
    } finally {
      await env.cleanup();
      setMockDir(undefined);
    }
  });
});

describe("executeLand case A pr-close phase", () => {
  it("closes PRs for auto-merged branches with a comment", async () => {
    const env = await createRepoWithOrigin();
    try {
      // Build: main - A - B where B has no unique commits vs A (so rebase
      // drops all of B's commits and marks it auto-merged).
      await runGit(env.dir, "checkout", "-b", "feat/a", "main");
      await Deno.writeTextFile(`${env.dir}/shared.txt`, "shared content\n");
      await runGit(env.dir, "add", "shared.txt");
      await runGit(env.dir, "commit", "-m", "add shared");
      await runGit(env.dir, "push", "origin", "feat/a");
      await runGit(env.dir, "checkout", "-b", "feat/b", "feat/a");
      await runGit(env.dir, "push", "origin", "feat/b");
      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      // Squash-merge feat/a into main via a fresh cherry-pick commit.
      await runGit(env.dir, "checkout", "main");
      await Deno.writeTextFile(`${env.dir}/shared.txt`, "shared content\n");
      await runGit(env.dir, "add", "shared.txt");
      await runGit(env.dir, "commit", "-m", "squashed feat/a");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
      ]);

      const mockDir = await Deno.makeTempDir();
      setMockDir(mockDir);

      const events: LandProgressEvent[] = [];
      try {
        await executeLand(
          env.dir,
          await planLand(env.dir, "s", prStates, prInfo),
          {
            onProgress: (e) => events.push(e),
            freshPrStates: () => Promise.resolve(prStates),
          },
        );
      } catch {
        // later phases still unimplemented
      } finally {
        setMockDir(undefined);
      }

      const closeEvent = events.find(
        (e) => e.step.kind === "pr-close" && e.status === "ok",
      );
      expect(closeEvent).toBeDefined();
    } finally {
      await env.cleanup();
      setMockDir(undefined);
    }
  });
});

describe("executeLand case A cleanup phase", () => {
  it("reparents children, deletes merged root, and restores HEAD", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await runGit(env.dir, "push", "origin", "feat/a");
      await addBranch(env.dir, "feat/b", "feat/a");
      await runGit(env.dir, "push", "origin", "feat/b");
      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      await runGit(env.dir, "checkout", "main");
      await runGit(env.dir, "merge", "feat/a", "--no-ff", "-m", "Merge feat/a");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
      ]);

      const mockDir = await Deno.makeTempDir();
      setMockDir(mockDir);

      try {
        await executeLand(
          env.dir,
          await planLand(env.dir, "s", prStates, prInfo),
          {
            onProgress: () => {},
            freshPrStates: () => Promise.resolve(prStates),
          },
        );
      } finally {
        setMockDir(undefined);
      }

      // feat/a is deleted locally
      const aExists = await runGitCommand(
        env.dir,
        "rev-parse",
        "--verify",
        "refs/heads/feat/a",
      );
      expect(aExists.code).not.toBe(0);

      // feat/b's parent in config is now main
      const parent = await runGitCommand(
        env.dir,
        "config",
        "branch.feat/b.stack-parent",
      );
      expect(parent.stdout).toBe("main");
    } finally {
      await env.cleanup();
      setMockDir(undefined);
    }
  });
});

describe("executeLand case A nav phase", () => {
  it("emits a nav event after PR retarget", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await runGit(env.dir, "push", "origin", "feat/a");
      await addBranch(env.dir, "feat/b", "feat/a");
      await runGit(env.dir, "push", "origin", "feat/b");
      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      await runGit(env.dir, "checkout", "main");
      await runGit(env.dir, "merge", "feat/a", "--no-ff", "-m", "Merge feat/a");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const prInfo = new Map<string, PrInfo>([
        ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
      ]);

      const mockDir = await Deno.makeTempDir();
      setMockDir(mockDir);
      // buildNavPlan resolves owner/name via `gh repo view`; stub it.
      await writeFixture(mockDir, ["repo", "view"], {
        owner: { login: "acme" },
        name: "widgets",
      });

      const events: LandProgressEvent[] = [];
      try {
        await executeLand(
          env.dir,
          await planLand(env.dir, "s", prStates, prInfo),
          {
            onProgress: (e) => events.push(e),
            freshPrStates: () => Promise.resolve(prStates),
          },
        );
      } finally {
        setMockDir(undefined);
      }

      const navEvent = events.findLast(
        (e) => e.step.kind === "nav" && e.status !== "running",
      );
      expect(navEvent).toBeDefined();
      expect(navEvent!.status === "ok" || navEvent!.status === "skipped").toBe(
        true,
      );
    } finally {
      await env.cleanup();
      setMockDir(undefined);
    }
  });
});

describe("executeLand HEAD safety", () => {
  it("deletes branches even when HEAD starts on a branch being deleted", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await addBranch(env.dir, "feat/b", "feat/a");
      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      // Start on feat/a, which will be deleted by the all-merged land.
      await runGit(env.dir, "checkout", "feat/a");

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "MERGED"],
      ]);
      const plan = await planLand(env.dir, "s", prStates, new Map());
      expect(plan.case).toBe("all-merged");

      const events: LandProgressEvent[] = [];
      await executeLand(env.dir, plan, {
        onProgress: (e) => events.push(e),
        freshPrStates: () => Promise.resolve(prStates),
      });

      // Both branches must be gone.
      const aExists = await runGitCommand(
        env.dir,
        "rev-parse",
        "--verify",
        "refs/heads/feat/a",
      );
      expect(aExists.code).not.toBe(0);
      const bExists = await runGitCommand(
        env.dir,
        "rev-parse",
        "--verify",
        "refs/heads/feat/b",
      );
      expect(bExists.code).not.toBe(0);

      // No deletion events should be "failed".
      const deleteEvents = events.filter((e) => e.step.kind === "delete");
      expect(deleteEvents.length).toBeGreaterThan(0);
      expect(deleteEvents.every((e) => e.status !== "failed")).toBe(true);

      // HEAD should not be detached; it should be on the base branch.
      const headRef = await runGitCommand(
        env.dir,
        "symbolic-ref",
        "--short",
        "HEAD",
      );
      expect(headRef.code).toBe(0);
      expect(headRef.stdout.trim()).toBe("main");
    } finally {
      await env.cleanup();
    }
  });
});

describe("executeLand idempotent deletion", () => {
  it("emits skipped when a branch is already absent", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await addBranch(env.dir, "feat/b", "feat/a");
      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "MERGED"],
      ]);
      const plan = await planLand(env.dir, "s", prStates, new Map());

      // Pre-delete feat/b before executing the land plan.
      await runGit(env.dir, "checkout", "main");
      await runGit(env.dir, "branch", "-D", "feat/b");

      const events: LandProgressEvent[] = [];
      await executeLand(env.dir, plan, {
        onProgress: (e) => events.push(e),
        freshPrStates: () => Promise.resolve(prStates),
      });

      const bDeleteEvent = events.findLast(
        (e) =>
          e.step.kind === "delete" &&
          "branch" in e.step &&
          e.step.branch === "feat/b",
      );
      expect(bDeleteEvent).toBeDefined();
      expect(bDeleteEvent!.status).toBe("skipped");
    } finally {
      await env.cleanup();
    }
  });
});

describe("executeLand stale-plan detection", () => {
  it("aborts before mutation when a merged PR has been reopened", async () => {
    const env = await createRepoWithOrigin();
    try {
      await addBranch(env.dir, "feat/a", "main");
      await runGit(env.dir, "push", "origin", "feat/a");
      await addBranch(env.dir, "feat/b", "feat/a");
      await runGit(env.dir, "push", "origin", "feat/b");
      await initStack(env, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);
      await runGit(env.dir, "checkout", "main");
      await runGit(env.dir, "merge", "feat/a", "--no-ff", "-m", "Merge feat/a");
      await runGit(env.dir, "push", "origin", "main");
      await runGit(env.dir, "fetch", "origin", "main");

      const planPrStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const plan = await planLand(
        env.dir,
        "s",
        planPrStates,
        new Map([
          ["feat/b", { number: 20, url: "", state: "OPEN", isDraft: true }],
        ]),
      );

      // Between planning and execution, feat/a is reopened.
      const freshStates: PrStateByBranch = new Map([
        ["feat/a", "OPEN"],
        ["feat/b", "OPEN"],
      ]);

      const mockDir = await Deno.makeTempDir();
      setMockDir(mockDir);
      let caught: LandError | null = null;
      try {
        await executeLand(env.dir, plan, {
          onProgress: () => {},
          freshPrStates: () => Promise.resolve(freshStates),
        });
      } catch (err) {
        caught = err as LandError;
      } finally {
        setMockDir(undefined);
      }

      expect(caught).not.toBeNull();
      expect(caught!.failedAt.kind).toBe("preflight");
      expect(caught!.message.includes("stale")).toBe(true);

      // feat/a still exists locally, untouched.
      const aExists = await runGitCommand(
        env.dir,
        "rev-parse",
        "--verify",
        "refs/heads/feat/a",
      );
      expect(aExists.code).toBe(0);
    } finally {
      await env.cleanup();
      setMockDir(undefined);
    }
  });
});

describe("classifyLandCase with historical merged nodes", () => {
  it("ignores stack-merged nodes when computing all-merged", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");
      // Mark feature/a as historically merged
      await runGitCommand(
        repo.dir,
        "config",
        "branch.feature/a.stack-merged",
        "true",
      );

      const tree = await getStackTree(repo.dir, "my-stack");
      const prStates: PrStateByBranch = new Map([
        ["feature/a", "MERGED"],
        ["feature/b", "MERGED"],
      ]);

      // Should be "all-merged" — feature/a historical node should not block this
      const landCase = classifyLandCase(tree, prStates);
      expect(landCase).toBe("all-merged");
    } finally {
      await repo.cleanup();
    }
  });

  it("ignores stack-merged nodes when checking root for root-merged", async () => {
    const repo = await createTestRepo();
    try {
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

      const tree = await getStackTree(repo.dir, "my-stack");
      const prStates: PrStateByBranch = new Map([
        ["feature/a", "MERGED"],
        ["feature/b", "OPEN"],
      ]);

      // feature/b is the only live root; its PR is open — nothing to land
      expect(() => classifyLandCase(tree, prStates)).toThrow(
        UnsupportedLandShape,
      );
    } finally {
      await repo.cleanup();
    }
  });
});

describe("executeLandFromCli resume guard", () => {
  it("throws when --resume is passed but no land-resume-state exists", async () => {
    const repo = await createRepoWithOrigin();
    try {
      await addBranch(repo.dir, "feature/a", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");

      await expect(
        executeLandFromCli(repo.dir, "my-stack", new Map(), new Map(), {
          resume: true,
        }),
      ).rejects.toThrow("No land in progress");
    } finally {
      await repo.cleanup();
    }
  });

  it("throws when no --resume but land-resume-state already exists", async () => {
    const repo = await createRepoWithOrigin();
    try {
      await addBranch(repo.dir, "feature/a", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");

      // Write a dummy resume state
      await runGitCommand(
        repo.dir,
        "config",
        "stack.my-stack.land-resume-state",
        JSON.stringify({ plan: {}, completedRebases: [] }),
      );

      await expect(
        executeLandFromCli(repo.dir, "my-stack", new Map(), new Map(), {}),
      ).rejects.toThrow("land already in progress");
    } finally {
      await repo.cleanup();
    }
  });
});
