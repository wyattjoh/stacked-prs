import {
  findNode,
  getStackTree,
  runGitCommand,
  type StackNode,
  type StackTree,
} from "../lib/stack.ts";

async function getConflictFiles(dir: string): Promise<string[]> {
  const { stdout } = await runGitCommand(
    dir,
    "diff",
    "--name-only",
    "--diff-filter=U",
  );
  return stdout ? stdout.split("\n").filter(Boolean) : [];
}

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
    order.push(node);
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
}

interface ResumeState {
  stackName: string;
  opts: RestackOptions;
  oldParentSha: Record<string, string>;
  completed: string[];
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

async function revParse(dir: string, ref: string): Promise<string> {
  const { code, stdout, stderr } = await runGitCommand(dir, "rev-parse", ref);
  if (code !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${stderr}`);
  }
  return stdout.trim();
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
 * Compute the full rebase plan without mutating the repo.
 */
export async function planRestack(
  dir: string,
  stackName: string,
  opts: RestackOptions,
): Promise<RestackResult> {
  const tree = await getStackTree(dir, stackName);
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

  // On resume, finish any in-progress git rebase first. If it still conflicts,
  // bail out with the same conflict result shape as before.
  const makeRecovery = (): RestackResult["recovery"] => ({
    resolve: "git add <conflicting files> && git rebase --continue",
    abort: "git rebase --abort",
    resume:
      `deno run --allow-run=git,gh --allow-env --allow-read src/cli.ts restack --stack-name=${stackName} --resume`,
  });

  if (existingState) {
    const continueResult = await runGitCommand(dir, "rebase", "--continue");
    if (continueResult.code !== 0) {
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
    // The branch that was mid-rebase is the head we just finished. We don't
    // know its name from the config alone, but we do know every branch in
    // `completed` is already done, and the next one not yet in `completed`
    // from the plan is what --continue just finished. We mark it after we
    // discover it in the plan walk below.
  }

  const plan = await planRestack(dir, stackName, effectiveOpts);
  const executed: RebasePlan[] = [];
  let firstFailure: "conflict" | "other" | undefined;
  let recovery: RestackResult["recovery"] | undefined;
  let conflictedAt: string | undefined;
  let justContinuedBranch: string | undefined;

  if (!existingState) {
    // First-time entry: persist the initial snapshot before any rebase runs.
    const initialOldParent: Record<string, string> = {};
    for (const entry of plan.rebases) {
      initialOldParent[entry.branch] = entry.oldParentSha;
    }
    await writeResumeState(dir, stackName, {
      stackName,
      opts: effectiveOpts,
      oldParentSha: initialOldParent,
      completed: [],
    });
  }

  for (const entry of plan.rebases) {
    if (conflictedAt !== undefined) break;

    if (completed.has(entry.branch)) {
      executed.push({ ...entry, status: "rebased" });
      continue;
    }

    // The first non-completed branch on resume is the one that was mid-rebase
    // and just finished via `git rebase --continue`. Mark it done.
    if (existingState && justContinuedBranch === undefined) {
      justContinuedBranch = entry.branch;
      executed.push({ ...entry, status: "rebased" });
      completed.add(entry.branch);
      await writeResumeState(dir, stackName, {
        stackName,
        opts: effectiveOpts,
        oldParentSha: persistedOldParent
          ? Object.fromEntries(persistedOldParent)
          : {},
        completed: Array.from(completed),
      });
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
    const result = await rebaseBranch(
      dir,
      entry.branch,
      boundary,
      entry.newTarget,
    );
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
    // Intentionally do NOT abort the rebase. Leave the working tree in its
    // conflicted state so the user can resolve and `git rebase --continue`.
    // Resume (Task 6) will finish the in-progress rebase and continue walking
    // remaining plan entries.
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
