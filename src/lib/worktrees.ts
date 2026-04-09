import { relative as pathRelative } from "@std/path";
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

/** Per-branch worktree info for TUI display. */
export interface BranchWorktreeInfo {
  /** Absolute path to the worktree. */
  path: string;
  /**
   * Display path. For the branch checked out in the main (primary) worktree
   * this is the absolute main-worktree path with `$HOME` replaced by `~`.
   * For branches in other worktrees, this is the path relative to the main
   * worktree (e.g. `../stacked-prs-feat-foo`).
   */
  displayPath: string;
  /** True when `git status` in that worktree reports any changes. */
  dirty: boolean;
}

export interface BranchWorktreesResult {
  /** Absolute path to the main (primary) worktree. */
  mainPath: string;
  byBranch: Map<string, BranchWorktreeInfo>;
}

function withTilde(path: string, home: string | undefined): string {
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

async function isWorktreeDirty(wtPath: string): Promise<boolean> {
  const { code, stdout } = await runGitCommandRaw(
    wtPath,
    "status",
    "--porcelain=v1",
    "-z",
  );
  if (code !== 0) return false;
  return stdout.length > 0;
}

/**
 * List every git worktree in `dir` and, for each one with a branch checked
 * out, return its display path and dirty state. The first worktree entry
 * from `git worktree list --porcelain` is treated as the main worktree;
 * all other worktrees' display paths are computed relative to it.
 */
export async function listBranchWorktrees(
  dir: string,
): Promise<BranchWorktreesResult> {
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
  const byBranch = new Map<string, BranchWorktreeInfo>();
  if (worktrees.length === 0) {
    return { mainPath: dir, byBranch };
  }

  const mainPath = worktrees[0].path;
  const home = Deno.env.get("HOME");

  const entries = await Promise.all(
    worktrees
      .filter((wt): wt is ParsedWorktree & { branch: string } =>
        wt.branch !== null
      )
      .map(async (wt) => {
        const dirty = await isWorktreeDirty(wt.path);
        const displayPath = wt.path === mainPath
          ? withTilde(mainPath, home)
          : pathRelative(mainPath, wt.path);
        return [wt.branch, { path: wt.path, displayPath, dirty }] as const;
      }),
  );

  for (const [branch, info] of entries) {
    byBranch.set(branch, info);
  }

  return { mainPath, byBranch };
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

export interface InProgressOperation {
  worktreePath: string;
  branch: string | null;
  operation: "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";
}

const OP_MARKERS: ReadonlyArray<
  readonly [string, InProgressOperation["operation"]]
> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface WorktreeCollision {
  branch: string;
  worktreePath: string;
  /** True when `git status` in the collision worktree reports any changes. */
  dirty: boolean;
}

/**
 * Return branches from `branches` that are checked out in a linked
 * (non-primary) worktree. The primary worktree is the first entry
 * returned by `git worktree list --porcelain`; collisions are defined
 * against the other worktrees because the land sequence operates in the
 * primary.
 */
export async function findWorktreeCollisions(
  dir: string,
  branches: string[],
): Promise<WorktreeCollision[]> {
  if (branches.length === 0) return [];

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
  if (worktrees.length === 0) return [];

  const primary = worktrees[0].path;
  const scope = new Set(branches);
  const collisions: WorktreeCollision[] = [];

  for (const wt of worktrees) {
    if (wt.path === primary) continue;
    if (wt.branch === null) continue;
    if (!scope.has(wt.branch)) continue;
    const dirty = await isWorktreeDirty(wt.path);
    collisions.push({ branch: wt.branch, worktreePath: wt.path, dirty });
  }

  return collisions;
}

/**
 * List every in-progress git operation across all worktrees. For each
 * worktree, check its per-worktree gitdir for operation marker files.
 * At most one operation per worktree.
 */
export async function listInProgressOperations(
  dir: string,
): Promise<InProgressOperation[]> {
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
  const ops: InProgressOperation[] = [];

  for (const wt of worktrees) {
    const gitDir = await runGitCommand(wt.path, "rev-parse", "--git-dir");
    if (gitDir.code !== 0) continue;
    const gitDirPath = gitDir.stdout.startsWith("/")
      ? gitDir.stdout
      : `${wt.path}/${gitDir.stdout}`;

    for (const [marker, operation] of OP_MARKERS) {
      if (await fileExists(`${gitDirPath}/${marker}`)) {
        ops.push({
          worktreePath: wt.path,
          branch: wt.branch,
          operation,
        });
        break;
      }
    }
  }

  return ops;
}
