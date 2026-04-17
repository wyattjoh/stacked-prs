import { globToRegExp } from "@std/path";
import {
  findNode,
  getAllNodes,
  getAllStackTrees,
  runGitCommand,
  type StackTree,
  tryResolveRef,
} from "../lib/stack.ts";
import { planRestack, restack } from "./restack.ts";
import type { RebasePlan, RestackResult } from "./restack.ts";
import { buildNavPlan, executeNavAction } from "../lib/nav.ts";
import type { NavAction } from "../lib/nav.ts";
import { queryPr } from "./status.ts";
import type { PrInfo } from "./status.ts";
import type { LandPrUpdate } from "./land.ts";
import { gh, resolveRepoOrNone } from "../lib/gh.ts";
import {
  configBranchCleanup,
  projectTreeAfterRemoval,
} from "../lib/cleanup.ts";

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
  /** Branches the restack planner was told to exclude (merged tombstones). */
  excludeBranches: string[];
  /** Per-branch parent overrides applied when planning the restack. */
  reparented: Record<string, string>;
  isNoOp: boolean;
}

export interface SyncPlan {
  baseFastForwards: BaseFfPlan[];
  stacks: StackSyncPlan[];
  /** Unique base branches across all stacks, to be fetched from origin. */
  baseBranches: string[];
  isNoOp: boolean;
  /** The filter expression applied, if any. */
  filter?: string;
  /** Stack names that existed but were filtered out, for reporting. */
  filteredOut: string[];
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

/**
 * Split a `--filter` expression into its positive and negative glob patterns.
 * Patterns are comma-separated; a leading `!` marks a negation. Whitespace
 * around each entry is trimmed and empty entries are discarded so trailing
 * commas and spaces are tolerated.
 */
export function parseStackFilter(
  filter: string,
): { includes: string[]; excludes: string[] } {
  const parts = filter.split(",").map((s) => s.trim()).filter(
    (s) => s.length > 0,
  );
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const p of parts) {
    if (p.startsWith("!")) {
      const rest = p.slice(1).trim();
      if (rest.length > 0) excludes.push(rest);
    } else {
      includes.push(p);
    }
  }
  return { includes, excludes };
}

/**
 * Test a stack name against a `--filter` expression. An undefined or empty
 * filter matches everything. Pure negative filters (e.g. `!di*`) match every
 * name that is not excluded; mixed filters require at least one positive match
 * and no excludes hitting.
 */
