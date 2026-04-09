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
import { getAllNodes, runGitCommand, type StackTree } from "../lib/stack.ts";

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

/**
 * Classify a stack + PR state map into one of the two supported land
 * shapes. Throws `UnsupportedLandShape` for any other configuration.
 *
 * Supported shapes:
 * - "all-merged": every branch in the stack has a MERGED PR.
 * - "root-merged": the stack has exactly one root, that root is MERGED,
 *   and no other branch is MERGED.
 */
export function classifyLandCase(
  tree: StackTree,
  prStateByBranch: PrStateByBranch,
): LandCase {
  const nodes = getAllNodes(tree);
  if (nodes.length === 0) {
    throw new UnsupportedLandShape("Stack has no branches to land");
  }

  const mergedSet = new Set(
    nodes
      .filter((n) => prStateByBranch.get(n.branch) === "MERGED")
      .map((n) => n.branch),
  );

  if (mergedSet.size === 0) {
    throw new UnsupportedLandShape("No merged PRs found in this stack");
  }

  if (mergedSet.size === nodes.length) {
    return "all-merged";
  }

  if (tree.roots.length !== 1) {
    throw new UnsupportedLandShape(
      "Cannot land a multi-root stack unless every branch is merged",
    );
  }
  const root = tree.roots[0];
  if (!mergedSet.has(root.branch)) {
    throw new UnsupportedLandShape(
      "Root of the stack is not merged; only merged roots or fully merged stacks are supported",
    );
  }
  if (mergedSet.size !== 1) {
    throw new UnsupportedLandShape(
      "Unsupported land shape: a non-root branch has a merged PR; only the root or every branch may be merged",
    );
  }

  return "root-merged";
}

async function revParse(dir: string, ref: string): Promise<string> {
  const { code, stdout, stderr } = await runGitCommand(dir, "rev-parse", ref);
  if (code !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${stderr}`);
  }
  return stdout;
}

export async function captureSnapshot(
  dir: string,
  tree: StackTree,
): Promise<BranchSnapshot[]> {
  const nodes = getAllNodes(tree);
  const snapshots: BranchSnapshot[] = [];
  for (const node of nodes) {
    const tipSha = await revParse(dir, node.branch);
    const parentTipSha = await revParse(dir, node.parent);
    snapshots.push({
      branch: node.branch,
      tipSha,
      recordedParent: node.parent,
      parentTipSha,
    });
  }
  return snapshots;
}

export async function captureOriginalHead(dir: string): Promise<string> {
  const { code, stdout } = await runGitCommand(
    dir,
    "symbolic-ref",
    "--quiet",
    "HEAD",
  );
  if (code === 0) return stdout;
  // Detached HEAD: fall back to raw SHA so we can restore it.
  return await revParse(dir, "HEAD");
}
