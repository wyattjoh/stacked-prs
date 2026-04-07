import {
  getAllNodes,
  getMergeStrategy,
  getStackTree,
  renderTree,
  runGitCommand,
  type StackNode,
  type StackTree,
} from "../lib/stack.ts";
import { gh } from "../lib/gh.ts";

export interface PrInfo {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
}

export type SyncStatus = "up-to-date" | "behind-parent" | "diverged";

export interface BranchStatus {
  branch: string;
  parent: string;
  depth: number;
  isLastChild: boolean;
  childCount: number;
  pr: PrInfo | null;
  syncStatus: SyncStatus;
  isCurrent: boolean;
}

export interface StackStatus {
  stackName: string;
  mergeStrategy: string | undefined;
  branches: BranchStatus[];
  display: string;
}

async function getCurrentBranch(dir: string): Promise<string> {
  const { stdout } = await runGitCommand(dir, "branch", "--show-current");
  return stdout;
}

async function queryPr(
  branch: string,
  owner?: string,
  repo?: string,
): Promise<PrInfo | null> {
  const args = ["pr", "list", "--head", branch];
  if (owner && repo) {
    args.push("--repo", `${owner}/${repo}`);
  }
  args.push("--json", "number,url,state,isDraft");
  const result = await gh(...args);
  const parsed = JSON.parse(result) as PrInfo[];
  return parsed.length > 0 ? parsed[0] : null;
}

async function getSyncStatus(
  dir: string,
  parent: string,
  branch: string,
): Promise<SyncStatus> {
  const { code: ancestorCode } = await runGitCommand(
    dir,
    "merge-base",
    "--is-ancestor",
    parent,
    branch,
  );
  if (ancestorCode === 0) return "up-to-date";

  const { code: reverseCode } = await runGitCommand(
    dir,
    "merge-base",
    "--is-ancestor",
    branch,
    parent,
  );
  if (reverseCode === 0) return "behind-parent";

  return "diverged";
}

/** Walk the tree DFS and compute depth + isLastChild for each node. */
function computeDepths(
  tree: StackTree,
): Map<string, { depth: number; isLastChild: boolean }> {
  const result = new Map<string, { depth: number; isLastChild: boolean }>();

  const walk = (node: StackNode, depth: number, isLastChild: boolean): void => {
    result.set(node.branch, { depth, isLastChild });
    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i], depth + 1, i === node.children.length - 1);
    }
  };

  for (let i = 0; i < tree.roots.length; i++) {
    // Roots are always "last child" relative to themselves (no parent connector)
    walk(tree.roots[i], 0, i === tree.roots.length - 1);
  }

  return result;
}

function buildAnnotation(pr: PrInfo | null, syncStatus: SyncStatus): string {
  const prPart = pr
    ? `PR #${pr.number} (${pr.isDraft ? "draft" : pr.state.toLowerCase()})`
    : "(no PR)";
  return `${prPart.padEnd(24)}${syncStatus}`;
}

function buildDisplayHeader(
  stackName: string,
  mergeStrategy: string | undefined,
): string {
  const strategyPart = mergeStrategy ? ` (${mergeStrategy} merge)` : "";
  return `Stack: ${stackName}${strategyPart}`;
}

export async function getStackStatus(
  dir: string,
  stackName: string,
  owner?: string,
  repo?: string,
): Promise<StackStatus> {
  const [tree, currentBranch] = await Promise.all([
    getStackTree(dir, stackName),
    getCurrentBranch(dir),
  ]);

  const mergeStrategy = tree.mergeStrategy;
  const depthMap = computeDepths(tree);
  const nodes = getAllNodes(tree);

  const branches = await Promise.all(
    nodes.map(async (node): Promise<BranchStatus> => {
      const [pr, syncStatus] = await Promise.all([
        queryPr(node.branch, owner, repo),
        getSyncStatus(dir, node.parent, node.branch),
      ]);

      const { depth, isLastChild } = depthMap.get(node.branch) ?? {
        depth: 0,
        isLastChild: true,
      };

      return {
        branch: node.branch,
        parent: node.parent,
        depth,
        isLastChild,
        childCount: node.children.length,
        pr,
        syncStatus,
        isCurrent: node.branch === currentBranch,
      };
    }),
  );

  // Build annotations map for renderTree
  const annotations = new Map<string, string>();
  for (const b of branches) {
    annotations.set(b.branch, buildAnnotation(b.pr, b.syncStatus));
  }

  const treeBody = renderTree(tree, {
    annotations,
    currentBranch,
  });

  const header = buildDisplayHeader(stackName, mergeStrategy);
  const display = `${header}\n\n  ${treeBody.split("\n").join("\n  ")}`;

  return { stackName, mergeStrategy, branches, display };
}
