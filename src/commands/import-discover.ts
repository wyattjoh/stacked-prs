import { runGitCommand } from "../lib/stack.ts";
import { gh } from "../lib/gh.ts";

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
}

export interface DiscoveredNode {
  branch: string;
  parent: string;
  children: DiscoveredNode[];
  pr?: PrInfo;
}

export interface DiscoverResult {
  roots: DiscoveredNode[];
  baseBranch: string;
  warnings: string[];
}

/** Detect whether the base branch is "main" or "master". */
export async function detectBaseBranch(dir: string): Promise<string> {
  const { code: mainCode } = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "refs/heads/main",
  );
  if (mainCode === 0) return "main";

  const { code: masterCode } = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "refs/heads/master",
  );
  if (masterCode === 0) return "master";

  return "main";
}

/** List all local branch names. */
export async function listLocalBranches(dir: string): Promise<string[]> {
  const { code, stdout } = await runGitCommand(
    dir,
    "branch",
    "--format=%(refname:short)",
  );
  if (code !== 0) return [];
  return stdout.split("\n").filter((b) => b.length > 0);
}

/**
 * Find the closest parent branch for a given branch.
 * Uses git merge-base --is-ancestor + git rev-list --count to find
 * the candidate with the fewest commits distance.
 */
export async function findClosestParent(
  dir: string,
  branch: string,
  candidates: string[],
): Promise<string | undefined> {
  let best: string | undefined;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    if (candidate === branch) continue;

    // Check if candidate is an ancestor of branch
    const { code: ancestorCode } = await runGitCommand(
      dir,
      "merge-base",
      "--is-ancestor",
      candidate,
      branch,
    );
    if (ancestorCode !== 0) continue;

    // Count commits between candidate and branch
    const { code: countCode, stdout: countStr } = await runGitCommand(
      dir,
      "rev-list",
      "--count",
      `${candidate}..${branch}`,
    );
    if (countCode !== 0) continue;

    const distance = parseInt(countStr, 10);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best;
}

/**
 * Walk DOWN from the starting branch toward the base branch,
 * building the chain of parent branches.
 */
export async function walkDown(
  dir: string,
  startBranch: string,
  baseBranch: string,
  allBranches: string[],
): Promise<string[]> {
  const chain: string[] = [];
  let current = startBranch;

  while (current !== baseBranch) {
    const parent = await findClosestParent(dir, current, allBranches);
    if (!parent) break;

    chain.unshift(current);
    current = parent;

    // If we reached the base, stop
    if (current === baseBranch) break;

    // If parent is already in chain, we have a cycle
    if (chain.includes(current)) break;
  }

  // If current is not baseBranch and not startBranch, add it
  if (current !== baseBranch && !chain.includes(current)) {
    chain.unshift(current);
  }

  return chain;
}

/**
 * Walk UP from the starting branches to find descendant branches
 * (branches whose closest parent is ANY branch in the current discovered set).
 * Returns a flat map of branch -> parent for all discovered branches.
 */
export async function walkUp(
  dir: string,
  chainSoFar: string[],
  baseBranch: string,
  allBranches: string[],
): Promise<Map<string, string>> {
  // Map from branch -> parent for all discovered nodes
  const parentMap = new Map<string, string>();

  // Seed the map from the initial chain (chainSoFar is ordered bottom-to-top,
  // first element has baseBranch as parent)
  for (let i = 0; i < chainSoFar.length; i++) {
    const branch = chainSoFar[i];
    const parent = i === 0 ? baseBranch : chainSoFar[i - 1];
    parentMap.set(branch, parent);
  }

  const visited = new Set([baseBranch, ...chainSoFar]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const branch of allBranches) {
      if (visited.has(branch)) continue;

      // Check against ALL discovered branches (plus base), not just the last
      const candidates = [baseBranch, ...parentMap.keys()];
      const parent = await findClosestParent(dir, branch, candidates);
      if (!parent) continue;

      // Accept if parent is any DISCOVERED branch (not merely the base branch).
      // This allows fork-shaped chains to be discovered, while excluding
      // unrelated branches that happen to share the base branch as parent.
      if (parentMap.has(parent)) {
        parentMap.set(branch, parent);
        visited.add(branch);
        changed = true;
      }
    }
  }

  return parentMap;
}

/** Query PR info for a branch. Returns undefined if no PR exists. */
export async function queryPr(
  branch: string,
  owner: string,
  repo: string,
): Promise<PrInfo | undefined> {
  const result = await gh(
    "pr",
    "list",
    "--head",
    branch,
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "number,url,title,state,isDraft,baseRefName",
  );
  const prs = JSON.parse(result) as PrInfo[];
  return prs.length > 0 ? prs[0] : undefined;
}

/**
 * Build a tree of DiscoveredNode from a flat parent map and optional PR data.
 * Returns the root nodes (those whose parent is baseBranch).
 */
function buildTree(
  parentMap: Map<string, string>,
  baseBranch: string,
  prMap: Map<string, PrInfo>,
): DiscoveredNode[] {
  // Build a node for each branch
  const nodeMap = new Map<string, DiscoveredNode>();
  for (const [branch, parent] of parentMap) {
    nodeMap.set(branch, {
      branch,
      parent,
      children: [],
      pr: prMap.get(branch),
    });
  }

  // Wire up children
  const roots: DiscoveredNode[] = [];
  for (const [branch, parent] of parentMap) {
    const node = nodeMap.get(branch)!;
    if (parent === baseBranch) {
      roots.push(node);
    } else {
      const parentNode = nodeMap.get(parent);
      if (parentNode) {
        parentNode.children.push(node);
      }
    }
  }

  return roots;
}

/**
 * Discover the full tree of stacked branches containing the given branch.
 * Returns a tree structure rooted at the base branch.
 */
export async function discoverChain(
  dir: string,
  branch?: string,
  owner?: string,
  repo?: string,
): Promise<DiscoverResult> {
  const baseBranch = await detectBaseBranch(dir);
  const warnings: string[] = [];

  // Resolve current branch if not provided
  let startBranch = branch;
  if (!startBranch) {
    const { code, stdout } = await runGitCommand(
      dir,
      "branch",
      "--show-current",
    );
    if (code !== 0 || !stdout) {
      return { roots: [], baseBranch, warnings };
    }
    startBranch = stdout;
  }

  // If the starting branch IS the base branch, return empty
  if (startBranch === baseBranch) {
    return { roots: [], baseBranch, warnings };
  }

  const allBranches = await listLocalBranches(dir);

  // Walk down to find parents
  const downChain = await walkDown(dir, startBranch, baseBranch, allBranches);

  // Walk up to find descendants (returns flat parent map)
  const parentMap = await walkUp(dir, downChain, baseBranch, allBranches);

  // Query PR info for all discovered branches
  const resolvedOwner = owner ?? "";
  const resolvedRepo = repo ?? "";
  const hasRemote = resolvedOwner.length > 0 && resolvedRepo.length > 0;

  const prMap = new Map<string, PrInfo>();
  if (hasRemote) {
    for (const [branchName, parentName] of parentMap) {
      const pr = await queryPr(branchName, resolvedOwner, resolvedRepo);
      if (pr) {
        prMap.set(branchName, pr);

        // Check for base mismatch
        if (pr.baseRefName !== parentName) {
          warnings.push(
            `PR #${pr.number} for ${branchName} has base "${pr.baseRefName}" but git parent is "${parentName}"`,
          );
        }
      }
    }
  }

  const roots = buildTree(parentMap, baseBranch, prMap);

  return { roots, baseBranch, warnings };
}
