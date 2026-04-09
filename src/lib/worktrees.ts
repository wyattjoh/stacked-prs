import { runGitCommand } from "./stack.ts";

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

function parseStatusPorcelain(porcelain: string): string[] {
  if (!porcelain) return [];
  // Porcelain v1 format: "XY path" where XY is two status chars. Note that
  // `runGitCommand` trims stdout, so a leading space in the first line's
  // status (e.g. " M path") may have been stripped. Match the status chars
  // and any whitespace, then capture the path.
  const files: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    const match = line.match(/^.{1,2}\s+(.+)$/);
    if (match) files.push(match[1]);
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

    const statusResult = await runGitCommand(
      wt.path,
      "status",
      "--porcelain",
    );
    if (statusResult.code !== 0) {
      throw new Error(
        `git status failed in ${wt.path}: ${statusResult.stderr}`,
      );
    }

    const dirtyFiles = parseStatusPorcelain(statusResult.stdout);
    if (dirtyFiles.length > 0) {
      dirty.push({ path: wt.path, branch: wt.branch, dirtyFiles });
    }
  }

  return dirty;
}
