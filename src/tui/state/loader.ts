import {
  computeSyncStatus,
  getAllNodes,
  getAllStackTrees,
  getLandedPrs,
  runGitCommand,
  type StackTree,
} from "../../lib/stack.ts";
import { listPrsForBranch } from "../../lib/gh.ts";
import { listBranchWorktrees } from "../../lib/worktrees.ts";
import type { CommitInfo, PrInfo, SyncStatus, WorktreeInfo } from "../types.ts";

export interface LoadLocalResult {
  trees: StackTree[];
  syncByBranch: Map<string, SyncStatus>;
  worktreeByBranch: Map<string, WorktreeInfo>;
  allBranches: string[];
  /**
   * PR info for tombstoned (landed) branches, reconstructed from
   * `stack.<n>.landed-pr`. Surfaces merged PRs even after the branch ref has
   * been deleted and `gh pr list --head <branch>` no longer returns it.
   * `url` is left empty because the owner/repo isn't known at load time;
   * callers that need a URL should look it up lazily.
   */
  landedPrByBranch: Map<string, PrInfo>;
  currentBranch: string | null;
}

export async function loadLocal(dir: string): Promise<LoadLocalResult> {
  const trees = await getAllStackTrees(dir);

  const syncByBranch = new Map<string, SyncStatus>();
  const allBranches: string[] = [];
  const landedPrByBranch = new Map<string, PrInfo>();
  const landedPrByStack = new Map<string, Map<string, number>>();
  await Promise.all(
    trees.map(async (tree) => {
      landedPrByStack.set(
        tree.stackName,
        await getLandedPrs(dir, tree.stackName),
      );
    }),
  );
  for (const tree of trees) {
    const stackLandedPrs = landedPrByStack.get(tree.stackName);
    for (const node of getAllNodes(tree)) {
      allBranches.push(node.branch);
      if (node.merged) {
        syncByBranch.set(node.branch, "landed");
        const num = stackLandedPrs?.get(node.branch);
        if (num !== undefined) {
          landedPrByBranch.set(node.branch, {
            number: num,
            url: "",
            state: "MERGED",
            isDraft: false,
          });
        }
      } else {
        syncByBranch.set(
          node.branch,
          await computeSyncStatus(dir, node.branch, node.parent),
        );
      }
    }
  }

  // Worktree info is best-effort: a failure here (e.g. older git without
  // worktree porcelain) should not take down the TUI initial load.
  let worktreeByBranch = new Map<string, WorktreeInfo>();
  try {
    const res = await listBranchWorktrees(dir);
    worktreeByBranch = res.byBranch;
  } catch {
    // leave empty
  }

  const { code, stdout } = await runGitCommand(dir, "branch", "--show-current");
  const currentBranch = code === 0 && stdout ? stdout : null;

  return {
    trees,
    syncByBranch,
    worktreeByBranch,
    allBranches,
    landedPrByBranch,
    currentBranch,
  };
}

export interface LoadPrsOptions {
  branches: string[];
  concurrency: number;
  signal?: AbortSignal;
  onLoaded: (branch: string, pr: PrInfo | null) => void;
  onError: (branch: string, message: string) => void;
}

export async function loadPrsProgressive(
  opts: LoadPrsOptions,
): Promise<void> {
  if (opts.signal?.aborted) return;

  let idx = 0;
  const work = async (): Promise<void> => {
    while (idx < opts.branches.length) {
      if (opts.signal?.aborted) return;
      const branch = opts.branches[idx++];
      try {
        const best = await listPrsForBranch(branch, { signal: opts.signal });
        if (opts.signal?.aborted) return;
        opts.onLoaded(branch, best);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        opts.onError(branch, (err as Error).message);
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(opts.concurrency, opts.branches.length) },
    () => work(),
  );
  await Promise.all(workers);
}

export async function loadCommits(
  dir: string,
  branch: string,
  parent: string,
  signal?: AbortSignal,
): Promise<CommitInfo[]> {
  if (signal?.aborted) return [];
  const { code, stdout } = await runGitCommand(
    dir,
    "log",
    `${parent}..${branch}`,
    "--format=%h%x09%s",
  );
  if (code !== 0 || !stdout) return [];
  return stdout.split("\n").map((line) => {
    const [sha, ...rest] = line.split("\t");
    return { sha, subject: rest.join("\t") };
  });
}
