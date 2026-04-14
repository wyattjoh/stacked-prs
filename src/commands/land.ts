import type { DirtyWorktree } from "../lib/worktrees.ts";
import type { SplitInfo } from "./config.ts";
import type { NavAction } from "./nav.ts";
import type { PrInfo } from "./status.ts";

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
  /** Clean linked worktrees that will be removed before the land executes. */
  worktreesToRemove: WorktreeCollision[];
  snapshot: BranchSnapshot[];
  originalHeadRef: string;
  splitPreview: SplitInfo[];
}

export type LandStep =
  | { kind: "preflight" }
  | { kind: "fetch" }
  | { kind: "remove-worktree"; branch: string }
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
  /** Each command attempted during rollback, in execution order. */
  commands: string[];
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

export interface LandResumeState {
  plan: LandPlan;
  completedRebases: string[];
  completedPushes: string[];
  prUpdated: number[];
  prClosed: number[];
  navDone: boolean;
  configCleanupDone: boolean;
  deletedBranches: string[];
  /**
   * Branches detected as auto-merged by patch-id after rebase. These are
   * excluded from push / pr-update and are included in the PR-close phase
   * plus the delete loop. Added during the LOG-002 cleanup; older persisted
   * states default to empty on load (see `loadResumeState`).
   */
  autoMerged: string[];
  conflictedBranch?: string;
}

export interface LandCliResult {
  ok: boolean;
  error?: "conflict" | "blocked" | "other";
  plan?: LandPlan;
  result?: LandResult;
  completedSteps?: {
    rebased: string[];
    pushed: string[];
    prUpdated: number[];
    prClosed: number[];
    navDone: boolean;
    configCleanupDone: boolean;
  };
  conflictedAt?: LandStep;
  conflictFiles?: string[];
  recovery?: { resolve: string; abort: string; resume: string };
}

/** PR state input to planLand. Only "MERGED" matters for classification. */
export type PrStateByBranch = Map<
  string,
  "OPEN" | "DRAFT" | "MERGED" | "CLOSED" | "NONE"
>;

/** Map a raw PR (or null) to its PrStateByBranch value. */
export function prStateFrom(
  pr: { state: string; isDraft: boolean } | null,
): "OPEN" | "DRAFT" | "MERGED" | "CLOSED" | "NONE" {
  if (pr === null) return "NONE";
  if (pr.state === "MERGED") return "MERGED";
  if (pr.state === "CLOSED") return "CLOSED";
  if (pr.isDraft) return "DRAFT";
  return "OPEN";
}

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

export type { DirtyWorktree, NavAction, PrInfo, SplitInfo, WorktreeCollision };

