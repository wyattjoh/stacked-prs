import { setMockDir } from "../gh.ts";
import { addLandedBranch, addLandedPr } from "../stack.ts";
import type { MergeStrategy } from "../stack.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

export interface TestRepo extends AsyncDisposable {
  dir: string;
  cleanup: () => Promise<void>;
}

export interface TempDir extends AsyncDisposable {
  path: string;
}

/**
 * Create a temp directory that cleans itself up when disposed via
 * `await using`. Failures during cleanup are swallowed to match the
 * best-effort semantics tests expect.
 */
export async function makeTempDir(prefix: string): Promise<TempDir> {
  const path = await Deno.makeTempDir({ prefix });
  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await Deno.remove(path, { recursive: true }).catch(() => {});
    },
  };
}

/**
 * Acquire a temp mock dir, register it with gh.ts via setMockDir, and
 * reset both on disposal. Every test that stubs `gh` calls needs this
 * exact shape; use `await using mock = await makeMockDir()` in tests.
 */
export async function makeMockDir(): Promise<
  AsyncDisposable & { path: string }
> {
  const dir = await makeTempDir("stacked-prs-mock-");
  setMockDir(dir.path);
  return {
    path: dir.path,
    [Symbol.asyncDispose]: async () => {
      setMockDir(undefined);
      await dir[Symbol.asyncDispose]();
    },
  };
}

/** Run a git command in a directory, return trimmed stdout. */
export async function runGit(dir: string, ...args: string[]): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    env: { ...GIT_ENV, HOME: dir },
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();

  if (code !== 0) {
    const errMsg = new TextDecoder().decode(stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${errMsg}`);
  }

  return new TextDecoder().decode(stdout).trim();
}

/** Create a fresh git repo in a temp dir with initial commit on main. */
export async function createTestRepo(): Promise<TestRepo> {
  const dir = await Deno.makeTempDir({ prefix: "stacked-prs-test-" });

  await runGit(dir, "init", "--initial-branch=main");
  await runGit(dir, "config", "user.email", "test@example.com");
  await runGit(dir, "config", "user.name", "Test User");
  await runGit(dir, "config", "core.editor", "true");
  await commitFile(dir, "README.md", "# Test Repo\n");

  const cleanup = () => Deno.remove(dir, { recursive: true });

  return {
    dir,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

/** Create a branch off a parent with a single-file commit. Returns to original branch. */
export async function addBranch(
  dir: string,
  name: string,
  parent: string,
): Promise<void> {
  const current = await runGit(dir, "rev-parse", "--abbrev-ref", "HEAD");

  await runGit(dir, "checkout", parent);
  await runGit(dir, "checkout", "-b", name);

  const filename = name.replaceAll("/", "-") + ".txt";
  await commitFile(dir, filename, `Branch: ${name}\n`);

  await runGit(dir, "checkout", current);
}

/** Commit a file on the current branch. */
export async function commitFile(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(`${dir}/${filename}`, content);
  await runGit(dir, "add", filename);
  await runGit(dir, "commit", "-m", `add ${filename}`);
}

export interface AddTombstoneOptions {
  /** PR number to record under stack.<name>.landed-pr. Omit to skip the PR record. */
  prNumber?: number;
  /**
   * When true (default), also delete any local ref for `branch` so the state
   * matches post-land. Pass false to keep the branch alive (used when testing
   * the live-branch-wins dedup path).
   */
  deleteRef?: boolean;
}

/**
 * Simulate a landed branch by writing the tombstone to stack-level config
 * and removing the local branch ref. The stack config does not need to exist
 * yet; callers are expected to have already set base-branch if they want
 * `getStackTree` to succeed.
 *
 * Requires the caller to be off `branch` (will not detach HEAD). If HEAD is
 * currently on `branch`, check out something else before calling.
 */
export async function addTombstone(
  dir: string,
  stackName: string,
  branch: string,
  options: AddTombstoneOptions = {},
): Promise<void> {
  const { prNumber, deleteRef = true } = options;
  await addLandedBranch(dir, stackName, branch);
  if (prNumber !== undefined) {
    await addLandedPr(dir, stackName, branch, prNumber);
  }
  if (!deleteRef) return;
  const probe = await new Deno.Command("git", {
    args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd: dir,
    env: GIT_ENV,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (probe.code === 0) {
    await runGit(dir, "branch", "-D", branch);
  }
  // Also drop any branch-level stack config so the tombstone reads as a pure
  // "tombstone root" (live branches take precedence in getStackTree dedup).
  for (
    const key of [
      `branch.${branch}.stack-name`,
      `branch.${branch}.stack-parent`,
      `branch.${branch}.stack-order`,
    ]
  ) {
    await new Deno.Command("git", {
      args: ["config", "--unset", key],
      cwd: dir,
      env: GIT_ENV,
    }).output();
  }
}

export interface TrackBranchOptions {
  parent: string;
  baseBranch?: string;
  mergeStrategy?: MergeStrategy;
}

/**
 * Write the per-branch trio (`stack-parent`, optional `base-branch`,
 * optional `merge-strategy`) without going through any production helper.
 * Used by tests that need to set up tracked branches under the new schema.
 */
export async function trackBranch(
  dir: string,
  branch: string,
  opts: TrackBranchOptions,
): Promise<void> {
  await runGit(dir, "config", `branch.${branch}.stack-parent`, opts.parent);
  if (opts.baseBranch !== undefined) {
    await runGit(
      dir,
      "config",
      `branch.${branch}.base-branch`,
      opts.baseBranch,
    );
  }
  if (opts.mergeStrategy !== undefined) {
    await runGit(
      dir,
      "config",
      `branch.${branch}.merge-strategy`,
      opts.mergeStrategy,
    );
  }
}

/**
 * Simulate a PR-merged branch by deleting the ref. Git removes
 * `branch.<n>.*` config keys with the ref. Use this in tests that need
 * "this branch was landed and is gone" without invoking the full `land`
 * command.
 */
export async function markBranchMerged(
  dir: string,
  branch: string,
): Promise<void> {
  await runGit(dir, "branch", "-D", branch);
}
