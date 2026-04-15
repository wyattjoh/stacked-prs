import {
  findNode,
  getAllNodes,
  getAllStackTrees,
  runGitCommand,
  type StackTree,
} from "../lib/stack.ts";
import { planRestack, restack } from "./restack.ts";
import type { RebasePlan, RestackResult } from "./restack.ts";
import { buildNavPlan } from "./nav.ts";
import type { NavAction } from "./nav.ts";
import { queryPr } from "./status.ts";
import type { PrInfo } from "./status.ts";
import type { LandPrUpdate } from "./land.ts";
import { resolveRepo } from "../lib/gh.ts";

// =========================================================================
// Types
// =========================================================================

export type BaseFfStatus =
  | "up-to-date"
  | "ff"
  | "skip-diverged"
  | "skip-ahead"
  | "no-origin";

export interface BaseFfPlan {
  branch: string;
  status: BaseFfStatus;
  localSha?: string;
  originSha?: string;
}

export interface BranchPruneStep {
  branch: string;
  prNumber: number;
  childReparents: Array<{
    branch: string;
    oldParent: string;
    newParent: string;
  }>;
  isCurrentBranch: boolean;
}

export interface StackSyncPlan {
  stackName: string;
  baseBranch: string;
  pruneSteps: BranchPruneStep[];
  prBaseUpdates: LandPrUpdate[];
  navUpdates: NavAction[];
  rebases: RebasePlan[];
  branchesToPush: string[];
  isNoOp: boolean;
}

export interface SyncPlan {
  baseFastForwards: BaseFfPlan[];
  stacks: StackSyncPlan[];
  /** Unique base branches across all stacks, to be fetched from origin. */
  baseBranches: string[];
  isNoOp: boolean;
}

export interface StackSyncResult {
  stackName: string;
  ok: boolean;
  prunedBranches?: string[];
  restack?: RestackResult;
  pushed?: string[];
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  fetched: string[];
  fastForwarded: string[];
  stacks: StackSyncResult[];
  /** The stack that failed, if any. Subsequent stacks are skipped. */
  failedAt?: string;
}

// =========================================================================
// Helpers
// =========================================================================

async function tryRevParse(
  dir: string,
  ref: string,
): Promise<string | undefined> {
  const result = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  );
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function isAncestor(
  dir: string,
  a: string,
  b: string,
): Promise<boolean> {
  const result = await runGitCommand(dir, "merge-base", "--is-ancestor", a, b);
  return result.code === 0;
}

async function getCurrentBranch(dir: string): Promise<string | null> {
  const { code, stdout } = await runGitCommand(
    dir,
    "symbolic-ref",
    "--short",
    "HEAD",
  );
  if (code !== 0) return null;
  const name = stdout.trim();
  return name.length > 0 ? name : null;
}

async function planBaseFastForward(
  dir: string,
  base: string,
): Promise<BaseFfPlan | undefined> {
  const localSha = await tryRevParse(dir, base);
  if (!localSha) return undefined;

  const originSha = await tryRevParse(dir, `origin/${base}`);
  if (!originSha) {
    return { branch: base, status: "no-origin", localSha };
  }

  if (localSha === originSha) {
    return { branch: base, status: "up-to-date", localSha, originSha };
  }

  if (await isAncestor(dir, localSha, originSha)) {
    return { branch: base, status: "ff", localSha, originSha };
  }

  if (await isAncestor(dir, originSha, localSha)) {
    return { branch: base, status: "skip-ahead", localSha, originSha };
  }

  return { branch: base, status: "skip-diverged", localSha, originSha };
}

function computeNewParents(
  tree: StackTree,
  mergedSet: Set<string>,
): Map<string, string> {
  const result = new Map<string, string>();
  const base = tree.baseBranch;
  for (const node of getAllNodes(tree)) {
    if (mergedSet.has(node.branch)) continue;
    let ancestor = node.parent;
    while (ancestor !== base && mergedSet.has(ancestor)) {
      const ancestorNode = findNode(tree, ancestor);
      ancestor = ancestorNode?.parent ?? base;
    }
    if (ancestor !== node.parent) {
      result.set(node.branch, ancestor);
    }
  }
  return result;
}

// =========================================================================
// Stack-level planner
// =========================================================================

