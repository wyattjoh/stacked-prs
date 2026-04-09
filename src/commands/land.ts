import type { DirtyWorktree } from "../lib/worktrees.ts";
import type { SplitInfo } from "./config.ts";
import type { NavAction } from "./nav.ts";
import type { PrInfo } from "../tui/types.ts";

export type LandCase = "root-merged" | "all-merged";

export interface BranchSnapshot {
  branch: string;
  tipSha: string;
  recordedParent: string;
  parentTipSha: string;
}

export interface LandRebaseStep {
  branch: string;
  oldParentSha: string;
  newTarget: string;
}

export interface LandPushStep {
  branch: string;
  preLeaseSha: string;
}

export interface LandPrUpdate {
  branch: string;
  prNumber: number;
  oldBase: string;
  newBase: string;
  wasDraft: boolean;
  flipToReady: boolean;
}

export interface LandPrClose {
  branch: string;
  prNumber: number;
}

export interface LandPlan {
  stackName: string;
  baseBranch: string;
  case: LandCase;
  mergedBranches: string[];
  rebaseSteps: LandRebaseStep[];
  pushSteps: LandPushStep[];
  prUpdates: LandPrUpdate[];
  navUpdates: NavAction[];
  branchesToDelete: string[];
  snapshot: BranchSnapshot[];
  originalHeadRef: string;
  splitPreview: SplitInfo[];
}

export type LandStep =
  | { kind: "preflight" }
  | { kind: "fetch" }
  | { kind: "rebase"; branch: string }
  | { kind: "push"; branch: string }
  | { kind: "pr-update"; branch: string }
  | { kind: "pr-close"; branch: string }
  | { kind: "nav" }
  | { kind: "config-cleanup" }
  | { kind: "delete"; branch: string }
  | { kind: "restore-head" };

export interface LandProgressEvent {
  step: LandStep;
  status: "running" | "ok" | "skipped" | "failed";
  message?: string;
}

export interface LandRollbackReport {
  localRestored: string[];
  localFailed: Array<{ branch: string; reason: string }>;
  remoteRestored: string[];
  remoteFailed: Array<{ branch: string; reason: string }>;
  prRestored: number[];
  prFailed: Array<{ prNumber: number; reason: string }>;
}

export interface LandResult {
  plan: LandPlan;
  autoMergedBranches: string[];
  split: SplitInfo[];
}

/** PR state input to planLand. Only "MERGED" matters for classification. */
export type PrStateByBranch = Map<
  string,
  "OPEN" | "DRAFT" | "MERGED" | "CLOSED" | "NONE"
>;

export interface LandHooks {
  onProgress: (event: LandProgressEvent) => void;
  /**
   * Re-read PR states immediately before mutation, to catch plans that
   * went stale between user confirmation and execution. In tests this is
   * stubbed; in production the TUI supplies a function that re-runs
   * `gh pr list --state all` for every plan branch.
   */
  freshPrStates: (branches: string[]) => Promise<PrStateByBranch>;
  signal?: AbortSignal;
}

export class LandError extends Error {
  constructor(
    message: string,
    public readonly plan: LandPlan,
    public readonly rollback: LandRollbackReport,
    public readonly failedAt: LandStep,
  ) {
    super(message);
    this.name = "LandError";
  }
}

export class UnsupportedLandShape extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedLandShape";
  }
}

// Suppress unused-import warnings at the module boundary. These types are
// re-used by land-related helpers in later tasks (preflight, plan, execute).
export type { DirtyWorktree, NavAction, PrInfo, SplitInfo };

import {
  checkWorktreeSafety,
  findWorktreeCollisions,
  type InProgressOperation,
  listInProgressOperations,
  type WorktreeCollision,
} from "../lib/worktrees.ts";
import { runGitCommand } from "../lib/stack.ts";

export async function isShallowRepository(dir: string): Promise<boolean> {
  const { code, stdout } = await runGitCommand(
    dir,
    "rev-parse",
    "--is-shallow-repository",
  );
  if (code !== 0) return false;
  return stdout === "true";
}

export type LandBlocker =
  | { kind: "shallow-repo" }
  | { kind: "dirty-worktree"; worktree: DirtyWorktree }
  | { kind: "in-progress-op"; op: InProgressOperation }
  | { kind: "worktree-collision"; collision: WorktreeCollision };

export interface LandPreflightReport {
  isShallow: boolean;
  blockers: LandBlocker[];
}

/**
 * Run every preflight check relevant to a land operation. Returns a list
 * of blockers that must be zero for the land to proceed. `branches` is
 * the full set of branches that will be touched (rebased, pushed,
 * deleted, etc.).
 */
export async function runLandPreflight(
  dir: string,
  branches: string[],
): Promise<LandPreflightReport> {
  const blockers: LandBlocker[] = [];

  const isShallow = await isShallowRepository(dir);
  if (isShallow) blockers.push({ kind: "shallow-repo" });

  const inProgress = await listInProgressOperations(dir);
  for (const op of inProgress) {
    blockers.push({ kind: "in-progress-op", op });
  }

  const collisions = await findWorktreeCollisions(dir, branches);
  for (const c of collisions) {
    blockers.push({ kind: "worktree-collision", collision: c });
  }

  const dirty = await checkWorktreeSafety(dir, branches);
  for (const d of dirty) {
    blockers.push({ kind: "dirty-worktree", worktree: d });
  }

  return { isShallow, blockers };
}
