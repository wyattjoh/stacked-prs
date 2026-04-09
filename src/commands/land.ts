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
import {
  findNode,
  getAllNodes,
  getStackTree,
  removeStackBranch,
  runGitCommand,
  type StackTree,
} from "../lib/stack.ts";
import { topologicalOrder } from "./restack.ts";

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
  const landCase = classifyLandCase(tree, prStateByBranch);

  const snapshot = await captureSnapshot(dir, tree);
  const originalHeadRef = await captureOriginalHead(dir);

  const mergedBranches = getAllNodes(tree)
    .filter((n) => prStateByBranch.get(n.branch) === "MERGED")
    .map((n) => n.branch);

  if (landCase === "all-merged") {
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
      snapshot,
      originalHeadRef,
      splitPreview: [],
    };
  }

  // root-merged
  const mergedRoot = tree.roots[0].branch;

  const rebaseSteps = buildRebaseSteps(tree, snapshot, mergedRoot);
  const pushSteps = buildPushSteps(tree, snapshot, mergedRoot);
  const prUpdates = buildPrUpdateSteps(tree, prInfoByBranch, mergedRoot);
  const preview = previewLandCleanup(tree, mergedRoot);

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
    snapshot,
    originalHeadRef,
    splitPreview: preview.splits,
  };
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

async function unsetConfig(dir: string, key: string): Promise<void> {
  await runGitCommand(dir, "config", "--unset", key);
}

async function executeCaseBCleanup(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
): Promise<LandResult> {
  // Leaves-first: reverse the DFS order stored in branchesToDelete.
  const order = [...plan.branchesToDelete].reverse();
  for (const branch of order) {
    emit(hooks, { kind: "delete", branch }, "running");
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

  await unsetConfig(dir, `stack.${plan.stackName}.merge-strategy`);
  await unsetConfig(dir, `stack.${plan.stackName}.base-branch`);
  await unsetConfig(dir, `stack.${plan.stackName}.resume-state`);

  emit(hooks, { kind: "restore-head" }, "running");
  const ref = plan.originalHeadRef;
  if (ref.startsWith("refs/")) {
    const branchName = ref.replace(/^refs\/heads\//, "");
    const { code, stderr } = await runGitCommand(dir, "checkout", branchName);
    if (code !== 0) {
      emit(hooks, { kind: "restore-head" }, "failed", stderr);
    } else {
      emit(hooks, { kind: "restore-head" }, "ok");
    }
  } else {
    const { code, stderr } = await runGitCommand(
      dir,
      "checkout",
      "--detach",
      ref,
    );
    if (code !== 0) {
      emit(hooks, { kind: "restore-head" }, "failed", stderr);
    } else {
      emit(hooks, { kind: "restore-head" }, "ok");
    }
  }

  return { plan, autoMergedBranches: [], split: [] };
}

export async function executeLand(
  dir: string,
  plan: LandPlan,
  hooks: LandHooks,
): Promise<LandResult> {
  emit(hooks, { kind: "preflight" }, "running");
  const allBranches = plan.snapshot.map((s) => s.branch);
  const preflight = await runLandPreflight(dir, allBranches);
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
  emit(hooks, { kind: "preflight" }, "ok");

  if (plan.case === "all-merged") {
    return await executeCaseBCleanup(dir, plan, hooks);
  }

  // Case A (root-merged) implementation arrives in Tasks 15-23.
  throw new Error("executeLand: root-merged case not yet implemented");
}
