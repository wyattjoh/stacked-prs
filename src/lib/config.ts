import {
  addLandedBranch,
  addLandedParent,
  addLandedPr,
  clearStackConfig,
  getAllNodes,
  getLandedBranches,
  getLandedParents,
  getLandedPrs,
  getLiveSubtreeRoots,
  getMergeStrategy,
  getStackTree,
  type MergeStrategy,
  removeStackBranch,
  setBaseBranch,
  setMergeStrategy,
  setStackNode,
  type StackNode,
  type StackTree,
} from "./stack.ts";
import { configBranchCleanup, reparentAndRemove } from "./cleanup.ts";

export interface SetBranchOpts {
  branch: string;
  stack: string;
  parent: string;
}

export async function configSetBranch(
  dir: string,
  opts: SetBranchOpts,
): Promise<void> {
  await setStackNode(dir, opts.branch, opts.stack, opts.parent);
}

export async function configRemoveBranch(
  dir: string,
  branch: string,
): Promise<void> {
  await removeStackBranch(dir, branch);
}

export async function configSetStrategy(
  dir: string,
  stackName: string,
  strategy: MergeStrategy,
): Promise<void> {
  await setMergeStrategy(dir, stackName, strategy);
}

export function configGet(
  dir: string,
  stackName?: string,
): Promise<StackTree> {
  return getStackTree(dir, stackName);
}

export interface SplitInfo {
  stackName: string;
  branches: string[];
}

export interface LandCleanupResult {
  removed: string;
  splitInto: SplitInfo[];
}

