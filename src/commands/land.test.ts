import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LandCase } from "./land.ts";
import {
  captureSnapshot,
  classifyLandCase,
  executeLand,
  isShallowRepository,
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
