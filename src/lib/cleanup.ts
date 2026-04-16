import {
  addLandedBranch,
  findNode,
  getAllNodes,
  getStackTree,
  removeStackBranch,
  revParse,
  runGitCommand,
  setStackNode,
  type StackTree,
} from "./stack.ts";
import { findWorktreeCollisions, type WorktreeCollision } from "./worktrees.ts";

export interface BranchSnapshot {
  branch: string;
  tipSha: string;
  recordedParent: string;
  parentTipSha: string;
}

export interface CleanupPreview {
  remainingRoots: string[];
  splits: Array<{ stackName: string; branches: string[] }>;
}

export async function captureSnapshot(
  dir: string,
  tree: StackTree,
): Promise<BranchSnapshot[]> {
  // Tombstone nodes have no ref; revParse would throw. Skip them — the
  // snapshot is used to recover pre-mutation state and only live branches
  // can be mutated.
  const nodes = getAllNodes(tree).filter((n) => !n.merged);
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
 * True iff `branch` has zero unique commits beyond `target`. Used after
 * rebasing `branch` onto `target` to detect patch-id drops: every commit
 * was absorbed by the upstream (either the rebase target itself or a
 * commit already reachable from it).
 *
 * Returns `false` on any `rev-list` failure (missing branch, missing
 * target ref, etc.) so a verification gap never causes a branch to be
 * tombstoned incorrectly. Callers must ensure `target` resolves (e.g.
 * `origin/<base>` requires a prior `fetchBase`).
 */
export async function isBranchAutoMerged(
  dir: string,
  branch: string,
  target: string,
): Promise<boolean> {
  const { code, stdout } = await runGitCommand(
    dir,
    "rev-list",
    "--count",
    `${target}..${branch}`,
  );
  if (code !== 0) return false;
  return stdout === "0";
}

export async function detectCleanWorktreeCollisions(
  dir: string,
  branches: string[],
): Promise<WorktreeCollision[]> {
  return await findWorktreeCollisions(dir, branches);
}

export interface TreeProjection {
  /** Live branches whose parent changes; map[branch] = new parent. */
  newParents: Map<string, string>;
  /** Branches that become roots of the surviving tree (parent == base). */
  remainingRoots: string[];
  /** Generated stack names when more than one root remains. */
  splits: Array<{ stackName: string; branches: string[] }>;
}

/**
 * Project the tree shape after removing every branch in `mergedSet`.
 * For each surviving node, climb past merged ancestors to find its new
 * parent. Roots are collected (promoted children of merged roots included),
 * and when more than one root remains we anticipate a split with generated
 * stack names. Writes nothing; all computation is in memory.
 */
export function projectTreeAfterRemoval(
  tree: StackTree,
  mergedSet: ReadonlySet<string>,
): TreeProjection {
  const base = tree.baseBranch;
  const nodes = getAllNodes(tree);

  // Climb past merged ancestors to find the first non-merged parent (or base).
  const resolveLiveParent = (parent: string): string => {
    let ancestor = parent;
    while (ancestor !== base && mergedSet.has(ancestor)) {
      ancestor = findNode(tree, ancestor)?.parent ?? base;
    }
    return ancestor;
  };

  const newParents = new Map<string, string>();
  const remainingRoots: string[] = [];
  for (const node of nodes) {
    if (mergedSet.has(node.branch)) continue;
    // Tombstones are historical; they should not influence projected roots.
    if (node.merged) continue;
    const liveParent = resolveLiveParent(node.parent);
    if (liveParent !== node.parent) {
      newParents.set(node.branch, liveParent);
    }
    if (liveParent === base) {
      remainingRoots.push(node.branch);
    }
  }

  if (remainingRoots.length <= 1) {
    return { newParents, remainingRoots, splits: [] };
  }

  // Mirror the naming logic in configSplitStack.
  const used = new Set<string>();
  const splits: TreeProjection["splits"] = [];
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
        if (mergedSet.has(n.branch)) return;
        branches.push(n.branch);
        for (const c of n.children) walk(c);
      };
      walk(subRoot);
    }

    splits.push({ stackName: name, branches });
  }

  return { newParents, remainingRoots, splits };
}

/**
 * Compute the shape of a cleanup after removing `mergedBranch` from the
 * tree. Preserved for call sites that only care about a single-branch removal;
 * delegates to `projectTreeAfterRemoval`.
 */
export function previewBranchCleanup(
  tree: StackTree,
  mergedBranch: string,
): CleanupPreview {
  const { remainingRoots, splits } = projectTreeAfterRemoval(
    tree,
    new Set([mergedBranch]),
  );
  return { remainingRoots, splits };
}

export interface BranchCleanupResult {
  removed: string;
  splitInto: Array<{ stackName: string; branches: string[] }>;
}

export interface ReparentAndRemoveOpts {
  /** Parent to assign every child of `branch`. Defaults to `branch`'s own parent. */
  newParentForChildren?: string;
  /** When true, also record `branch` in `landed-branches` before removal. */
  tombstone?: boolean;
}

/**
 * Reparent every direct child of `branch` to `newParentForChildren`
 * (default: the branch's own parent), then drop the branch's metadata.
 * Optionally tombstones the branch by adding it to `landed-branches`.
 * Shared by `configFoldBranch` (no tombstone) and `configBranchCleanup`
 * (tombstone + explicit new parent).
 */
export async function reparentAndRemove(
  dir: string,
  stackName: string,
  branch: string,
  opts: ReparentAndRemoveOpts = {},
): Promise<BranchCleanupResult> {
  const tree = await getStackTree(dir, stackName);
  const node = getAllNodes(tree).find((n) => n.branch === branch);
  const newParent = opts.newParentForChildren ?? node?.parent;

  if (node && newParent !== undefined) {
    for (const child of node.children) {
      await setStackNode(dir, child.branch, stackName, newParent);
    }
  }

  if (opts.tombstone) {
    await addLandedBranch(dir, stackName, branch);
  }
  await removeStackBranch(dir, branch);

  return { removed: branch, splitInto: [] };
}

/**
 * Generic per-branch cleanup used by both `land` and `sync`. Reparents every
 * direct child of `mergedBranch` to `newParentForChildren`, tombstones the
 * branch by adding it to `landed-branches` and dropping its branch-level
 * config. The caller is responsible for detecting multi-root splits if that
 * matters (today only `land` does, via the configSplitStack path).
 */
export async function configBranchCleanup(
  dir: string,
  stackName: string,
  mergedBranch: string,
  newParentForChildren: string,
): Promise<BranchCleanupResult> {
  return await reparentAndRemove(dir, stackName, mergedBranch, {
    newParentForChildren,
    tombstone: true,
  });
}