/** Derive a short stack name from a branch name (strips common prefixes). */
function deriveStackName(branch: string): string {
  return branch.replace(/^(?:feature|fix|chore)\//, "");
}

/**
 * Split a multi-root stack into per-subtree stacks.
 * Returns the list of new stacks created. Removes all metadata from the
 * original stack name.
 */
export async function configSplitStack(
  dir: string,
  stackName: string,
): Promise<SplitInfo[]> {
  const tree = await getStackTree(dir, stackName);
  const baseBranch = tree.baseBranch;
  const mergeStrategy = await getMergeStrategy(dir, stackName);

  // Each live subtree (rooted at a branch whose effective parent is the base)
  // becomes its own split stack. Tombstones stay attached to the original
  // namespace until we remove them below.
  const liveTops = getLiveSubtreeRoots(tree);
  if (liveTops.length <= 1) {
    return [];
  }

  // Build new stack names, ensuring no collisions
  const usedNames = new Set<string>();
  const splits: SplitInfo[] = [];

  for (const top of liveTops) {
    let newName = deriveStackName(top.branch);
    // Resolve collision by appending a suffix
    if (usedNames.has(newName)) {
      let i = 2;
      while (usedNames.has(`${newName}-${i}`)) i++;
      newName = `${newName}-${i}`;
    }
    usedNames.add(newName);

    // Walk this subtree, skipping any descendant tombstones (they belong
    // to the shared history rather than the split).
    const branches: string[] = [];
    const walk = (n: StackNode): void => {
      if (n.merged) return;
      branches.push(n.branch);
      for (const c of n.children) walk(c);
    };
    walk(top);
    splits.push({ stackName: newName, branches });
  }

  const nodeByBranch = new Map(getAllNodes(tree).map((n) => [n.branch, n]));

  // Write stack-level metadata for each split
  for (const split of splits) {
    await setBaseBranch(dir, split.stackName, baseBranch);
    if (mergeStrategy) {
      await setMergeStrategy(dir, split.stackName, mergeStrategy);
    }
  }

  // Copy tombstone records (landed-branches + landed-pr + landed-parent)
  // into every new split stack so nav comments continue to show the
  // shared merge history with its structural shape.
  const tombstoneBranches = await getLandedBranches(dir, stackName);
  const tombstonePrs = await getLandedPrs(dir, stackName);
  const tombstoneParents = await getLandedParents(dir, stackName);
  for (const split of splits) {
    for (const branch of tombstoneBranches) {
      await addLandedBranch(dir, split.stackName, branch);
    }
    for (const [branch, prNumber] of tombstonePrs) {
      await addLandedPr(dir, split.stackName, branch, prNumber);
    }
    for (const [branch, parent] of tombstoneParents) {
      await addLandedParent(dir, split.stackName, branch, parent);
    }
  }

  // Remove branch-level config for every node in the original stack.
  // Tombstones are represented in each split via the stack-level records
  // we just copied; live branches get rewritten below.
  for (const node of nodeByBranch.values()) {
    await removeStackBranch(dir, node.branch);
  }

  // Write branch-level metadata for live branches into their split.
  // Each branch keeps its recorded parent (including tombstoned parents)
  // so live subtree roots continue to render nested under the shared
  // merged history via the split's landed-parent records.
  for (const split of splits) {
    for (const branch of split.branches) {
      const node = nodeByBranch.get(branch)!;
      await setStackNode(dir, branch, split.stackName, node.parent);
    }
  }

  // Fully unset the original stack's config so it does not linger as an
  // orphan that `clean` would detect as empty.
  await clearStackConfig(dir, stackName);

  return splits;
}

export interface InsertBranchOpts {
  stack: string;
  branch: string;
  parent: string;
  child: string;
}

export async function configInsertBranch(
  dir: string,
  opts: InsertBranchOpts,
): Promise<void> {
  // Set new branch's parent
  await setStackNode(dir, opts.branch, opts.stack, opts.parent);
  // Reparent child to point to the new branch
  await setStackNode(dir, opts.child, opts.stack, opts.branch);
}

export interface FoldBranchResult {
  removed: string;
}

export async function configFoldBranch(
  dir: string,
  stackName: string,
  branch: string,
): Promise<FoldBranchResult> {
  const tree = await getStackTree(dir, stackName);
  const node = getAllNodes(tree).find((n) => n.branch === branch);
  if (!node) {
    throw new Error(`Branch ${branch} not found in stack ${stackName}`);
  }

  const { removed } = await reparentAndRemove(dir, stackName, branch);
  return { removed };
}

export interface MoveBranchOpts {
  stack: string;
  branch: string;
  newParent: string;
}

export async function configMoveBranch(
  dir: string,
  opts: MoveBranchOpts,
): Promise<void> {
  const tree = await getStackTree(dir, opts.stack);
  const node = getAllNodes(tree).find((n) => n.branch === opts.branch);
  if (!node) {
    throw new Error(
      `Branch ${opts.branch} not found in stack ${opts.stack}`,
    );
  }

  // Reparent all children of the moved branch to its old parent
  for (const child of node.children) {
    await setStackNode(dir, child.branch, opts.stack, node.parent);
  }

  // Set the moved branch's parent to the new parent
  await setStackNode(dir, opts.branch, opts.stack, opts.newParent);
}

export async function configLandCleanup(
  dir: string,
  stackName: string,
  mergedBranch: string,
  /**
   * Merged branch's PR number, if known. Recorded alongside the tombstone
   * so the three writes (`landed-branches` + `landed-parent` + `landed-pr`)
   * commit as a unit. If a crash strands the tombstone with only two of
   * the three records, nav rendering falls back to the "flat siblings"
   * shape this refactor fixes; keeping all three writes in one call
   * prevents that state.
   */
  prNumber?: number,
): Promise<LandCleanupResult> {
  await configBranchCleanup(dir, stackName, mergedBranch, prNumber);

  // Re-read the tree to see how many live subtrees remain. A live subtree is
  // rooted at a live branch whose effective parent (after walking past
  // tombstones) is the base branch. If more than one remains, split the stack.
  const treeAfter = await getStackTree(dir, stackName);
  const liveTops = getLiveSubtreeRoots(treeAfter);
  if (liveTops.length > 1) {
    const splitInto = await configSplitStack(dir, stackName);
    return { removed: mergedBranch, splitInto };
  }

  return { removed: mergedBranch, splitInto: [] };
}
