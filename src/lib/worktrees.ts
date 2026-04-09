import { runGitCommand, runGitCommandRaw } from "./stack.ts";

export interface DirtyWorktree {
  /** Absolute path to the worktree. */
  path: string;
  /** Branch checked out in the worktree. */
  branch: string;
  /** Files from `git status --porcelain` (path column only). */
  dirtyFiles: string[];
}

interface ParsedWorktree {
  path: string;
  branch: string | null;
}

function parseWorktreeList(porcelain: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: Partial<ParsedWorktree> = {};

  for (const line of porcelain.split("\n")) {
    if (line === "") {
      if (current.path !== undefined) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? null,
        });
      }
      current = {};
      continue;
    }

    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "detached") {
      current.branch = null;
    }
  }

  if (current.path !== undefined) {
    worktrees.push({ path: current.path, branch: current.branch ?? null });
  }

  return worktrees;
}

/**
 * Parse NUL-delimited `git status --porcelain=v1 -z` output.
 *
 * Each record is `XY <path>` where XY is the two-character status and column
 * 2 is a literal space. Rename (`R`) and copy (`C`) entries emit two records:
 * the new path first, then the old path. We report only the new path.
 */
function parseStatusPorcelainZ(raw: string): string[] {
  const records = raw.split("\0").filter((r) => r.length > 0);
  const files: string[] = [];
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (rec.length < 3) {
      i++;
      continue;
    }
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    files.push(path);
    // Rename/copy entries consume the old path as the next record.
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      i += 2;
    } else {
      i += 1;
    }
  }
  return files;
}

/**
 * Returns worktrees that have uncommitted/staged/untracked changes on a
 * branch in `branchesToTouch`. Clean or out-of-scope worktrees are omitted.
 */
export async function checkWorktreeSafety(
  dir: string,
  branchesToTouch: string[],
): Promise<DirtyWorktree[]> {
  const scope = new Set(branchesToTouch);
  if (scope.size === 0) return [];

  const { code, stdout, stderr } = await runGitCommand(
    dir,
    "worktree",
    "list",
    "--porcelain",
  );
  if (code !== 0) {
    throw new Error(`git worktree list failed: ${stderr}`);
  }

  const worktrees = parseWorktreeList(stdout);
  const dirty: DirtyWorktree[] = [];

  for (const wt of worktrees) {
    if (wt.branch === null) continue;
    if (!scope.has(wt.branch)) continue;

    const statusResult = await runGitCommandRaw(
      wt.path,
      "status",
      "--porcelain=v1",
      "-z",
    );
    if (statusResult.code !== 0) {
      throw new Error(
        `git status failed in ${wt.path}: ${statusResult.stderr.trim()}`,
      );
    }

    const dirtyFiles = parseStatusPorcelainZ(statusResult.stdout);
    if (dirtyFiles.length > 0) {
      dirty.push({ path: wt.path, branch: wt.branch, dirtyFiles });
    }
  }

  return dirty;
}