async function planStackSync(
  dir: string,
  tree: StackTree,
  owner: string | undefined,
  repo: string | undefined,
  currentBranch: string | null,
): Promise<StackSyncPlan> {
  const stackName = tree.stackName;
  const baseBranch = tree.baseBranch;
  const liveNodes = getAllNodes(tree).filter((n) => !n.merged);

  // Query PRs for every live node. queryPr returns null on missing/closed-only;
  // treat any thrown error as "no PR known" so a single bad query doesn't abort
  // the whole plan.
  const prByBranch = new Map<string, PrInfo | null>();
  await Promise.all(
    liveNodes.map(async (node) => {
      try {
        const pr = await queryPr(node.branch, owner, repo);
        prByBranch.set(node.branch, pr);
      } catch {
        prByBranch.set(node.branch, null);
      }
    }),
  );

  const mergedSet = new Set<string>();
  for (const [branch, pr] of prByBranch) {
    if (pr?.state?.toUpperCase() === "MERGED") mergedSet.add(branch);
  }

  const newParentByBranch = computeNewParents(tree, mergedSet);

  // Build prune steps in topological order (parents before children).
  const pruneSteps: BranchPruneStep[] = [];
  for (const node of getAllNodes(tree)) {
    if (!mergedSet.has(node.branch)) continue;
    const pr = prByBranch.get(node.branch);
    if (!pr) continue;
    const childReparents = node.children
      .filter((c) => !mergedSet.has(c.branch))
      .map((c) => ({
        branch: c.branch,
        oldParent: c.parent,
        newParent: newParentByBranch.get(c.branch) ?? c.parent,
      }));
    pruneSteps.push({
      branch: node.branch,
      prNumber: pr.number,
      childReparents,
      isCurrentBranch: currentBranch === node.branch,
    });
  }

  // PR base-change updates for surviving children whose parent changed.
  const prBaseUpdates: LandPrUpdate[] = [];
  for (const [branch, newParent] of newParentByBranch) {
    const pr = prByBranch.get(branch);
    if (!pr) continue;
    const node = findNode(tree, branch);
    if (!node) continue;
    prBaseUpdates.push({
      branch,
      prNumber: pr.number,
      oldBase: node.parent,
      newBase: newParent,
      wasDraft: pr.isDraft,
      flipToReady: pr.isDraft && newParent === baseBranch,
    });
  }

  // Feed the pruned/reparented topology to the restack planner so rebase
  // targets reflect the final tree. Swallow plan failures (e.g. missing refs)
  // and surface as an empty plan so the caller can still inspect prune steps.
  const excludeBranches = Array.from(mergedSet);
  const reparented = Object.fromEntries(newParentByBranch);
  let rebases: RebasePlan[] = [];
  try {
    const plan = await planRestack(dir, stackName, {
      excludeBranches,
      reparented,
    });
    rebases = plan.rebases;
  } catch {
    rebases = [];
  }
  const branchesToPush = rebases
    .filter((r) => r.status === "planned")
    .map((r) => r.branch);

  let navUpdates: NavAction[] = [];
  if (owner && repo) {
    try {
      navUpdates = await buildNavPlan(dir, stackName, owner, repo, {
        excludeBranches,
        reparented,
      });
    } catch {
      navUpdates = [];
    }
  }

  const isNoOp = pruneSteps.length === 0 &&
    prBaseUpdates.length === 0 &&
    navUpdates.length === 0 &&
    branchesToPush.length === 0;

  return {
    stackName,
    baseBranch,
    pruneSteps,
    prBaseUpdates,
    navUpdates,
    rebases,
    branchesToPush,
    isNoOp,
  };
}

// =========================================================================
// Top-level planner
// =========================================================================

/**
 * Build a cross-stack sync plan. Does not mutate the repo: collects merged-PR
 * pruning, base fast-forward status, child reparenting, PR base updates,
 * restack targets, and nav comment updates per stack so the caller can
 * present the full plan before deciding whether to execute.
 */
export async function computeSyncPlan(dir: string): Promise<SyncPlan> {
  const trees = await getAllStackTrees(dir);

  const baseSet = new Set<string>();
  for (const tree of trees) baseSet.add(tree.baseBranch);
  const baseBranches = Array.from(baseSet).sort();

  const baseFastForwards: BaseFfPlan[] = [];
  for (const base of baseBranches) {
    const plan = await planBaseFastForward(dir, base);
    if (plan) baseFastForwards.push(plan);
  }

  // Resolve owner/repo once. If gh isn't configured (no remote, offline, etc.)
  // we fall back to unscoped queryPr / no nav plan; pruning still works.
  let owner: string | undefined;
  let repo: string | undefined;
  try {
    const resolved = await resolveRepo();
    owner = resolved.owner;
    repo = resolved.repo;
  } catch {
    owner = undefined;
    repo = undefined;
  }

  const currentBranch = await getCurrentBranch(dir);

  const stacks: StackSyncPlan[] = [];
  for (const tree of trees) {
    const plan = await planStackSync(dir, tree, owner, repo, currentBranch);
    stacks.push(plan);
  }

  const isNoOp = stacks.every((s) => s.isNoOp) &&
    baseFastForwards.every(
      (ff) => ff.status === "up-to-date" || ff.status === "no-origin",
    );

  return {
    baseFastForwards,
    stacks,
    baseBranches,
    isNoOp,
  };
}

