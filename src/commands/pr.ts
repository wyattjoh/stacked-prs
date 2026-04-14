import { gh, selectBestPr } from "../lib/gh.ts";
import { runGitCommand } from "../lib/stack.ts";

export interface PrLookupInfo {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt?: string;
}

export interface PrLookupResult {
  ok: boolean;
  branch: string;
  pr?: PrLookupInfo;
  error?: string;
}

/**
 * Find the best PR for a branch. When `branch` is omitted, resolves the
 * current branch via `git branch --show-current`. Uses `selectBestPr` so an
 * OPEN PR wins over a stale MERGED/CLOSED one on the same head ref.
 */
export async function findPrForBranch(
  dir: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<PrLookupResult> {
  let targetBranch = branch;
  if (!targetBranch) {
    const { code, stdout } = await runGitCommand(
      dir,
      "branch",
      "--show-current",
    );
    if (code !== 0 || !stdout) {
      return {
        ok: false,
        branch: "",
        error: "Could not detect current branch",
      };
    }
    targetBranch = stdout;
  }

  const result = await gh(
    "pr",
    "list",
    "--head",
    targetBranch,
    "--repo",
    `${owner}/${repo}`,
    "--state",
    "all",
    "--json",
    "number,url,state,isDraft,createdAt",
  );
  const prs = JSON.parse(result) as PrLookupInfo[];
  const best = selectBestPr(prs);
  if (!best) {
    return {
      ok: false,
      branch: targetBranch,
      error: `No PR found for branch "${targetBranch}"`,
    };
  }
  return { ok: true, branch: targetBranch, pr: best };
}
