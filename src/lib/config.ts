import {
  getAllNodes,
  getEffectiveMergeStrategy,
  getStackTree,
  gitConfig,
  type MergeStrategy,
  removeStackBranch,
  setBranchBaseBranch,
  setBranchMergeStrategy,
  setBranchParent,
  setMergeStrategy,
  setStackNode,
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
  remainingRoots: string[];
  splitInto: SplitInfo[];
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
  const tree = await getStackTree(dir, opts.stack);
  const strategy = await getEffectiveMergeStrategy(dir, opts.child);
  const childStackName = await gitConfig(
    dir,
    `branch.${opts.child}.stack-name`,
  );
  const useLegacyStackName = childStackName === opts.stack;

  // Set new branch's parent
  if (useLegacyStackName) {
    await setStackNode(dir, opts.branch, opts.stack, opts.parent);
  } else {
    await setBranchParent(dir, opts.branch, opts.parent);
  }
  await setBranchBaseBranch(dir, opts.branch, tree.baseBranch);
  await setBranchMergeStrategy(dir, opts.branch, strategy);
  // Reparent child to point to the new branch
  if (useLegacyStackName) {
    await setStackNode(dir, opts.child, opts.stack, opts.branch);
  } else {
    await setBranchParent(dir, opts.child, opts.branch);
  }
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
    await setBranchParent(dir, child.branch, node.parent);
  }

  // Set the moved branch's parent to the new parent
  await setBranchParent(dir, opts.branch, opts.newParent);
}

export async function configLandCleanup(
  dir: string,
  stackName: string,
  mergedBranch: string,
  _prNumber?: number,
): Promise<LandCleanupResult> {
  const result = await configBranchCleanup(
    dir,
    stackName,
    mergedBranch,
    _prNumber,
  );
  return {
    removed: mergedBranch,
    remainingRoots: result.remainingRoots,
    splitInto: [],
  };
}
