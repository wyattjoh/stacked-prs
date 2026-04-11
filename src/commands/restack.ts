import {
  findNode,
  getConflictFiles,
  getStackTree,
  rebaseInProgress,
  revParse,
  runGitCommand,
  type StackNode,
  type StackTree,
} from "../lib/stack.ts";
import { checkWorktreeSafety } from "../lib/worktrees.ts";

// =========================================================================
// Per-branch rebase implementation (spec: 2026-04-08-restack-correctness)
// =========================================================================

export type RebaseStatus =
  | "planned"
  | "skipped-clean"
  | "rebased"
  | "conflict"
  | "skipped-due-to-conflict";

export interface RebasePlan {
  branch: string;
  /** The parent SHA captured before any rebases ran. */
  oldParentSha: string;
  /** The rebase target (e.g. "origin/main" or a parent branch name). */
  newTarget: string;
  status: RebaseStatus;
  conflictFiles?: string[];
  stderr?: string;
}

export interface RestackResult {
  ok: boolean;
  error?: "conflict" | "other";
  rebases: RebasePlan[];
  recovery?: {
    resolve: string;
    abort: string;
    resume: string;
  };
}

/** DFS topological order over the filtered tree (parents before children). */
export function topologicalOrder(tree: StackTree): StackNode[] {
  const order: StackNode[] = [];
  const walk = (node: StackNode): void => {
    if (!node.merged) {
      order.push(node);
    }
    // Deterministic child order: already sorted alphabetically by getStackTree
    for (const child of node.children) walk(child);
  };
  for (const root of tree.roots) walk(root);
  return order;
}

export interface RestackOptions {
  upstackFrom?: string;
  downstackFrom?: string;
  only?: string;
  resume?: boolean;
  /** Bypass the worktree safety precheck. Used by tests that set up dirty state on purpose. */
  skipWorktreeCheck?: boolean;
}

interface ResumeState {
  stackName: string;
  opts: RestackOptions;
  oldParentSha: Record<string, string>;
  /**
   * Branch tip SHA captured at plan time. On resume, we verify each branch's
   * current tip still matches (modulo branches we've already rebased) so that
   * a force-push between sessions is detected before `git rebase --onto` is
   * invoked with a stale snapshot.
   */
  branchTipSha: Record<string, string>;
  completed: string[];
  /** Branch that was mid-rebase when the last executeRestack hit a conflict. */
  conflictedBranch?: string;
}

async function readResumeState(
  dir: string,
  stackName: string,
): Promise<ResumeState | null> {
  const { code, stdout } = await runGitCommand(
    dir,
    "config",
    `stack.${stackName}.resume-state`,
  );
  if (code !== 0) return null;
  try {
    return JSON.parse(stdout.trim()) as ResumeState;
  } catch {
    return null;
  }
}

async function writeResumeState(
  dir: string,
  stackName: string,
  state: ResumeState,
): Promise<void> {
  await runGitCommand(
    dir,
    "config",
    `stack.${stackName}.resume-state`,
    JSON.stringify(state),
  );
}

async function clearResumeState(
  dir: string,
  stackName: string,
): Promise<void> {
  await runGitCommand(
    dir,
    "config",
    "--unset",
    `stack.${stackName}.resume-state`,
  );
}

/**
 * Filter the tree into the set of nodes that are in scope for this restack.
 * Shared by the dry-run planner and the executor so both apply the same
 * scope semantics for `--upstack-from`, `--downstack-from`, and `--only`.
 */
function filterNodes(
  tree: StackTree,
  opts: RestackOptions,
): StackNode[] {
  const all = topologicalOrder(tree);
  if (!opts.upstackFrom && !opts.downstackFrom && !opts.only) {
    return all;
  }

  if (opts.only) {
    return all.filter((n) => n.branch === opts.only);
  }

  if (opts.upstackFrom) {
    const target = findNode(tree, opts.upstackFrom);
    if (!target) return [];
    const included = new Set<string>();
    const collect = (node: StackNode): void => {
      included.add(node.branch);
      for (const child of node.children) collect(child);
    };
    collect(target);
    return all.filter((n) => included.has(n.branch));
  }

  if (opts.downstackFrom) {
    // Nodes on the path from a root to the target, inclusive.
    const path = new Set<string>();
    const findPath = (node: StackNode, trail: string[]): boolean => {
      const nextTrail = [...trail, node.branch];
      if (node.branch === opts.downstackFrom) {
        for (const b of nextTrail) path.add(b);
        return true;
      }
      for (const child of node.children) {
        if (findPath(child, nextTrail)) return true;
      }
      return false;
    };
    for (const root of tree.roots) findPath(root, []);
    return all.filter((n) => path.has(n.branch));
  }

  return all;
}

