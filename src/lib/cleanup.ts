import {
  findNode,
  getAllNodes,
  revParse,
  runGitCommand,
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

/**
 * Compute (in memory, no config writes) the shape of a cleanup after
 * removing `mergedBranch` from the tree: children of the merged branch
 * become new roots, and if more than one root remains we anticipate a
 * split with generated stack names.
 */
export function previewBranchCleanup(
  tree: StackTree,
  mergedBranch: string,
): CleanupPreview {
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
  const splits: CleanupPreview["splits"] = [];
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
