import {
  getAllNodes,
  getBaseBranch,
  getMergeStrategy,
  getStackTree,
  type MergeStrategy,
  removeStackBranch,
  setBaseBranch,
  setMergeStrategy,
  setStackNode,
  type StackTree,
  validateStackTree,
} from "../lib/stack.ts";

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

  if (tree.roots.length <= 1) {
    return [];
  }

  // Build new stack names, ensuring no collisions
  const usedNames = new Set<string>();
  const splits: SplitInfo[] = [];

  for (const root of tree.roots) {
    let newName = deriveStackName(root.branch);
    // Resolve collision by appending a suffix
    if (usedNames.has(newName)) {
      let i = 2;
      while (usedNames.has(`${newName}-${i}`)) i++;
      newName = `${newName}-${i}`;
    }
    usedNames.add(newName);

    const subtreeNodes = getAllNodes({ ...tree, roots: [root] });
    const branches = subtreeNodes.map((n) => n.branch);
    splits.push({ stackName: newName, branches });
  }

  // Write new stack metadata for each split
  for (const split of splits) {
    await setBaseBranch(dir, split.stackName, baseBranch);
    if (mergeStrategy) {
      await setMergeStrategy(dir, split.stackName, mergeStrategy);
    }
    for (const branch of split.branches) {
      const node = getAllNodes(tree).find((n) => n.branch === branch)!;
      await setStackNode(dir, branch, split.stackName, node.parent);
    }
  }

  // Remove all original stack metadata by clearing stack-name on each branch
  for (const node of getAllNodes(tree)) {
    await removeStackBranch(dir, node.branch);
  }

  // Restore branch metadata now pointing to new stacks
  for (const split of splits) {
    for (const branch of split.branches) {
      const node = getAllNodes(tree).find((n) => n.branch === branch)!;
      await setStackNode(dir, branch, split.stackName, node.parent);
    }
  }

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

  // Reparent all children of the folded branch to the folded branch's parent
  for (const child of node.children) {
    await setStackNode(dir, child.branch, stackName, node.parent);
  }

  // Remove the folded branch
  await removeStackBranch(dir, branch);

  return { removed: branch };
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
): Promise<LandCleanupResult> {
  const tree = await getStackTree(dir, stackName);
  const mergedNode = getAllNodes(tree).find((n) => n.branch === mergedBranch);
  const baseBranch = tree.baseBranch;

  // Reparent direct children of the merged branch to the base branch
  if (mergedNode) {
    for (const child of mergedNode.children) {
      await setStackNode(dir, child.branch, stackName, baseBranch);
    }
  }

  // Remove the merged branch
  await removeStackBranch(dir, mergedBranch);

  // Re-read the tree to see how many roots remain
  const treeAfter = await getStackTree(dir, stackName);

  // If more than one root remains, split the stack
  if (treeAfter.roots.length > 1) {
    const splitInto = await configSplitStack(dir, stackName);
    return { removed: mergedBranch, splitInto };
  }

  return { removed: mergedBranch, splitInto: [] };
}