/**
 * Resolve the rebase target for a node. Root nodes (parent === base branch)
 * target `origin/<base>`; non-root nodes target the parent branch name.
 */
function resolveTarget(node: StackNode, tree: StackTree): string {
  if (node.parent === tree.baseBranch) {
    return `origin/${tree.baseBranch}`;
  }
  return node.parent;
}

/**
 * Return branch names from `branches` whose local refs do not exist.
 * Uses `refs/heads/<branch>` so the probe is unambiguous (it won't match a
 * tag, remote-tracking ref, or unrelated object).
 */
async function findMissingRefs(
  dir: string,
  branches: Iterable<string>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const branch of branches) {
    const probe = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    );
    if (probe.code !== 0) {
      missing.push(branch);
    }
  }
  return missing;
}

async function findMissingBranches(
  dir: string,
  tree: StackTree,
): Promise<string[]> {
  return await findMissingRefs(
    dir,
    topologicalOrder(tree).map((n) => n.branch),
  );
}

/**
 * Compute the full rebase plan without mutating the repo.
 */
export async function planRestack(
  dir: string,
  stackName: string,
  opts: RestackOptions,
): Promise<RestackResult> {
  const tree = await getStackTree(dir, stackName);

  const missing = await findMissingBranches(dir, tree);
  if (missing.length > 0) {
    const lines = missing.map((b) => `  - ${b}`).join("\n");
    const cleanupLines = missing
      .map((b) =>
        `  git config --unset branch.${b}.stack-name && git config --unset branch.${b}.stack-parent`
      )
      .join("\n");
    throw new Error(
      `Stack "${stackName}" references ${missing.length} branch(es) that no longer exist:\n` +
        `${lines}\n\n` +
        `Either recreate the branch(es), or remove them from the stack:\n` +
        `${cleanupLines}`,
    );
  }

  const nodes = filterNodes(tree, opts);

  // Snapshot every in-scope node's parent SHA before any mutation. The
  // boundary ref is the node's tree parent (another stack branch, or the base
  // branch for a root node). Using the branch name rather than `origin/<base>`
  // captures commits that were on the parent at plan time regardless of
  // whether origin has advanced further.
  const oldParentSha = new Map<string, string>();
  for (const node of nodes) {
    const sha = await revParse(dir, node.parent);
    oldParentSha.set(node.branch, sha);
  }

  // Walk nodes in topological order so we can cascade "planned" status from
  // a parent to its descendants: if a branch will be rebased, every branch
  // that stacks on top of it must also be rebased even if it's locally clean
  // relative to its current parent ref.
  const plannedBranches = new Set<string>();
  const rebases: RebasePlan[] = [];
  for (const node of nodes) {
    const target = resolveTarget(node, tree);
    const branchSha = await revParse(dir, node.branch);

    // For the ancestor check we need the target ref to actually resolve.
    // Root nodes use `origin/<base>`, which may not exist in tests or repos
    // without an origin remote. Fall back to the local parent ref in that
    // case so the dry-run stays read-only and doesn't require a remote.
    let targetRef = target;
    const targetResolve = await runGitCommand(dir, "rev-parse", targetRef);
    if (targetResolve.code !== 0) {
      targetRef = node.parent;
    }
    const targetSha = await revParse(dir, targetRef);

    // Locally clean if target is already an ancestor of the branch.
    const isAncestorResult = await runGitCommand(
      dir,
      "merge-base",
      "--is-ancestor",
      targetSha,
      branchSha,
    );
    const locallyClean = isAncestorResult.code === 0;

    // Cascade: if this node's tree parent is planned, this node must also be
    // planned even if it's locally clean, because the parent will move.
    const parentPlanned = plannedBranches.has(node.parent);
    const status: RebaseStatus = locallyClean && !parentPlanned
      ? "skipped-clean"
      : "planned";

    if (status === "planned") {
      plannedBranches.add(node.branch);
    }

    rebases.push({
      branch: node.branch,
      oldParentSha: oldParentSha.get(node.branch)!,
      newTarget: target,
      status,
    });
  }

  return { ok: true, rebases };
}

class AncestryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AncestryError";
  }
}

