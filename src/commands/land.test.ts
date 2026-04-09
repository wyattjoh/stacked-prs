import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LandCase } from "./land.ts";
import {
  captureSnapshot,
  classifyLandCase,
  isShallowRepository,
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
import { getStackTree, setBaseBranch, setStackNode } from "../lib/stack.ts";

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
