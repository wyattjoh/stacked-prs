import {
  findNode,
  getAllNodes,
  getStackTree,
  runGitCommand,
  type StackNode,
  type StackTree,
} from "../lib/stack.ts";

export interface Segment {
  tip: string;
  base: string;
  branches: string[];
}

export interface RebaseSegment extends Segment {
  command: string;
  exitCode: number;
  stderr?: string;
  conflictFiles?: string[];
}

export interface RestackResult {
  ok: boolean;
  error?: "conflict" | "other";
  segments: RebaseSegment[];
  skipped: Array<{
    tip: string;
    base: string;
    branches: string[];
    reason: string;
  }>;
  recovery?: {
    resolve: string;
    abort: string;
    resume: string;
  };
}

/**
 * Decompose a StackTree into rebase segments.
 *
 * Walk the tree recursively:
 * - Leaf node (0 children): close the current segment
 * - Single-child node: continue the current segment
 * - Fork node (2+ children): close segment at this node, start new segments for each child
 */
export function decomposeSegments(tree: StackTree): Segment[] {
  const segments: Segment[] = [];

  const walk = (
    node: StackNode,
    segmentBase: string,
    segmentBranches: string[],
  ): void => {
    const currentBranches = [...segmentBranches, node.branch];

    if (node.children.length === 0) {
      // Leaf: close segment
      segments.push({
        tip: node.branch,
        base: segmentBase,
        branches: currentBranches,
      });
      return;
    }

    if (node.children.length === 1) {
      // Single child: continue segment
      walk(node.children[0], segmentBase, currentBranches);
      return;
    }

    // Fork: close segment at this node, start new segments for each child
    segments.push({
      tip: node.branch,
      base: segmentBase,
      branches: currentBranches,
    });

    for (const child of node.children) {
      walk(child, node.branch, []);
    }
  };

  for (const root of tree.roots) {
    walk(root, tree.baseBranch, []);
  }

  return segments;
}

async function isAncestor(
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const { code } = await runGitCommand(
    dir,
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  );
  return code === 0;
}

async function getConflictFiles(dir: string): Promise<string[]> {
  const { stdout } = await runGitCommand(
    dir,
    "diff",
    "--name-only",
    "--diff-filter=U",
  );
  return stdout ? stdout.split("\n").filter(Boolean) : [];
}

function filterSegments(
  segments: Segment[],
  tree: StackTree,
  opts: { upstackFrom?: string; downstackFrom?: string; only?: string },
): Segment[] {
  if (!opts.upstackFrom && !opts.downstackFrom && !opts.only) {
    return segments;
  }

  if (opts.only) {
    return segments.filter((s) => s.tip === opts.only);
  }

  if (opts.upstackFrom) {
    // Include the named segment and all segments whose base comes from it
    const targetNode = findNode(tree, opts.upstackFrom);
    if (!targetNode) return segments;

    // Collect all branch names reachable from the target node (inclusive)
    const included = new Set<string>();
    const collectSubtree = (node: StackNode): void => {
      included.add(node.branch);
      for (const child of node.children) collectSubtree(child);
    };
    collectSubtree(targetNode);

    return segments.filter((s) => included.has(s.tip));
  }

  if (opts.downstackFrom) {
    // Include only segments on the path from root to this branch
    const path = getAllNodes(tree)
      .filter((n) => {
        // A node is "downstack from" the target if the target is in its subtree,
        // or the node itself is the target or an ancestor of it.
        const targetNode = findNode(tree, opts.downstackFrom!);
        if (!targetNode) return false;

        // Walk up from target to find ancestors
        const ancestors = new Set<string>();
        const findAncestors = (node: StackNode, parentBranch: string): void => {
          if (node.branch === opts.downstackFrom!) {
            ancestors.add(parentBranch);
          }
          for (const child of node.children) {
            findAncestors(child, node.branch);
          }
        };
        for (const root of tree.roots) {
          findAncestors(root, tree.baseBranch);
        }

        return ancestors.has(n.branch) || n.branch === opts.downstackFrom;
      })
      .map((n) => n.branch);

    const pathSet = new Set(path);
    return segments.filter((s) => pathSet.has(s.tip));
  }

  return segments;
}

