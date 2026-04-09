import {
  getAllNodes,
  getAllStackTrees,
  runGitCommand,
  type StackTree,
} from "../../lib/stack.ts";
import { gh, selectBestPr } from "../../lib/gh.ts";
import { listBranchWorktrees } from "../../lib/worktrees.ts";
import type { CommitInfo, PrInfo, SyncStatus, WorktreeInfo } from "../types.ts";

export interface LoadLocalResult {
  trees: StackTree[];
  syncByBranch: Map<string, SyncStatus>;
  worktreeByBranch: Map<string, WorktreeInfo>;
  allBranches: string[];
  currentBranch: string | null;
}

async function computeSync(
  dir: string,
  branch: string,
  parent: string,
): Promise<SyncStatus> {
  const { code: fwd } = await runGitCommand(
    dir,
    "merge-base",
    "--is-ancestor",
    parent,
    branch,
  );
  if (fwd === 0) return "up-to-date";
  const { code: rev } = await runGitCommand(
    dir,
    "merge-base",
    "--is-ancestor",
    branch,
    parent,
  );
  if (rev === 0) return "behind-parent";
  return "diverged";
}

export async function loadLocal(dir: string): Promise<LoadLocalResult> {
  const trees = await getAllStackTrees(dir);

  const syncByBranch = new Map<string, SyncStatus>();
  const allBranches: string[] = [];
  for (const tree of trees) {
    for (const node of getAllNodes(tree)) {
      allBranches.push(node.branch);
      syncByBranch.set(
        node.branch,
        await computeSync(dir, node.branch, node.parent),
      );
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
        const out = await gh(
          { signal: opts.signal },
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "all",
          "--json",
          "number,url,state,isDraft,createdAt",
        );
        if (opts.signal?.aborted) return;
        const parsed = JSON.parse(out) as PrInfo[];
        opts.onLoaded(branch, selectBestPr(parsed));
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