// =========================================================================
// Executor
// =========================================================================

/**
 * Execute a full cross-stack sync.
 *
 * TODO(sync-rewrite): this is a transitional stub covering only the
 * rebase+push path. The merged-PR pruning executor (PR base edits, branch
 * deletion, nav comment writes) lands in a follow-up task. Pruning plans
 * surface in the rendered output and can be actioned manually via `land`
 * and `nav` for now.
 */
export async function executeSync(
  dir: string,
  plan: SyncPlan,
): Promise<SyncResult> {
  const result: SyncResult = {
    ok: true,
    fetched: [],
    fastForwarded: [],
    stacks: [],
  };

  for (const base of plan.baseBranches) {
    const fetch = await runGitCommand(dir, "fetch", "origin", base);
    if (fetch.code !== 0) {
      return {
        ...result,
        ok: false,
        failedAt: `fetch origin ${base}`,
        stacks: [],
      };
    }
    result.fetched.push(base);
  }

  for (const stackPlan of plan.stacks) {
    if (stackPlan.isNoOp) {
      result.stacks.push({ stackName: stackPlan.stackName, ok: true });
      continue;
    }

    const restackResult = await restack(dir, stackPlan.stackName, {});
    if (!restackResult.ok) {
      result.stacks.push({
        stackName: stackPlan.stackName,
        ok: false,
        restack: restackResult,
        error: restackResult.error ?? "restack failed",
      });
      result.ok = false;
      result.failedAt = stackPlan.stackName;
      return result;
    }

    if (stackPlan.branchesToPush.length > 0) {
      const pushResult = await runGitCommand(
        dir,
        "push",
        "--force-with-lease",
        "origin",
        ...stackPlan.branchesToPush,
      );
      if (pushResult.code !== 0) {
        result.stacks.push({
          stackName: stackPlan.stackName,
          ok: false,
          restack: restackResult,
          error: `git push failed: ${pushResult.stderr || pushResult.stdout}`,
        });
        result.ok = false;
        result.failedAt = stackPlan.stackName;
        return result;
      }
    }

    result.stacks.push({
      stackName: stackPlan.stackName,
      ok: true,
      restack: restackResult,
      pushed: stackPlan.branchesToPush,
    });
  }

  return result;
}

// =========================================================================
// Renderer
// =========================================================================

function renderBaseFastForward(ff: BaseFfPlan): string {
  switch (ff.status) {
    case "up-to-date":
      return `  · ${ff.branch} (up to date)`;
    case "ff":
      return `  → ${ff.branch} (fast-forward from origin)`;
    case "skip-ahead":
      return `  · ${ff.branch} (local ahead of origin; nothing to do)`;
    case "skip-diverged":
      return `  ⚠ ${ff.branch} has diverged from origin/${ff.branch}; skipping fast-forward. Rebases will target origin/${ff.branch}.`;
    case "no-origin":
      return `  · ${ff.branch} (no origin tracking)`;
  }
}

/** Render a sync plan as a human-readable summary. */
export function renderSyncPlan(plan: SyncPlan): string {
  if (plan.isNoOp) {
    return "All stacks are already synced with origin. Nothing to do.";
  }

  const lines: string[] = [];

  if (plan.baseFastForwards.length > 0) {
    lines.push("Base branches:");
    for (const ff of plan.baseFastForwards) {
      lines.push(renderBaseFastForward(ff));
    }
    lines.push("");
  }

  for (const s of plan.stacks) {
    lines.push(`Stack: ${s.stackName} (base: ${s.baseBranch})`);
    if (s.isNoOp) {
      lines.push("  up to date");
      continue;
    }
    for (const p of s.pruneSteps) {
      lines.push(`  - Delete ${p.branch} (PR #${p.prNumber}, merged)`);
      for (const r of p.childReparents) {
        lines.push(`    ↳ ${r.branch}: ${r.oldParent} → ${r.newParent}`);
      }
    }
    for (const u of s.prBaseUpdates) {
      lines.push(
        `  - Retarget PR #${u.prNumber}: ${u.oldBase} → ${u.newBase}`,
      );
    }
    for (const r of s.rebases) {
      const icon = r.status === "planned" ? "→" : "·";
      lines.push(`  ${icon} ${r.branch}  onto ${r.newTarget}`);
    }
    if (s.branchesToPush.length > 0) {
      lines.push(
        `  Push (--force-with-lease): ${s.branchesToPush.join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}