export async function restack(
  dir: string,
  stackName: string,
  opts?: { upstackFrom?: string; downstackFrom?: string; only?: string },
): Promise<RestackResult> {
  const tree = await getStackTree(dir, stackName);
  const allSegments = decomposeSegments(tree);
  const segments = filterSegments(allSegments, tree, opts ?? {});

  const resultSegments: RebaseSegment[] = [];
  const skipped: RestackResult["skipped"] = [];
  // Track which bases have failed so we can skip dependent segments
  const failedBases = new Set<string>();
  // First failure recorded (conflict or other), returned after full iteration
  let firstFailure: {
    error: "conflict" | "other";
    recovery?: RestackResult["recovery"];
  } | undefined;

  for (const segment of segments) {
    // If the segment's base had a conflict, skip this segment
    if (failedBases.has(segment.base) || firstFailure !== undefined) {
      skipped.push({
        tip: segment.tip,
        base: segment.base,
        branches: segment.branches,
        reason: `Skipped because base "${segment.base}" had a conflict`,
      });
      // Mark this segment's tip as failed too so descendants are also skipped
      failedBases.add(segment.tip);
      continue;
    }

    // Check if already synced
    const alreadySynced = await isAncestor(dir, segment.base, segment.tip);
    if (alreadySynced) {
      resultSegments.push({
        ...segment,
        command: `git merge-base --is-ancestor ${segment.base} ${segment.tip}`,
        exitCode: 0,
      });
      continue;
    }

    // Checkout the tip branch
    const checkoutResult = await runGitCommand(dir, "checkout", segment.tip);
    if (checkoutResult.code !== 0) {
      resultSegments.push({
        ...segment,
        command: `git checkout ${segment.tip}`,
        exitCode: checkoutResult.code,
        stderr: checkoutResult.stderr,
      });
      failedBases.add(segment.tip);
      firstFailure = { error: "other" };
      continue;
    }

    // Run rebase
    const rebaseArgs = segment.branches.length > 1
      ? ["rebase", "--update-refs", segment.base]
      : ["rebase", segment.base];
    const command = `git ${rebaseArgs.join(" ")}`;
    const rebaseResult = await runGitCommand(dir, ...rebaseArgs);

    if (rebaseResult.code === 0) {
      resultSegments.push({
        ...segment,
        command,
        exitCode: 0,
      });
    } else {
      // Conflict or other error
      const conflictFiles = await getConflictFiles(dir);
      const isConflict = rebaseResult.stderr.includes("CONFLICT") ||
        rebaseResult.stdout.includes("CONFLICT") ||
        conflictFiles.length > 0;

      resultSegments.push({
        ...segment,
        command,
        exitCode: rebaseResult.code,
        stderr: rebaseResult.stderr || rebaseResult.stdout,
        conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
      });

      // Mark this tip as failed so dependent segments are skipped
      failedBases.add(segment.tip);
      firstFailure = {
        error: isConflict ? "conflict" : "other",
        recovery: {
          resolve: "git add <conflicting files> && git rebase --continue",
          abort: "git rebase --abort",
          resume:
            `deno run --allow-run=git,gh --allow-env cli.ts restack --stack-name=${stackName} --resume`,
        },
      };
    }
  }

  if (firstFailure !== undefined) {
    return {
      ok: false,
      error: firstFailure.error,
      segments: resultSegments,
      skipped,
      recovery: firstFailure.recovery,
    };
  }

  return {
    ok: true,
    segments: resultSegments,
    skipped,
  };
}

// =========================================================================
// New per-branch rebase implementation (spec: 2026-04-08-restack-correctness)
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

export interface RestackResultV2 {
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

export interface RestackOptionsV2 {
  upstackFrom?: string;
  downstackFrom?: string;
  only?: string;
  resume?: boolean;
}

interface ResumeState {
  stackName: string;
  opts: RestackOptionsV2;
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
 * Currently this duplicates the semantics of the old `filterSegments` but
 * operates on nodes directly. Moved to a standalone helper so dry-run and
 * execute share the same filter.
 */
function filterNodes(
  tree: StackTree,
  opts: RestackOptionsV2,
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
  opts: RestackOptionsV2,
): Promise<RestackResultV2> {
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
  opts: RestackOptionsV2,
): Promise<RestackResultV2> {
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
  const effectiveOpts: RestackOptionsV2 = existingState
    ? existingState.opts
    : opts;

  // On resume, finish any in-progress git rebase first. If it still conflicts,
  // bail out with the same conflict result shape as before.
  const makeRecovery = (): RestackResultV2["recovery"] => ({
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
  let recovery: RestackResultV2["recovery"] | undefined;
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