async function rebaseBranch(
  dir: string,
  branch: string,
  oldParentSha: string,
  newTarget: string,
): Promise<{ ok: boolean; stderr?: string; conflictFiles?: string[] }> {
  const checkout = await runGitCommand(dir, "checkout", branch);
  if (checkout.code !== 0) {
    return { ok: false, stderr: checkout.stderr };
  }

  const rebase = await runGitCommand(
    dir,
    "rebase",
    "--rebase-merges",
    "--onto",
    newTarget,
    oldParentSha,
    branch,
  );
  if (rebase.code === 0) {
    return { ok: true };
  }

  const conflictFiles = await getConflictFiles(dir);
  return {
    ok: false,
    stderr: rebase.stderr || rebase.stdout,
    conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
  };
}

/**
 * Execute a full restack. Handles conflict isolation: when one branch hits a
 * rebase conflict, its descendants are marked skipped-due-to-conflict but
 * independent sibling subtrees continue to rebase.
 */
export async function executeRestack(
  dir: string,
  stackName: string,
  opts: RestackOptions,
): Promise<RestackResult> {
  const existingState = await readResumeState(dir, stackName);
  if (opts.resume && !existingState) {
    throw new Error("No restack in progress to resume");
  }
  if (!opts.resume && existingState) {
    throw new Error(
      `Restack already in progress for stack "${stackName}". ` +
        `Run with --resume or clear stack.${stackName}.resume-state manually.`,
    );
  }

  const completed = new Set<string>(existingState?.completed ?? []);
  const persistedOldParent = existingState
    ? new Map(Object.entries(existingState.oldParentSha))
    : null;
  const effectiveOpts: RestackOptions = existingState
    ? existingState.opts
    : opts;

  const makeRecovery = (): RestackResult["recovery"] => ({
    resolve: "git add <conflicting files> && git rebase --continue",
    abort: "git rebase --abort",
    resume:
      `deno run --allow-run=git,gh --allow-env --allow-read src/cli.ts restack --stack-name=${stackName} --resume`,
  });

  // Defensive check: if any branch referenced by the persisted walk no longer
  // exists, the resume cannot continue. Clear the (unrecoverable) resume-state
  // and surface a clear, actionable error before touching the rebase.
  if (existingState) {
    const missing = await findMissingRefs(
      dir,
      Object.keys(existingState.oldParentSha),
    );
    if (missing.length > 0) {
      await clearResumeState(dir, stackName);
      const lines = missing.map((b) => `  - ${b}`).join("\n");
      throw new Error(
        `Cannot resume restack for stack "${stackName}": ${missing.length} branch(es) from the\n` +
          `in-progress walk no longer exist:\n` +
          `${lines}\n` +
          `Resume state has been cleared. Run cli.ts restack (without --resume) to\n` +
          `start a fresh walk after deciding how to handle the missing branches.`,
      );
    }
  }

  // On resume, finish any in-progress git rebase first and mark the exact
  // branch that was mid-rebase as completed (read from resume-state, not
  // inferred from plan order).
  let justContinuedBranch: string | undefined;
  if (existingState) {
    const continueResult = await runGitCommand(dir, "rebase", "--continue");
    if (continueResult.code !== 0) {
      // A rebase that fails --continue is either still mid-conflict (user
      // resolved one hunk but another is present) or no longer in progress
      // because the user ran `git rebase --abort` or `git reset` manually.
      const inProgress = await rebaseInProgress(dir);
      if (!inProgress) {
        await clearResumeState(dir, stackName);
        throw new Error(
          "No rebase in progress. The previous restack appears to have been " +
            "aborted (git rebase --abort or git reset). " +
            "Run cli.ts restack (without --resume) to start a fresh walk.",
        );
      }
      const stillConflicted = await getConflictFiles(dir);
      if (stillConflicted.length > 0) {
        return {
          ok: false,
          error: "conflict",
          rebases: [],
          recovery: makeRecovery(),
        };
      }
      return { ok: false, error: "other", rebases: [] };
    }

    // Mark the branch that was mid-rebase as completed, trusting the resume
    // state rather than inferring from plan order (which misidentifies when a
    // skipped-clean branch precedes the conflicted one).
    justContinuedBranch = existingState.conflictedBranch;
    if (justContinuedBranch !== undefined) {
      completed.add(justContinuedBranch);
      await writeResumeState(dir, stackName, {
        stackName,
        opts: effectiveOpts,
        oldParentSha: persistedOldParent
          ? Object.fromEntries(persistedOldParent)
          : {},
        branchTipSha: existingState.branchTipSha ?? {},
        completed: Array.from(completed),
        conflictedBranch: undefined,
      });
    }
  }

  const plan = await planRestack(dir, stackName, effectiveOpts);

  // Preflight every planned rebase target (e.g. `origin/<base>` for roots)
  // before writing any resume-state. If the user forgot `git fetch`, a missing
  // `origin/<base>` would otherwise throw after resume-state was already
  // persisted and wedge future runs.
  if (!existingState) {
    const unresolved: Array<{ target: string; stderr: string }> = [];
    for (const entry of plan.rebases) {
      if (entry.status !== "planned") continue;
      const probe = await runGitCommand(dir, "rev-parse", entry.newTarget);
      if (probe.code !== 0) {
        unresolved.push({ target: entry.newTarget, stderr: probe.stderr });
      }
    }
    if (unresolved.length > 0) {
      const first = unresolved[0];
      throw new Error(
        `Cannot resolve rebase target ${first.target}: ${first.stderr.trim()}. ` +
          `If this is origin/<base>, run \`git fetch origin <base>\` first.`,
      );
    }

    // Worktree safety: refuse to proceed if any worktree on a branch we're
    // about to rebase has uncommitted changes. This protects against the
    // runbook being skipped or misread.
    if (!opts.skipWorktreeCheck) {
      const branchesToTouch = plan.rebases
        .filter((e) => e.status === "planned")
        .map((e) => e.branch);
      const dirtyWorktrees = await checkWorktreeSafety(dir, branchesToTouch);
      if (dirtyWorktrees.length > 0) {
        const header =
          `Cannot proceed: ${dirtyWorktrees.length} worktree(s) have uncommitted changes on branches that would be rebased.`;
        const body = dirtyWorktrees
          .map((w) => {
            const files = w.dirtyFiles.slice(0, 3).join(", ") +
              (w.dirtyFiles.length > 3 ? ", ..." : "");
            return [
              `  ${w.path} (${w.branch}): ${w.dirtyFiles.length} dirty file(s) [${files}]`,
              `    git -C ${w.path} stash push -u`,
            ].join("\n");
          })
          .join("\n\n");
        throw new Error(
          `${header}\n\n${body}\n\nResolve these and re-run cli.ts restack.`,
        );
      }
    }

    // First-time entry: persist the initial snapshot before any rebase runs.
    const initialOldParent: Record<string, string> = {};
    const initialBranchTip: Record<string, string> = {};
    for (const entry of plan.rebases) {
      initialOldParent[entry.branch] = entry.oldParentSha;
      initialBranchTip[entry.branch] = await revParse(dir, entry.branch);
    }
    await writeResumeState(dir, stackName, {
      stackName,
      opts: effectiveOpts,
      oldParentSha: initialOldParent,
      branchTipSha: initialBranchTip,
      completed: [],
    });
  }

  // Compute the authoritative snapshot of branch tips. On resume it comes
  // from the persisted state; on first entry we re-snapshot now so later
  // writeResumeState calls keep the same record (the initialBranchTip map
  // above lives in the block above's scope).
  const persistedBranchTip = new Map<string, string>();
  if (existingState) {
    for (const [k, v] of Object.entries(existingState.branchTipSha ?? {})) {
      persistedBranchTip.set(k, v);
    }
  } else {
    // Re-read what we just persisted.
    const current = await readResumeState(dir, stackName);
    if (current?.branchTipSha) {
      for (const [k, v] of Object.entries(current.branchTipSha)) {
        persistedBranchTip.set(k, v);
      }
    }
  }

  const executed: RebasePlan[] = [];
  let firstFailure: "conflict" | "other" | undefined;
  let recovery: RestackResult["recovery"] | undefined;
  let conflictedAt: string | undefined;
  let ancestryFailure = false;

  for (const entry of plan.rebases) {
    if (conflictedAt !== undefined) break;

    if (completed.has(entry.branch)) {
      executed.push({ ...entry, status: "rebased" });
      continue;
    }

    if (entry.status === "skipped-clean") {
      executed.push(entry);
      completed.add(entry.branch);
      continue;
    }

    // Re-check ancestry now that earlier rebases may have moved this branch's
    // parent (and therefore `newTarget`, for non-root nodes).
    const targetSha = await revParse(dir, entry.newTarget);
    const branchSha = await revParse(dir, entry.branch);
    const isAncestorResult = await runGitCommand(
      dir,
      "merge-base",
      "--is-ancestor",
      targetSha,
      branchSha,
    );
    if (isAncestorResult.code === 0) {
      executed.push({ ...entry, status: "skipped-clean" });
      continue;
    }

    // On resume, use the persisted oldParentSha (parents may have been
    // rewritten already by the previous process, so re-snapshotting would be
    // wrong). On first entry, the plan's snapshot is authoritative.
    const boundary = persistedOldParent?.get(entry.branch) ??
      entry.oldParentSha;
    let result: Awaited<ReturnType<typeof rebaseBranch>>;
    try {
      // Force-push guard (resume only): if a branch we haven't rebased yet
      // has a different tip SHA than the persisted snapshot, something
      // rewrote it outside of this tool between the prior session and now.
      if (existingState) {
        const snapshotTip = persistedBranchTip.get(entry.branch);
        const currentTip = await revParse(dir, entry.branch);
        if (snapshotTip !== undefined && snapshotTip !== currentTip) {
          throw new AncestryError(
            `Cannot rebase ${entry.branch}: branch tip has changed from snapshot ${snapshotTip} to ${currentTip}. ` +
              `The branch may have been force-pushed or rewritten outside this tool. ` +
              `Inspect with: git log --oneline ${entry.branch}`,
          );
        }
      }

      result = await rebaseBranch(
        dir,
        entry.branch,
        boundary,
        entry.newTarget,
      );
    } catch (err) {
      if (err instanceof AncestryError) {
        executed.push({
          ...entry,
          status: "skipped-due-to-conflict",
          stderr: err.message,
        });
        conflictedAt = entry.branch;
        firstFailure = "other";
        recovery = undefined;
        ancestryFailure = true;
        break;
      }
      throw err;
    }

    if (result.ok) {
      executed.push({ ...entry, status: "rebased" });
      completed.add(entry.branch);
      await writeResumeState(dir, stackName, {
        stackName,
        opts: effectiveOpts,
        oldParentSha: persistedOldParent
          ? Object.fromEntries(persistedOldParent)
          : Object.fromEntries(
            plan.rebases.map((e) => [e.branch, e.oldParentSha]),
          ),
        branchTipSha: Object.fromEntries(persistedBranchTip),
        completed: Array.from(completed),
      });
      continue;
    }

    const wasConflict = (result.conflictFiles?.length ?? 0) > 0 ||
      (result.stderr ?? "").includes("CONFLICT");
    executed.push({
      ...entry,
      status: "conflict",
      stderr: result.stderr,
      conflictFiles: result.conflictFiles,
    });
    conflictedAt = entry.branch;
    firstFailure = wasConflict ? "conflict" : "other";
    recovery = makeRecovery();

    // Persist the conflicted branch name so resume can identify it
    // unambiguously rather than inferring from plan order.
    await writeResumeState(dir, stackName, {
      stackName,
      opts: effectiveOpts,
      oldParentSha: persistedOldParent
        ? Object.fromEntries(persistedOldParent)
        : Object.fromEntries(
          plan.rebases.map((e) => [e.branch, e.oldParentSha]),
        ),
      branchTipSha: Object.fromEntries(persistedBranchTip),
      completed: Array.from(completed),
      conflictedBranch: entry.branch,
    });
    // Intentionally do NOT abort the rebase. Leave the working tree in its
    // conflicted state so the user can resolve and `git rebase --continue`.
  }

  // Mark every plan entry we didn't touch as skipped-due-to-conflict so the
  // caller has a complete picture of what still needs to run on resume.
  if (conflictedAt !== undefined) {
    const processed = new Set(executed.map((e) => e.branch));
    for (const entry of plan.rebases) {
      if (!processed.has(entry.branch)) {
        executed.push({ ...entry, status: "skipped-due-to-conflict" });
      }
    }
  }

  // Ancestry failure is a structural problem the user must resolve manually.
  // Clear resume-state since this isn't a resumable conflict.
  if (ancestryFailure) {
    await clearResumeState(dir, stackName);
    return {
      ok: false,
      error: "other",
      rebases: executed,
      recovery: undefined,
    };
  }

  if (firstFailure !== undefined) {
    return {
      ok: false,
      error: firstFailure,
      rebases: executed,
      recovery,
    };
  }

  await clearResumeState(dir, stackName);
  return { ok: true, rebases: executed };
}

/**
 * Canonical entry point. Runs the dry-run planner when `opts.dryRun` is set,
 * otherwise executes the full per-branch rebase. Resume is handled by
 * `executeRestack`.
 */
export function restack(
  dir: string,
  stackName: string,
  opts: RestackOptions & { dryRun?: boolean } = {},
): Promise<RestackResult> {
  if (opts.dryRun) {
    return planRestack(dir, stackName, opts);
  }
  return executeRestack(dir, stackName, opts);
}
