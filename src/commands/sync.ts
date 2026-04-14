import { getAllStackTrees, runGitCommand } from "../lib/stack.ts";
import { planRestack, restack } from "./restack.ts";
import type { RebasePlan, RestackResult } from "./restack.ts";

export interface StackSyncPlan {
  stackName: string;
  baseBranch: string;
  rebases: RebasePlan[];
  /** Branches that will need a force-with-lease push after the restack. */
  branchesToPush: string[];
  isNoOp: boolean;
}

export interface SyncPlan {
  stacks: StackSyncPlan[];
  /** Unique base branches across all stacks, to be fetched from origin. */
  baseBranches: string[];
  /** True when every stack is already clean and there is nothing to push. */
  isNoOp: boolean;
}

export interface StackSyncResult {
  stackName: string;
  ok: boolean;
  restack?: RestackResult;
  pushed?: string[];
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  fetched: string[];
  stacks: StackSyncResult[];
  /** The stack that failed, if any. Subsequent stacks are skipped. */
  failedAt?: string;
}

/**
 * Build a cross-stack sync plan. Does not mutate the repo: runs the restack
 * planner per stack so the caller can present the full plan before deciding
 * whether to execute. Skips stacks that would fail to plan (e.g. references
 * missing branches) by including them as `isNoOp: true` with an empty rebases
 * list; the caller should run `clean` to investigate.
 */
export async function computeSyncPlan(dir: string): Promise<SyncPlan> {
  const trees = await getAllStackTrees(dir);
  const stacks: StackSyncPlan[] = [];
  const baseSet = new Set<string>();

  for (const tree of trees) {
    baseSet.add(tree.baseBranch);
    try {
      const plan = await planRestack(dir, tree.stackName, {});
      const branchesToPush = plan.rebases
        .filter((r) => r.status === "planned")
        .map((r) => r.branch);
      stacks.push({
        stackName: tree.stackName,
        baseBranch: tree.baseBranch,
        rebases: plan.rebases,
        branchesToPush,
        isNoOp: branchesToPush.length === 0,
      });
    } catch (_err) {
      // Plan failure (e.g. missing refs). Surface as a no-op entry so the
      // caller can see the stack was skipped without aborting the whole sync.
      stacks.push({
        stackName: tree.stackName,
        baseBranch: tree.baseBranch,
        rebases: [],
        branchesToPush: [],
        isNoOp: true,
      });
    }
  }

  return {
    stacks,
    baseBranches: Array.from(baseSet).sort(),
    isNoOp: stacks.every((s) => s.isNoOp),
  };
}

/**
 * Execute a full cross-stack sync: fetch each base branch from origin once,
 * then for each stack run `restack` and force-push the rebased branches. Stops
 * at the first failure (conflict, push failure, or unexpected error) so the
 * user can resolve before continuing.
 */
export async function executeSync(
  dir: string,
  plan: SyncPlan,
): Promise<SyncResult> {
  const result: SyncResult = { ok: true, fetched: [], stacks: [] };

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

    // Determine which branches actually moved during this restack and push
    // them. We trust the plan's branchesToPush list: the restack walk may
    // cascade additional branches, but the planner already did that analysis
    // in planRestack, so the two lists should agree.
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

/** Render a sync plan as a human-readable summary. */
export function renderSyncPlan(plan: SyncPlan): string {
  const lines: string[] = [];
  if (plan.isNoOp) {
    lines.push("All stacks are already synced with origin. Nothing to do.");
    return lines.join("\n");
  }
  lines.push(
    `Fetch from origin: ${plan.baseBranches.join(", ")}`,
  );
  lines.push("");
  for (const s of plan.stacks) {
    lines.push(`Stack: ${s.stackName} (base: ${s.baseBranch})`);
    if (s.isNoOp) {
      lines.push("  up to date");
      continue;
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