import {
  checkWorktreeSafety,
  findWorktreeCollisions,
  type InProgressOperation,
  listInProgressOperations,
  type WorktreeCollision,
} from "../lib/worktrees.ts";
import { gh } from "../lib/gh.ts";
import {
  addLandedBranch,
  clearStackConfig,
  findNode,
  getAllNodes,
  getConflictFiles,
  getStackTree,
  removeStackBranch,
  revParse,
  runGitCommand,
  type StackTree,
} from "../lib/stack.ts";
import { topologicalOrder } from "./restack.ts";
import { configLandCleanup } from "./config.ts";
import { buildNavPlan, executeNavAction } from "./nav.ts";

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
  /**
   * Branches whose linked worktrees will be removed by the land plan before
   * execution reaches the delete step. Collision blockers are suppressed for
   * these branches because the plan has already accounted for them.
   */
  worktreeBranchesToSkip: string[] = [],
): Promise<LandPreflightReport> {
  const blockers: LandBlocker[] = [];
  const skipSet = new Set(worktreeBranchesToSkip);

  const isShallow = await isShallowRepository(dir);
  if (isShallow) blockers.push({ kind: "shallow-repo" });

  const inProgress = await listInProgressOperations(dir);
  for (const op of inProgress) {
    blockers.push({ kind: "in-progress-op", op });
  }

  const collisions = await findWorktreeCollisions(dir, branches);
  for (const c of collisions) {
    if (!skipSet.has(c.branch)) {
      blockers.push({ kind: "worktree-collision", collision: c });
    }
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
  // Ignore historically merged nodes — they are done and don't affect classification
  const nodes = getAllNodes(tree).filter((n) => !n.merged);
  if (nodes.length === 0) {
    throw new UnsupportedLandShape("Stack has no live branches to land");
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

  const liveRoots = tree.roots.filter((n) => !n.merged);
  if (liveRoots.length !== 1) {
    throw new UnsupportedLandShape(
      "Cannot land a multi-root stack unless every branch is merged",
    );
  }
  const root = liveRoots[0];
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

export async function fetchBase(
  dir: string,
  baseBranch: string,
): Promise<void> {
  const { code, stderr } = await runGitCommand(
    dir,
    "fetch",
    "origin",
    baseBranch,
  );
  if (code !== 0) {
    throw new Error(
      `git fetch origin ${baseBranch} failed: ${stderr.trim()}. ` +
        `Check your network connection and origin remote.`,
    );
  }
}

/**
 * True iff `branch` has zero unique commits beyond `origin/<baseBranch>`.
 * Indicates the branch was auto-merged by patch-id against the upstream
 * base during rebase.
 *
 * Compares against `origin/<baseBranch>` specifically (not the rebased
 * parent branch as the inline TUI check does), so callers must have run
 * `fetchBase` first to guarantee `origin/<baseBranch>` resolves. Returns
 * `false` on any `rev-list` failure (missing branch, missing origin ref,
 * etc.) so a verification gap never causes a branch to be tombstoned.
 *
 * Used by `executeLandFromCli` to skip push / PR retarget and instead
 * close + delete + tombstone auto-merged branches.
 */
export async function isBranchAutoMerged(
  dir: string,
  branch: string,
  baseBranch: string,
): Promise<boolean> {
  const { code, stdout } = await runGitCommand(
    dir,
    "rev-list",
    "--count",
    `origin/${baseBranch}..${branch}`,
  );
  if (code !== 0) return false;
  return stdout === "0";
}

/**
 * Build per-branch rebase steps for the "root-merged" case. Walks the
 * tree in DFS topological order, skipping the merged root. The first
 * step after the root targets `origin/<base>`; deeper steps target the
 * parent branch name (which will have been rebased by the time they run).
 */
export function buildRebaseSteps(
  tree: StackTree,
  snapshot: BranchSnapshot[],
  mergedRoot: string,
): LandRebaseStep[] {
  const byBranch = new Map(snapshot.map((s) => [s.branch, s]));
  const steps: LandRebaseStep[] = [];
  for (const node of topologicalOrder(tree)) {
    if (node.branch === mergedRoot) continue;
    const parentSnap = byBranch.get(node.parent);
    const oldParentSha = parentSnap?.tipSha;
    if (oldParentSha === undefined) {
      throw new Error(
        `buildRebaseSteps: no snapshot for parent ${node.parent} of ${node.branch}`,
      );
    }
    const newTarget = node.parent === mergedRoot
      ? `origin/${tree.baseBranch}`
      : node.parent;
    steps.push({
      branch: node.branch,
      oldParentSha,
      newTarget,
    });
  }
  return steps;
}

/**
 * Build leaves-first push steps from a rebase plan. `snapshot` is used
 * to recover each branch's pre-land tip SHA for the lease expectation.
 */
export function buildPushSteps(
  tree: StackTree,
  snapshot: BranchSnapshot[],
  mergedRoot: string,
): LandPushStep[] {
  const byBranch = new Map(snapshot.map((s) => [s.branch, s]));
  const order = topologicalOrder(tree).filter((n) => n.branch !== mergedRoot);
  const steps: LandPushStep[] = [];
  for (const node of [...order].reverse()) {
    const snap = byBranch.get(node.branch);
    if (!snap) continue;
    steps.push({ branch: node.branch, preLeaseSha: snap.tipSha });
  }
  return steps;
}

/**
 * Build PR base-retarget and ready-flip steps. Only branches whose
 * recorded parent in the tree IS the merged root require a base change
 * (they become direct children of the stack's base branch). Flip to
 * ready when a branch was previously a draft (submit policy:
 * parent-is-base PRs are ready).
 */
export function buildPrUpdateSteps(
  tree: StackTree,
  prInfoByBranch: Map<string, PrInfo>,
  mergedRoot: string,
): LandPrUpdate[] {
  const updates: LandPrUpdate[] = [];
  for (const node of getAllNodes(tree)) {
    if (node.branch === mergedRoot) continue;
    if (node.parent !== mergedRoot) continue;
    const pr = prInfoByBranch.get(node.branch);
    if (!pr) continue;
    updates.push({
      branch: node.branch,
      prNumber: pr.number,
      oldBase: mergedRoot,
      newBase: tree.baseBranch,
      wasDraft: pr.isDraft,
      flipToReady: pr.isDraft,
    });
  }
  return updates;
}

export interface LandCleanupPreview {
  remainingRoots: string[];
  splits: SplitInfo[];
}

/**
 * Compute (in memory, no config writes) what `configLandCleanup` would
 * do for the given tree and merged root: children of the merged root
 * become new roots, and if more than one remains we anticipate a split.
 */
export function previewLandCleanup(
  tree: StackTree,
  mergedBranch: string,
): LandCleanupPreview {
  const mergedNode = findNode(tree, mergedBranch);
  const remainingRoots: string[] = [];
  for (const root of tree.roots) {
    if (root.branch === mergedBranch) {
      if (mergedNode) {
        for (const child of mergedNode.children) {
          remainingRoots.push(child.branch);
        }
      }
      continue;
    }
    remainingRoots.push(root.branch);
  }

  if (remainingRoots.length <= 1) {
    return { remainingRoots, splits: [] };
  }

  // Mirror the naming logic in configSplitStack.
  const used = new Set<string>();
  const splits: SplitInfo[] = [];
  for (const rootBranch of remainingRoots) {
    let name = rootBranch.replace(/^(?:feature|fix|chore)\//, "");
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }
    used.add(name);

    const subRoot = findNode(tree, rootBranch);
    const branches: string[] = [];
    if (subRoot) {
      const walk = (n: typeof subRoot): void => {
        branches.push(n.branch);
        for (const c of n.children) walk(c);
      };
      walk(subRoot);
    }

    splits.push({ stackName: name, branches });
  }

  return { remainingRoots, splits };
}

export async function planLand(
  dir: string,
  stackName: string,
  prStateByBranch: PrStateByBranch,
  prInfoByBranch: Map<string, PrInfo>,
): Promise<LandPlan> {
  const tree = await getStackTree(dir, stackName);

  // Merged nodes are historical; exclude them from rebase/push/PR steps
  const liveRoots = tree.roots.filter((n) => !n.merged);
  const liveTree: StackTree = { ...tree, roots: liveRoots };

  const landCase = classifyLandCase(tree, prStateByBranch);

  const snapshot = await captureSnapshot(dir, tree);
  const originalHeadRef = await captureOriginalHead(dir);

  const mergedBranches = getAllNodes(liveTree)
    .filter((n) => prStateByBranch.get(n.branch) === "MERGED")
    .map((n) => n.branch);

  if (landCase === "all-merged") {
    // All branches are being deleted; check worktrees for all of them.
    const worktreesToRemove = await detectCleanWorktreeCollisions(
      dir,
      mergedBranches,
    );
    return {
      stackName,
      baseBranch: tree.baseBranch,
      case: "all-merged",
      mergedBranches,
      rebaseSteps: [],
      pushSteps: [],
      prUpdates: [],
      navUpdates: [],
      branchesToDelete: mergedBranches,
      worktreesToRemove,
      snapshot,
      originalHeadRef,
      splitPreview: [],
    };
  }

  // root-merged: only the merged root is deleted; surviving branches are
  // rebased. A clean worktree for a surviving branch is a hard blocker (git
  // refuses to rebase a branch checked out in another worktree), so we only
  // check the deleted root's worktree here.
  const mergedRoot = liveTree.roots[0].branch;
  const worktreesToRemove = await detectCleanWorktreeCollisions(dir, [
    mergedRoot,
  ]);

  const rebaseSteps = buildRebaseSteps(liveTree, snapshot, mergedRoot);
  const pushSteps = buildPushSteps(liveTree, snapshot, mergedRoot);
  const prUpdates = buildPrUpdateSteps(liveTree, prInfoByBranch, mergedRoot);
  const preview = previewLandCleanup(liveTree, mergedRoot);

  return {
    stackName,
    baseBranch: tree.baseBranch,
    case: "root-merged",
    mergedBranches,
    rebaseSteps,
    pushSteps,
    prUpdates,
    navUpdates: [],
    branchesToDelete: [mergedRoot],
    worktreesToRemove,
    snapshot,
    originalHeadRef,
    splitPreview: preview.splits,
  };
}

/**
 * Find clean linked-worktree collisions for `branches`. Throws
 * `UnsupportedLandShape` if any collision is dirty (the user must clean up
 * those manually before landing).
 */
async function detectCleanWorktreeCollisions(
  dir: string,
  branches: string[],
): Promise<WorktreeCollision[]> {
  const collisions = await findWorktreeCollisions(dir, branches);
  const dirty = collisions.filter((c) => c.dirty);
  if (dirty.length > 0) {
    throw new UnsupportedLandShape(
      `branches are checked out in dirty worktrees: ${
        dirty.map((c) => `${c.branch} (${c.worktreePath})`).join(", ")
      }`,
    );
  }
  return collisions;
}

function emit(
  hooks: LandHooks,
  step: LandStep,
  status: LandProgressEvent["status"],
  message?: string,
): void {
  hooks.onProgress({ step, status, message });
}

function emptyRollback(): LandRollbackReport {
  return {
    commands: [],
    localRestored: [],
    localFailed: [],
    remoteRestored: [],
    remoteFailed: [],
    prRestored: [],
    prFailed: [],
  };
}

function describeBlockers(blockers: LandBlocker[]): string {
  const parts: string[] = [];
  for (const b of blockers) {
    switch (b.kind) {
      case "shallow-repo":
        parts.push(
          "repository is a shallow clone; run `git fetch --unshallow` first",
        );
        break;
      case "dirty-worktree":
        parts.push(
          `dirty worktree at ${b.worktree.path} (${b.worktree.branch})`,
        );
        break;
      case "in-progress-op":
        parts.push(
          `${b.op.operation} in progress at ${b.op.worktreePath}`,
        );
        break;
      case "worktree-collision":
        parts.push(
          `${b.collision.branch} is checked out in ${b.collision.worktreePath}`,
        );
        break;
    }
  }
  return `Preflight blocked: ${parts.join("; ")}`;
}

/**
 * If HEAD is currently a symbolic ref pointing to one of `branchesToDelete`,
 * detach it to the current commit SHA so the deletion can proceed. Has no
 * effect when HEAD is already detached or points to a surviving branch.
 */
async function detachHeadFromDeleted(
  dir: string,
  branchesToDelete: string[],
): Promise<void> {
  const { code, stdout } = await runGitCommand(
    dir,
    "symbolic-ref",
    "--short",
    "HEAD",
  );
  if (code !== 0) return; // Already detached.
  if (!branchesToDelete.includes(stdout.trim())) return;
  const { code: shaCode, stdout: sha } = await runGitCommand(
    dir,
    "rev-parse",
    "HEAD",
  );
  if (shaCode !== 0) return;
  await runGitCommand(dir, "checkout", "--detach", sha.trim());
}

async function executeCaseBCleanup(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
): Promise<LandResult> {
  // If HEAD is on a branch about to be deleted, detach it first.
  await detachHeadFromDeleted(dir, plan.branchesToDelete);

  // Leaves-first: reverse the DFS order stored in branchesToDelete.
  const order = [...plan.branchesToDelete].reverse();
  for (const branch of order) {
    emit(hooks, { kind: "delete", branch }, "running");
    const { code: existsCode } = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    );
    if (existsCode !== 0) {
      emit(hooks, { kind: "delete", branch }, "skipped", "already absent");
      continue;
    }
    const { code, stderr } = await runGitCommand(dir, "branch", "-D", branch);
    if (code !== 0) {
      emit(hooks, { kind: "delete", branch }, "failed", stderr);
      throw new LandError(
        `Failed to delete ${branch}: ${stderr}`,
        plan,
        emptyRollback(),
        { kind: "delete", branch },
      );
    }
    await removeStackBranch(dir, branch);
    emit(hooks, { kind: "delete", branch }, "ok");
  }

  await clearStackConfig(dir, plan.stackName);

  await restoreHead(dir, plan, hooks);

  return { plan, autoMergedBranches: [], split: [] };
}

interface ExecState {
  rollback: LandRollbackReport;
  rebased: Set<string>;
  pushed: Set<string>;
  prUpdated: Set<number>;
  prClosed: Set<number>;
  configCleanupDone: boolean;
  autoMerged: Set<string>;
  snapByBranch: Map<string, BranchSnapshot>;
}

function initExecState(plan: LandPlan): ExecState {
  return {
    rollback: emptyRollback(),
    rebased: new Set(),
    pushed: new Set(),
    prUpdated: new Set(),
    prClosed: new Set(),
    configCleanupDone: false,
    autoMerged: new Set(),
    snapByBranch: new Map(plan.snapshot.map((s) => [s.branch, s])),
  };
}

async function rollbackLocalRebases(
  dir: string,
  state: ExecState,
): Promise<void> {
  for (const branch of state.rebased) {
    const snap = state.snapByBranch.get(branch);
    if (!snap) continue;
    state.rollback.commands.push(
      `git update-ref refs/heads/${branch} ${snap.tipSha}`,
    );
    const { code, stderr } = await runGitCommand(
      dir,
      "update-ref",
      `refs/heads/${branch}`,
      snap.tipSha,
    );
    if (code === 0) {
      state.rollback.localRestored.push(branch);
    } else {
      state.rollback.localFailed.push({ branch, reason: stderr });
    }
  }
}

async function executeCaseARebases(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
  state: ExecState,
): Promise<void> {
  for (const step of plan.rebaseSteps) {
    emit(hooks, { kind: "rebase", branch: step.branch }, "running");

    const checkout = await runGitCommand(dir, "checkout", step.branch);
    if (checkout.code !== 0) {
      emit(
        hooks,
        { kind: "rebase", branch: step.branch },
        "failed",
        checkout.stderr,
      );
      await rollbackLocalRebases(dir, state);
      throw new LandError(
        `Failed to checkout ${step.branch}: ${checkout.stderr}`,
        plan,
        state.rollback,
        { kind: "rebase", branch: step.branch },
      );
    }

    const rebase = await runGitCommand(
      dir,
      "rebase",
      "--rebase-merges",
      "--onto",
      step.newTarget,
      step.oldParentSha,
      step.branch,
    );

    if (rebase.code !== 0) {
      await runGitCommand(dir, "rebase", "--abort");
      emit(
        hooks,
        { kind: "rebase", branch: step.branch },
        "failed",
        rebase.stderr,
      );
      await rollbackLocalRebases(dir, state);
      throw new LandError(
        `Rebase of ${step.branch} failed: ${rebase.stderr}`,
        plan,
        state.rollback,
        { kind: "rebase", branch: step.branch },
      );
    }

    state.rebased.add(step.branch);

    // Empty-branch detection: rebase dropped every commit via patch-id.
    const countResult = await runGitCommand(
      dir,
      "rev-list",
      "--count",
      `${step.newTarget}..${step.branch}`,
    );
    if (countResult.code === 0 && countResult.stdout === "0") {
      state.autoMerged.add(step.branch);
      emit(
        hooks,
        { kind: "rebase", branch: step.branch },
        "ok",
        "auto-merged (patch-id drop)",
      );
    } else {
      emit(hooks, { kind: "rebase", branch: step.branch }, "ok");
    }
  }
}

async function rollbackRemotePushes(
  dir: string,
  state: ExecState,
): Promise<void> {
  for (const branch of state.pushed) {
    const snap = state.snapByBranch.get(branch);
    if (!snap) continue;

    const { code: headCode, stdout: postSha } = await runGitCommand(
      dir,
      "rev-parse",
      branch,
    );
    if (headCode !== 0) {
      state.rollback.remoteFailed.push({
        branch,
        reason: "could not rev-parse current tip",
      });
      continue;
    }

    state.rollback.commands.push(
      `git push --force-with-lease=refs/heads/${branch}:${postSha} origin ${snap.tipSha}:refs/heads/${branch}`,
    );
    const { code, stderr } = await runGitCommand(
      dir,
      "push",
      `--force-with-lease=refs/heads/${branch}:${postSha}`,
      "origin",
      `${snap.tipSha}:refs/heads/${branch}`,
    );
    if (code === 0) {
      state.rollback.remoteRestored.push(branch);
    } else {
      state.rollback.remoteFailed.push({
        branch,
        reason: `force-with-lease rollback failed: ${stderr.trim()}`,
      });
    }
  }
}

async function executeCaseAPushes(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
  state: ExecState,
): Promise<void> {
  for (const step of plan.pushSteps) {
    if (state.autoMerged.has(step.branch)) {
      emit(
        hooks,
        { kind: "push", branch: step.branch },
        "skipped",
        "auto-merged",
      );
      continue;
    }

    emit(hooks, { kind: "push", branch: step.branch }, "running");
    const { code, stderr } = await runGitCommand(
      dir,
      "push",
      `--force-with-lease=refs/heads/${step.branch}:${step.preLeaseSha}`,
      "origin",
      step.branch,
    );
    if (code !== 0) {
      emit(hooks, { kind: "push", branch: step.branch }, "failed", stderr);
      await rollbackRemotePushes(dir, state);
      await rollbackLocalRebases(dir, state);
      throw new LandError(
        `Push of ${step.branch} failed: ${stderr}`,
        plan,
        state.rollback,
        { kind: "push", branch: step.branch },
      );
    }
    state.pushed.add(step.branch);
    emit(hooks, { kind: "push", branch: step.branch }, "ok");
  }
}

async function rollbackPrUpdates(
  _dir: string,
  plan: LandPlan,
  state: ExecState,
): Promise<void> {
  for (const update of plan.prUpdates) {
    if (!state.prUpdated.has(update.prNumber)) continue;
    try {
      await gh("pr", "edit", String(update.prNumber), "--base", update.oldBase);
      if (update.flipToReady) {
        await gh("pr", "ready", String(update.prNumber), "--undo");
      }
      state.rollback.prRestored.push(update.prNumber);
    } catch (err) {
      state.rollback.prFailed.push({
        prNumber: update.prNumber,
        reason: (err as Error).message,
      });
    }
  }
}

async function executeCaseAPrUpdates(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
  state: ExecState,
): Promise<void> {
  for (const update of plan.prUpdates) {
    if (state.autoMerged.has(update.branch)) {
      // Auto-merged branches are handled by the PR close phase (Task 20).
      continue;
    }
    emit(hooks, { kind: "pr-update", branch: update.branch }, "running");
    try {
      await gh("pr", "edit", String(update.prNumber), "--base", update.newBase);
      if (update.flipToReady) {
        await gh("pr", "ready", String(update.prNumber));
      }
      state.prUpdated.add(update.prNumber);
      emit(hooks, { kind: "pr-update", branch: update.branch }, "ok");
    } catch (err) {
      emit(
        hooks,
        { kind: "pr-update", branch: update.branch },
        "failed",
        (err as Error).message,
      );
      await rollbackPrUpdates(dir, plan, state);
      await rollbackRemotePushes(dir, state);
      await rollbackLocalRebases(dir, state);
      throw new LandError(
        `PR update for ${update.branch} failed: ${(err as Error).message}`,
        plan,
        state.rollback,
        { kind: "pr-update", branch: update.branch },
      );
    }
  }
}

async function executeCaseA(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
): Promise<LandResult> {
  const state = initExecState(plan);

  emit(hooks, { kind: "fetch" }, "running");
  try {
    await fetchBase(dir, plan.baseBranch);
    emit(hooks, { kind: "fetch" }, "ok");
  } catch (err) {
    emit(hooks, { kind: "fetch" }, "failed", (err as Error).message);
    throw new LandError(
      (err as Error).message,
      plan,
      state.rollback,
      { kind: "fetch" },
    );
  }

  await executeCaseARebases(dir, plan, hooks, state);

  await executeCaseAPushes(dir, plan, hooks, state);

  await executeCaseAPrUpdates(dir, plan, hooks, state);

  await executeCaseAPrCloses(dir, plan, hooks, state);

  // Nav comment refresh. Computed after PR retargets so the rendered
  // markdown reflects the post-land tree shape. Failures are non-fatal:
  // the stack has already landed, rolling back nav is not meaningful.
  emit(hooks, { kind: "nav" }, "running");
  try {
    const repoInfo = await gh("repo", "view", "--json", "owner,name");
    const parsed = JSON.parse(repoInfo) as {
      owner: { login: string };
      name: string;
    };
    const navActions = await buildNavPlan(
      dir,
      plan.stackName,
      parsed.owner.login,
      parsed.name,
    );
    for (const action of navActions) {
      await executeNavAction(parsed.owner.login, parsed.name, action);
    }
    emit(hooks, { kind: "nav" }, navActions.length === 0 ? "skipped" : "ok");
  } catch (err) {
    emit(hooks, { kind: "nav" }, "failed", (err as Error).message);
  }

  // Config cleanup: reparent children of the merged root to the base branch.
  emit(hooks, { kind: "config-cleanup" }, "running");
  const mergedRoot = plan.branchesToDelete[0];
  let cleanupResult;
  try {
    cleanupResult = await configLandCleanup(dir, plan.stackName, mergedRoot);
    state.configCleanupDone = true;
    emit(hooks, { kind: "config-cleanup" }, "ok");
  } catch (err) {
    emit(
      hooks,
      { kind: "config-cleanup" },
      "failed",
      (err as Error).message,
    );
    await rollbackPrUpdates(dir, plan, state);
    await rollbackRemotePushes(dir, state);
    await rollbackLocalRebases(dir, state);
    throw new LandError(
      (err as Error).message,
      plan,
      state.rollback,
      { kind: "config-cleanup" },
    );
  }

  // Delete the merged root and any auto-merged branches. Deletion failures
  // are best-effort: the stack has already landed at this point.
  const toDelete = [mergedRoot, ...state.autoMerged];
  await detachHeadFromDeleted(dir, toDelete);
  for (const branch of toDelete) {
    emit(hooks, { kind: "delete", branch }, "running");
    const { code: existsCode } = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    );
    if (existsCode !== 0) {
      emit(hooks, { kind: "delete", branch }, "skipped", "already absent");
      continue;
    }
    const { code, stderr } = await runGitCommand(dir, "branch", "-D", branch);
    if (code !== 0) {
      emit(hooks, { kind: "delete", branch }, "failed", stderr);
      continue;
    }
    // Record every deleted branch as a tombstone so the TUI retains history.
    // Idempotent with the configLandCleanup write for mergedRoot.
    await addLandedBranch(dir, plan.stackName, branch);
    await removeStackBranch(dir, branch);
    emit(hooks, { kind: "delete", branch }, "ok");
  }

  await restoreHead(dir, plan, hooks);

  return {
    plan,
    autoMergedBranches: [...state.autoMerged],
    split: cleanupResult.splitInto,
  };
}

async function restoreHead(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
): Promise<void> {
  emit(hooks, { kind: "restore-head" }, "running");
  const ref = plan.originalHeadRef;
  if (ref.startsWith("refs/")) {
    const branchName = ref.replace(/^refs\/heads\//, "");
    const { code } = await runGitCommand(dir, "checkout", branchName);
    if (code !== 0) {
      // Branch was deleted as part of the land; fall back to the base branch.
      const { code: baseCode, stderr: baseSterr } = await runGitCommand(
        dir,
        "checkout",
        plan.baseBranch,
      );
      if (baseCode !== 0) {
        emit(hooks, { kind: "restore-head" }, "failed", baseSterr);
        return;
      }
    }
  } else {
    // Detached HEAD: checkout the raw SHA.
    const { code, stderr } = await runGitCommand(
      dir,
      "checkout",
      "--detach",
      ref,
    );
    if (code !== 0) {
      emit(hooks, { kind: "restore-head" }, "failed", stderr);
      return;
    }
  }
  emit(hooks, { kind: "restore-head" }, "ok");
}

async function executeCaseAPrCloses(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
  state: ExecState,
): Promise<void> {
  for (const update of plan.prUpdates) {
    if (!state.autoMerged.has(update.branch)) continue;
    emit(hooks, { kind: "pr-close", branch: update.branch }, "running");
    try {
      await gh(
        "pr",
        "close",
        String(update.prNumber),
        "--comment",
        "auto-merged during stack land: every commit was already upstream",
      );
      state.prClosed.add(update.prNumber);
      emit(hooks, { kind: "pr-close", branch: update.branch }, "ok");
    } catch (err) {
      emit(
        hooks,
        { kind: "pr-close", branch: update.branch },
        "failed",
        (err as Error).message,
      );
      await rollbackPrUpdates(dir, plan, state);
      await rollbackRemotePushes(dir, state);
      await rollbackLocalRebases(dir, state);
      throw new LandError(
        `PR close for ${update.branch} failed: ${(err as Error).message}`,
        plan,
        state.rollback,
        { kind: "pr-close", branch: update.branch },
      );
    }
  }
}

export async function executeLand(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
): Promise<LandResult> {
  emit(hooks, { kind: "preflight" }, "running");
  const allBranches = plan.snapshot.map((s) => s.branch);
  const worktreeBranchesToSkip = plan.worktreesToRemove.map((wt) => wt.branch);
  const preflight = await runLandPreflight(
    dir,
    allBranches,
    worktreeBranchesToSkip,
  );
  if (preflight.blockers.length > 0) {
    emit(
      hooks,
      { kind: "preflight" },
      "failed",
      `${preflight.blockers.length} blocker(s)`,
    );
    throw new LandError(
      describeBlockers(preflight.blockers),
      plan,
      emptyRollback(),
      { kind: "preflight" },
    );
  }

  // Stale-plan detection: re-read PR states and verify the set of merged
  // branches hasn't changed since the plan was built. Protects against
  // reopened/closed/re-merged PRs during the confirm dialog.
  const freshStates = await hooks.freshPrStates(allBranches);
  const freshMerged = new Set(
    allBranches.filter((b) => freshStates.get(b) === "MERGED"),
  );
  const planMerged = new Set(plan.mergedBranches);
  const mergedUnchanged = freshMerged.size === planMerged.size &&
    [...freshMerged].every((b) => planMerged.has(b));
  if (!mergedUnchanged) {
    emit(hooks, { kind: "preflight" }, "failed", "plan is stale");
    throw new LandError(
      "plan is stale: PR states changed between planning and execution; re-run land",
      plan,
      emptyRollback(),
      { kind: "preflight" },
    );
  }

  emit(hooks, { kind: "preflight" }, "ok");

  for (const wt of plan.worktreesToRemove) {
    emit(hooks, { kind: "remove-worktree", branch: wt.branch }, "running");
    const { code, stderr } = await runGitCommand(
      dir,
      "worktree",
      "remove",
      wt.worktreePath,
    );
    if (code !== 0) {
      if (stderr.includes("is not a working tree")) {
        emit(
          hooks,
          { kind: "remove-worktree", branch: wt.branch },
          "skipped",
          "already absent",
        );
        continue;
      }
      emit(
        hooks,
        { kind: "remove-worktree", branch: wt.branch },
        "failed",
        stderr.trim(),
      );
      throw new LandError(
        `Failed to remove worktree at ${wt.worktreePath}: ${stderr.trim()}`,
        plan,
        emptyRollback(),
        { kind: "remove-worktree", branch: wt.branch },
      );
    }
    emit(hooks, { kind: "remove-worktree", branch: wt.branch }, "ok");
  }

  if (plan.case === "all-merged") {
    return await executeCaseBCleanup(dir, plan, hooks);
  }
  return await executeCaseA(dir, plan, hooks);
}

async function readLandResumeState(
  dir: string,
  stackName: string,
): Promise<LandResumeState | null> {
  const { code, stdout } = await runGitCommand(
    dir,
    "config",
    `stack.${stackName}.land-resume-state`,
  );
  if (code !== 0) return null;
  try {
    return JSON.parse(stdout) as LandResumeState;
  } catch {
    return null;
  }
}

async function writeLandResumeState(
  dir: string,
  stackName: string,
  state: LandResumeState,
): Promise<void> {
  await runGitCommand(
    dir,
    "config",
    `stack.${stackName}.land-resume-state`,
    JSON.stringify(state),
  );
}

async function clearLandResumeState(
  dir: string,
  stackName: string,
): Promise<void> {
  await runGitCommand(
    dir,
    "config",
    "--unset",
    `stack.${stackName}.land-resume-state`,
  );
}

export async function executeLandFromCli(
  dir: string,
  stackName: string,
  prStateByBranch: PrStateByBranch,
  prInfoByBranch: Map<string, PrInfo>,
  opts: { resume?: boolean },
): Promise<LandCliResult> {
  const existingState = await readLandResumeState(dir, stackName);
  if (existingState && !Array.isArray(existingState.autoMerged)) {
    existingState.autoMerged = [];
  }

  if (opts.resume && !existingState) {
    throw new Error("No land in progress to resume");
  }
  if (!opts.resume && existingState) {
    throw new Error(
      `land already in progress for stack "${stackName}". ` +
        `Run with --resume or clear stack.${stackName}.land-resume-state manually.`,
    );
  }

  const makeRecovery = (sn: string): LandCliResult["recovery"] => ({
    resolve: "git add <conflicting files> && git rebase --continue",
    abort: "git rebase --abort",
    resume: `deno run --allow-run=git,gh --allow-env --allow-read ${
      Deno.env.get("CLAUDE_PLUGIN_ROOT") ?? "."
    }/src/cli.ts land --stack-name=${sn} --resume`,
  });

  let plan: LandPlan;
  if (existingState) {
    plan = existingState.plan;
    // If a rebase was in progress, continue it first.
    if (existingState.conflictedBranch) {
      const continueResult = await runGitCommand(dir, "rebase", "--continue");
      if (continueResult.code !== 0) {
        const conflictFiles = await getConflictFiles(dir);
        if (conflictFiles.length > 0) {
          return {
            ok: false,
            error: "conflict",
            plan,
            conflictFiles,
            recovery: makeRecovery(stackName),
          };
        }
        return { ok: false, error: "other", plan };
      }
      existingState.completedRebases.push(existingState.conflictedBranch);
      existingState.conflictedBranch = undefined;
    }
  } else {
    plan = await planLand(dir, stackName, prStateByBranch, prInfoByBranch);
  }

  // Preflight
  const allBranches = plan.snapshot.map((s) => s.branch);
  const worktreesToSkip = plan.worktreesToRemove.map((wt) => wt.branch);
  const preflight = await runLandPreflight(dir, allBranches, worktreesToSkip);
  if (preflight.blockers.length > 0) {
    return { ok: false, error: "blocked", plan };
  }

  // Remove clean worktrees that collide with branches in the plan
  for (const wt of plan.worktreesToRemove) {
    await runGitCommand(dir, "worktree", "remove", "--force", wt.worktreePath);
  }

  // Initialize state tracker
  const completed: LandResumeState = existingState ?? {
    plan,
    completedRebases: [],
    completedPushes: [],
    prUpdated: [],
    prClosed: [],
    navDone: false,
    configCleanupDone: false,
    deletedBranches: [],
    autoMerged: [],
  };

  // Write initial resume state before any mutations
  if (!existingState) {
    await writeLandResumeState(dir, stackName, { ...completed, plan });
  }

  if (plan.case === "all-merged") {
    await detachHeadFromDeleted(dir, plan.branchesToDelete);
    const order = [...plan.branchesToDelete].reverse();
    for (const branch of order) {
      if (completed.deletedBranches.includes(branch)) continue;
      const { code: existsCode } = await runGitCommand(
        dir,
        "rev-parse",
        "--verify",
        `refs/heads/${branch}`,
      );
      if (existsCode !== 0) {
        completed.deletedBranches.push(branch);
        continue;
      }
      await runGitCommand(dir, "branch", "-D", branch);
      await removeStackBranch(dir, branch);
      completed.deletedBranches.push(branch);
      await writeLandResumeState(dir, stackName, completed);
    }
    await clearStackConfig(dir, stackName);
    await clearLandResumeState(dir, stackName);
    await restoreHead(dir, plan, {
      onProgress: () => {},
      freshPrStates: () => Promise.resolve(new Map()),
    });
    return {
      ok: true,
      plan,
      result: { plan, autoMergedBranches: [], split: [] },
    };
  }

  // root-merged path
  await fetchBase(dir, plan.baseBranch);

  for (const step of plan.rebaseSteps) {
    if (completed.completedRebases.includes(step.branch)) continue;

    await runGitCommand(dir, "checkout", step.branch);
    const rebase = await runGitCommand(
      dir,
      "rebase",
      "--rebase-merges",
      "--onto",
      step.newTarget,
      step.oldParentSha,
      step.branch,
    );

    if (rebase.code !== 0) {
      const conflictFiles = await getConflictFiles(dir);
      completed.conflictedBranch = step.branch;
      await writeLandResumeState(dir, stackName, completed);
      return {
        ok: false,
        error: "conflict",
        plan,
        completedSteps: {
          rebased: completed.completedRebases,
          pushed: completed.completedPushes,
          prUpdated: completed.prUpdated,
          prClosed: completed.prClosed,
          navDone: completed.navDone,
          configCleanupDone: completed.configCleanupDone,
        },
        conflictedAt: { kind: "rebase", branch: step.branch },
        conflictFiles,
        recovery: makeRecovery(stackName),
      };
    }

    completed.completedRebases.push(step.branch);

    // Mirror the TUI executor's patch-id drop detection (see the inline
    // check in executeCaseARebases). Branches with zero unique commits
    // beyond origin/<base> after rebase were auto-merged by patch-id
    // during the upstream squash merge. Record them so the push and PR
    // retarget loops below skip these branches, and the cleanup loop
    // instead closes the PR, deletes the branch, and tombstones it.
    if (await isBranchAutoMerged(dir, step.branch, plan.baseBranch)) {
      completed.autoMerged.push(step.branch);
    }
    await writeLandResumeState(dir, stackName, completed);
  }

  for (const step of plan.pushSteps) {
    if (completed.completedPushes.includes(step.branch)) continue;
    if (completed.autoMerged.includes(step.branch)) continue;
    await runGitCommand(
      dir,
      "push",
      `--force-with-lease=refs/heads/${step.branch}:${step.preLeaseSha}`,
      "origin",
      step.branch,
    );
    completed.completedPushes.push(step.branch);
    await writeLandResumeState(dir, stackName, completed);
  }

  for (const update of plan.prUpdates) {
    if (completed.prUpdated.includes(update.prNumber)) continue;
    if (completed.autoMerged.includes(update.branch)) continue;
    await gh("pr", "edit", String(update.prNumber), "--base", update.newBase);
    if (update.flipToReady) {
      await gh("pr", "ready", String(update.prNumber));
    }
    completed.prUpdated.push(update.prNumber);
    await writeLandResumeState(dir, stackName, completed);
  }

  // Close PRs whose branches were auto-merged by patch-id. Mirrors the TUI
  // executor's close phase so every PR state transition on a completed land
  // is recorded in GitHub.
  for (const update of plan.prUpdates) {
    if (!completed.autoMerged.includes(update.branch)) continue;
    if (completed.prClosed.includes(update.prNumber)) continue;
    await gh(
      "pr",
      "close",
      String(update.prNumber),
      "--comment",
      "auto-merged during stack land: every commit was already upstream",
    );
    completed.prClosed.push(update.prNumber);
    await writeLandResumeState(dir, stackName, completed);
  }

  if (!completed.navDone) {
    const repoInfo = await gh("repo", "view", "--json", "owner,name");
    const parsed = JSON.parse(repoInfo) as {
      owner: { login: string };
      name: string;
    };
    const navActions = await buildNavPlan(
      dir,
      stackName,
      parsed.owner.login,
      parsed.name,
    );
    for (const action of navActions) {
      await executeNavAction(parsed.owner.login, parsed.name, action);
    }
    completed.navDone = true;
    await writeLandResumeState(dir, stackName, completed);
  }

  if (!completed.configCleanupDone) {
    const mergedRoot = plan.branchesToDelete[0];
    await configLandCleanup(dir, stackName, mergedRoot);
    completed.configCleanupDone = true;
    await writeLandResumeState(dir, stackName, completed);
  }

  const mergedRoot = plan.branchesToDelete[0];
  const toDelete = [...plan.branchesToDelete, ...completed.autoMerged];
  await detachHeadFromDeleted(dir, toDelete);
  for (const branch of toDelete) {
    if (completed.deletedBranches.includes(branch)) continue;
    const { code: existsCode } = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    );
    if (existsCode !== 0) {
      completed.deletedBranches.push(branch);
      await writeLandResumeState(dir, stackName, completed);
      continue;
    }
    await runGitCommand(dir, "branch", "-D", branch);
    // Idempotent: configLandCleanup already tombstoned mergedRoot above.
    await addLandedBranch(dir, stackName, branch);
    if (branch !== mergedRoot) {
      await removeStackBranch(dir, branch);
    }
    completed.deletedBranches.push(branch);
    await writeLandResumeState(dir, stackName, completed);
  }

  await clearLandResumeState(dir, stackName);
  await restoreHead(dir, plan, {
    onProgress: () => {},
    freshPrStates: () => Promise.resolve(new Map()),
  });
  return {
    ok: true,
    plan,
    result: {
      plan,
      autoMergedBranches: [...completed.autoMerged],
      split: [],
    },
  };
}