export function stackNameMatchesFilter(
  name: string,
  filter: string | undefined,
): boolean {
  if (!filter) return true;
  const { includes, excludes } = parseStackFilter(filter);
  if (includes.length === 0 && excludes.length === 0) return true;
  const included = includes.length === 0 ||
    includes.some((g) => globToRegExp(g).test(name));
  if (!included) return false;
  return !excludes.some((g) => globToRegExp(g).test(name));
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
  const localSha = await tryResolveRef(dir, base);
  if (!localSha) return undefined;

  const originSha = await tryResolveRef(dir, `origin/${base}`);
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

  const newParentByBranch = projectTreeAfterRemoval(tree, mergedSet).newParents;

  // Build prune steps in topological order (parents before children).
  const pruneSteps: BranchPruneStep[] = [];
  for (const node of getAllNodes(tree)) {
    if (!mergedSet.has(node.branch)) continue;
    const pr = prByBranch.get(node.branch);
    if (!pr) continue;
    pruneSteps.push({
      branch: node.branch,
      prNumber: pr.number,
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

  // Build the nav preview with `markMerged` so the rendered markdown
  // matches what the executor's post-tombstone recompute will produce
  // (merged branches render as `~~#N~~` with their live children nested
  // beneath). Seed PR numbers from the state query for branches that
  // aren't yet recorded in `landed-pr`.
  const prOverrides = new Map<string, number>();
  for (const branch of mergedSet) {
    const pr = prByBranch.get(branch);
    if (pr) prOverrides.set(branch, pr.number);
  }
  let navUpdates: NavAction[] = [];
  if (owner && repo) {
    try {
      navUpdates = await buildNavPlan(dir, stackName, owner, repo, {
        markMerged: Array.from(mergedSet),
        prOverrides,
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
    excludeBranches,
    reparented,
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
 *
 * Pass `options.filter` to restrict the plan to a subset of stacks by name.
 * The filter is a comma-separated list of globs; entries starting with `!`
 * are negations. Only matching stacks are planned, and only those stacks'
 * base branches are fetched / fast-forwarded.
 */
export async function computeSyncPlan(
  dir: string,
  options: { filter?: string } = {},
): Promise<SyncPlan> {
  const filter = options.filter;
  const allTrees = await getAllStackTrees(dir);

  const trees: StackTree[] = [];
  const filteredOut: string[] = [];
  for (const tree of allTrees) {
    if (stackNameMatchesFilter(tree.stackName, filter)) {
      trees.push(tree);
    } else {
      filteredOut.push(tree.stackName);
    }
  }

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
  const resolved = await resolveRepoOrNone();
  const owner = resolved?.owner;
  const repo = resolved?.repo;

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
    filter,
    filteredOut,
  };
}

// =========================================================================
// Executor
// =========================================================================

/**
 * Execute a full cross-stack sync.
 *
 * Flow per invocation:
 *   1. Fetch every distinct base from origin. Any fetch failure short-circuits.
 *   2. Fast-forward local base branches that are strictly behind origin. If
 *      the user is on a base branch, use `git merge --ff-only`; otherwise
 *      update the ref directly without touching the working tree.
 *   3. For each stack, in order:
 *      a. Apply PR base updates (`gh pr edit --base`, optional `pr ready`).
 *      b. Apply nav comment updates via `executeNavAction`.
 *      c. Prune each merged branch: checkout base if needed, reparent
 *         children via `configBranchCleanup`, then `git branch -D`.
 *      d. Restack with the same excludeBranches/reparented overrides the
 *         planner used so rebase targets match the post-prune topology.
 *      e. Force-push updated branches with `--force-with-lease`.
 *   Any failure within a stack marks the result as not-ok and stops the
 *   executor; subsequent stacks are skipped entirely.
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

  // Fast-forward local base branches where safe. `skip-diverged`,
  // `skip-ahead`, `up-to-date`, and `no-origin` are all intentional no-ops:
  // the renderer already warned the user about divergence.
  const currentBranch = await getCurrentBranch(dir);
  for (const ff of plan.baseFastForwards) {
    if (ff.status !== "ff") continue;
    if (currentBranch === ff.branch) {
      const merge = await runGitCommand(
        dir,
        "merge",
        "--ff-only",
        `origin/${ff.branch}`,
      );
      if (merge.code !== 0) continue;
    } else {
      if (!ff.originSha) continue;
      const update = await runGitCommand(
        dir,
        "update-ref",
        `refs/heads/${ff.branch}`,
        ff.originSha,
      );
      if (update.code !== 0) continue;
    }
    result.fastForwarded.push(ff.branch);
  }

  // Resolve owner/repo once for gh mutations. If resolution fails we can
  // still run prune + restack + push; PR edits and nav updates will be
  // skipped rather than error the entire sync.
  const resolved = await resolveRepoOrNone();
  const owner = resolved?.owner;
  const repo = resolved?.repo;

  for (const stackPlan of plan.stacks) {
    if (stackPlan.isNoOp) {
      result.stacks.push({ stackName: stackPlan.stackName, ok: true });
      continue;
    }

    const stackResult: StackSyncResult = {
      stackName: stackPlan.stackName,
      ok: true,
      prunedBranches: [],
    };

    const fail = (error: string, extras: Partial<StackSyncResult> = {}) => {
      stackResult.ok = false;
      stackResult.error = error;
      Object.assign(stackResult, extras);
      result.stacks.push(stackResult);
      result.ok = false;
      result.failedAt = stackPlan.stackName;
      return result;
    };

    // 1. PR base edits (and flip-to-ready if needed). Done before any
    // destructive local operations so a partial run still leaves GitHub
    // in a consistent state relative to what's about to happen locally.
    if (owner && repo) {
      for (const update of stackPlan.prBaseUpdates) {
        try {
          await gh(
            "pr",
            "edit",
            String(update.prNumber),
            "--base",
            update.newBase,
            "--repo",
            `${owner}/${repo}`,
          );
          if (update.flipToReady) {
            await gh(
              "pr",
              "ready",
              String(update.prNumber),
              "--repo",
              `${owner}/${repo}`,
            );
          }
        } catch (err) {
          return fail(
            `gh pr edit #${update.prNumber} failed: ${(err as Error).message}`,
          );
        }
      }
    }

    // 2. Tombstone merged branches and delete their local refs. Tombstones
    // retain their branch-level stack-name/stack-parent config so live
    // children keep their recorded parent link; `getStackTree` now reads
    // the merge marker from `stack.<n>.landed-branches` and renders them
    // as structural merged nodes.
    let switchedToBase = false;
    for (const step of stackPlan.pruneSteps) {
      if (step.isCurrentBranch && !switchedToBase) {
        const co = await runGitCommand(
          dir,
          "checkout",
          stackPlan.baseBranch,
        );
        if (co.code !== 0) {
          return fail(
            `git checkout ${stackPlan.baseBranch} failed: ${co.stderr.trim()}`,
          );
        }
        switchedToBase = true;
      }

      try {
        await configBranchCleanup(dir, stackPlan.stackName, step.branch);
      } catch (err) {
        return fail(
          `configBranchCleanup(${step.branch}) failed: ${
            (err as Error).message
          }`,
        );
      }

      const del = await runGitCommand(dir, "branch", "-D", step.branch);
      if (del.code !== 0) {
        return fail(
          `git branch -D ${step.branch} failed: ${del.stderr.trim()}`,
        );
      }
      stackResult.prunedBranches!.push(step.branch);
    }

    // 3. Nav comment updates, recomputed against the post-tombstone tree
    // so the rendered markdown shows newly-landed branches with their
    // recorded children still nested beneath them.
    if (owner && repo) {
      try {
        const freshNavActions = await buildNavPlan(
          dir,
          stackPlan.stackName,
          owner,
          repo,
        );
        for (const action of freshNavActions) {
          await executeNavAction(owner, repo, action);
        }
      } catch (err) {
        return fail(
          `nav refresh failed: ${(err as Error).message}`,
        );
      }
    }

    // 4. Restack against the post-tombstone tree. `topologicalOrder`
    // naturally skips merged nodes and `effectiveParent` walks through
    // them, so no explicit overlay is needed here.
    const restackResult = await restack(dir, stackPlan.stackName, {});
    stackResult.restack = restackResult;
    if (!restackResult.ok) {
      return fail(restackResult.error ?? "restack failed");
    }

    // 5. Force-push updated branches together so GitHub sees the retarget
    // and the new tips in a single round-trip.
    if (stackPlan.branchesToPush.length > 0) {
      const pushResult = await runGitCommand(
        dir,
        "push",
        "--force-with-lease",
        "origin",
        ...stackPlan.branchesToPush,
      );
      if (pushResult.code !== 0) {
        return fail(
          `git push failed: ${pushResult.stderr || pushResult.stdout}`,
        );
      }
      stackResult.pushed = stackPlan.branchesToPush;
    }

    result.stacks.push(stackResult);
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
  if (plan.filter && plan.stacks.length === 0) {
    return `No stacks match --filter=${plan.filter}. Nothing to do.`;
  }

  if (plan.isNoOp) {
    const suffix = plan.filter ? ` (filter: ${plan.filter})` : "";
    return `All stacks are already synced with origin${suffix}. Nothing to do.`;
  }

  const lines: string[] = [];

  if (plan.filter) {
    lines.push(`Filter: ${plan.filter}`);
    if (plan.filteredOut.length > 0) {
      lines.push(`  · skipped: ${plan.filteredOut.join(", ")}`);
    }
    lines.push("");
  }

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
      lines.push(`  - Tombstone ${p.branch} (PR #${p.prNumber}, merged)`);
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
