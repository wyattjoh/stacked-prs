import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import { LandModal } from "./land-modal.tsx";
import type { LandPhase } from "../types.ts";
import type { LandPlan } from "../../commands/land.ts";

const fakePlan = (): LandPlan => ({
  stackName: "s",
  baseBranch: "main",
  case: "root-merged",
  mergedBranches: ["feat/a"],
  rebaseSteps: [
    { branch: "feat/b", oldParentSha: "aaa", newTarget: "origin/main" },
  ],
  pushSteps: [{ branch: "feat/b", preLeaseSha: "bbb" }],
  prUpdates: [{
    branch: "feat/b",
    prNumber: 20,
    oldBase: "feat/a",
    newBase: "main",
    wasDraft: true,
    flipToReady: true,
  }],
  navUpdates: [],
  branchesToDelete: ["feat/a"],
  worktreesToRemove: [],
  snapshot: [],
  originalHeadRef: "refs/heads/main",
  splitPreview: [],
});

describe("LandModal", () => {
  test("planning phase shows the stack name", () => {
    const phase: LandPhase = { phase: "planning", stackName: "s" };
    const { lastFrame, unmount } = render(<LandModal phase={phase} />);
    try {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Computing land plan");
      expect(frame).toContain("s");
    } finally {
      unmount();
    }
  });

  test("confirming phase shows the plan sections and key hints", () => {
    const phase: LandPhase = { phase: "confirming", plan: fakePlan() };
    const { lastFrame, unmount } = render(<LandModal phase={phase} />);
    try {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Land stack s");
      expect(frame).toContain("Rebase");
      expect(frame).toContain("Push");
      expect(frame).toContain("[y]");
      expect(frame).toContain("esc");
    } finally {
      unmount();
    }
  });

  test("executing phase shows step markers from events", () => {
    const phase: LandPhase = {
      phase: "executing",
      plan: fakePlan(),
      events: [
        { step: { kind: "fetch" }, status: "ok" },
        { step: { kind: "rebase", branch: "feat/b" }, status: "running" },
      ],
    };
    const { lastFrame, unmount } = render(<LandModal phase={phase} />);
    try {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Executing");
      expect(frame).toContain("fetch");
      expect(frame).toContain("rebase feat/b");
    } finally {
      unmount();
    }
  });

  test("done phase shows the summary", () => {
    const phase: LandPhase = {
      phase: "done",
      result: {
        plan: fakePlan(),
        autoMergedBranches: [],
        split: [],
      },
    };
    const { lastFrame, unmount } = render(<LandModal phase={phase} />);
    try {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Landed stack s");
    } finally {
      unmount();
    }
  });

  test("error phase shows the rollback report", () => {
    const phase: LandPhase = {
      phase: "error",
      plan: fakePlan(),
      events: [
        {
          step: { kind: "push", branch: "feat/b" },
          status: "failed",
          message: "lease",
        },
      ],
      message: "Push of feat/b failed: lease",
      rollback: {
        commands: [
          "git update-ref refs/heads/feat/b abc123",
          "git push --force-with-lease=refs/heads/feat/b:def456 origin abc123:refs/heads/feat/b",
        ],
        localRestored: ["feat/b"],
        localFailed: [],
        remoteRestored: [],
        remoteFailed: [{ branch: "feat/b", reason: "lease mismatch" }],
        prRestored: [],
        prFailed: [],
      },
    };
    const { lastFrame, unmount } = render(<LandModal phase={phase} />);
    try {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Land failed");
      expect(frame).toContain("Rollback");
      expect(frame).toContain("Commands");
      expect(frame).toContain("git update-ref refs/heads/feat/b abc123");
      expect(frame).toContain("feat/b");
      expect(frame).toContain("lease mismatch");
    } finally {
      unmount();
    }
  });
});
