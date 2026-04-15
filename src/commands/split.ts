import {
  findNode,
  getStackTree,
  runGitCommand,
  setStackNode,
} from "../lib/stack.ts";

export type SplitMode = "by-commit" | "by-file";

export interface SplitByCommitOptions {
  mode: "by-commit";
  stackName: string;
  branch: string;
  /** SHA (or ref) of the last commit to keep on the ORIGINAL branch. */
  at: string;
  /** Name of the new upper branch. */
  newBranch: string;
  dryRun?: boolean;
}

export interface SplitByFileOptions {
  mode: "by-file";
  stackName: string;
  branch: string;
  /** File paths (relative to repo root) to extract into the new lower branch. */
  files: string[];
  /** Name of the new lower branch inserted between original and its parent. */
  newBranch: string;
  /** Commit message for the extracted files commit. */
  extractMessage: string;
  /** Commit message for the remainder commit on the original branch. */
  remainderMessage: string;
  dryRun?: boolean;
}

export type SplitOptions = SplitByCommitOptions | SplitByFileOptions;

export interface SplitPlan {
  mode: SplitMode;
  stackName: string;
  branch: string;
  newBranch: string;
  parent: string;
  baseBranch: string;
  /** by-commit: commits kept on original; by-file: files to extract. */
  keep: string[];
  /** by-commit: commits moved to new upper branch. */
  moved: string[];
  /** Children being reparented (by-commit: to new upper branch). */
  reparentedChildren: string[];
  commands: string[];
}

export type SplitError =
  | "not-in-stack"
  | "invalid-branch-name"
  | "branch-exists"
  | "at-not-ancestor"
  | "at-is-tip"
  | "only-one-commit"
  | "no-changed-files"
  | "file-not-in-branch"
  | "git-failed";

export interface SplitResult {
  ok: boolean;
  plan?: SplitPlan;
  error?: SplitError;
  message?: string;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function gitCmd(...args: string[]): string {
  return ["git", ...args.map(shellQuote)].join(" ");
}

async function validateBranchName(
  dir: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { code, stderr } = await runGitCommand(
    dir,
    "check-ref-format",
    "--branch",
    branch,
  );
  if (code !== 0) {
    return {
      ok: false,
      message: stderr || `invalid branch name: ${branch}`,
    };
  }
  return { ok: true };
}

async function branchExists(dir: string, branch: string): Promise<boolean> {
  const { code } = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  );
  return code === 0;
}

async function listCommits(
  dir: string,
  parent: string,
  branch: string,
): Promise<string[]> {
  const { code, stdout } = await runGitCommand(
    dir,
    "rev-list",
    "--reverse",
    `${parent}..${branch}`,
  );
  if (code !== 0 || !stdout) return [];
  return stdout.split("\n").filter(Boolean);
}

async function listChangedFiles(
  dir: string,
  parent: string,
  branch: string,
): Promise<string[]> {
  const { code, stdout } = await runGitCommand(
    dir,
    "diff",
    "--name-only",
    `${parent}..${branch}`,
  );
  if (code !== 0 || !stdout) return [];
  return stdout.split("\n").filter(Boolean);
}

export async function planSplit(
  dir: string,
  opts: SplitOptions,
): Promise<SplitResult> {
  const nameCheck = await validateBranchName(dir, opts.newBranch);
  if (!nameCheck.ok) {
    return {
      ok: false,
      error: "invalid-branch-name",
      message: nameCheck.message,
    };
  }
  if (await branchExists(dir, opts.newBranch)) {
    return {
      ok: false,
      error: "branch-exists",
      message: `branch "${opts.newBranch}" already exists`,
    };
  }

  const tree = await getStackTree(dir, opts.stackName);
  const node = findNode(tree, opts.branch);
  if (!node) {
    return {
      ok: false,
      error: "not-in-stack",
      message:
        `branch "${opts.branch}" is not part of stack "${opts.stackName}"`,
    };
  }

  if (opts.mode === "by-commit") {
    const commits = await listCommits(dir, node.parent, opts.branch);
    if (commits.length < 2) {
      return {
        ok: false,
        error: "only-one-commit",
        message:
          `branch "${opts.branch}" has ${commits.length} commit(s); need at least 2 to split`,
      };
    }

    // Resolve `at` to a SHA and ensure it's in the range.
    const { code, stdout: atSha } = await runGitCommand(
      dir,
      "rev-parse",
      opts.at,
    );
    if (code !== 0) {
      return {
        ok: false,
        error: "at-not-ancestor",
        message: `cannot resolve commit "${opts.at}"`,
      };
    }
    if (!commits.includes(atSha)) {
      return {
        ok: false,
        error: "at-not-ancestor",
        message:
          `commit "${opts.at}" is not in the range ${node.parent}..${opts.branch}`,
      };
    }
    if (atSha === commits[commits.length - 1]) {
      return {
        ok: false,
        error: "at-is-tip",
        message:
          `commit "${opts.at}" is the branch tip; nothing would be moved to "${opts.newBranch}"`,
      };
    }

    const splitIdx = commits.indexOf(atSha);
    const kept = commits.slice(0, splitIdx + 1);
    const moved = commits.slice(splitIdx + 1);

    const reparented = node.children.map((c) => c.branch);
    const tipSha = commits[commits.length - 1];

    const cmds: string[] = [];
    cmds.push(gitCmd("checkout", opts.branch));
    cmds.push(gitCmd("checkout", "-b", opts.newBranch, tipSha));
    cmds.push(gitCmd("checkout", opts.branch));
    cmds.push(gitCmd("reset", "--hard", atSha));
    cmds.push(
      gitCmd("config", `branch.${opts.newBranch}.stack-name`, opts.stackName),
    );
    cmds.push(
      gitCmd(
        "config",
        `branch.${opts.newBranch}.stack-parent`,
        opts.branch,
      ),
    );
    for (const child of reparented) {
      cmds.push(
        gitCmd("config", `branch.${child}.stack-parent`, opts.newBranch),
      );
    }

    return {
      ok: true,
      plan: {
        mode: "by-commit",
        stackName: opts.stackName,
        branch: opts.branch,
        newBranch: opts.newBranch,
        parent: node.parent,
        baseBranch: tree.baseBranch,
        keep: kept,
        moved,
        reparentedChildren: reparented,
        commands: cmds,
      },
    };
  }

  // by-file
  const changed = await listChangedFiles(dir, node.parent, opts.branch);
  if (changed.length === 0) {
    return {
      ok: false,
      error: "no-changed-files",
      message:
        `branch "${opts.branch}" has no file changes relative to its parent "${node.parent}"`,
    };
  }

  const changedSet = new Set(changed);
  for (const f of opts.files) {
    if (!changedSet.has(f)) {
      return {
        ok: false,
        error: "file-not-in-branch",
        message: `file "${f}" is not among ${opts.branch}'s changes`,
      };
    }
  }

  const remainder = changed.filter((f) => !opts.files.includes(f));
  const cmds: string[] = [];
  cmds.push(gitCmd("checkout", node.parent));
  cmds.push(gitCmd("checkout", "-b", opts.newBranch));
  cmds.push(gitCmd("checkout", opts.branch, "--", ...opts.files));
  cmds.push(gitCmd("add", "--", ...opts.files));
  cmds.push(gitCmd("commit", "-m", opts.extractMessage));
  cmds.push(gitCmd("checkout", opts.branch));
  cmds.push(gitCmd("reset", "--hard", opts.newBranch));
  if (remainder.length > 0) {
    cmds.push(gitCmd("checkout", opts.branch + "@{1}", "--", ...remainder));
    cmds.push(gitCmd("add", "--", ...remainder));
    cmds.push(gitCmd("commit", "-m", opts.remainderMessage));
  }
  cmds.push(
    gitCmd("config", `branch.${opts.newBranch}.stack-name`, opts.stackName),
  );
  cmds.push(
    gitCmd(
      "config",
      `branch.${opts.newBranch}.stack-parent`,
      node.parent,
    ),
  );
  cmds.push(
    gitCmd(
      "config",
      `branch.${opts.branch}.stack-parent`,
      opts.newBranch,
    ),
  );

  return {
    ok: true,
    plan: {
      mode: "by-file",
      stackName: opts.stackName,
      branch: opts.branch,
      newBranch: opts.newBranch,
      parent: node.parent,
      baseBranch: tree.baseBranch,
      keep: opts.files,
      moved: [],
      reparentedChildren: [],
      commands: cmds,
    },
  };
}

async function runOrFail(
  dir: string,
  ...args: string[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { code, stderr, stdout } = await runGitCommand(dir, ...args);
  if (code !== 0) {
    return { ok: false, message: (stderr || stdout).trim() };
  }
  return { ok: true };
}

async function executeByCommit(
  dir: string,
  opts: SplitByCommitOptions,
  plan: SplitPlan,
): Promise<SplitResult> {
  const tipSha = plan.moved[plan.moved.length - 1];
  const atSha = plan.keep[plan.keep.length - 1];

  const r1 = await runOrFail(dir, "checkout", opts.branch);
  if (!r1.ok) return { ok: false, error: "git-failed", message: r1.message };

  const r2 = await runOrFail(dir, "checkout", "-b", opts.newBranch, tipSha);
  if (!r2.ok) return { ok: false, error: "git-failed", message: r2.message };

  const r3 = await runOrFail(dir, "checkout", opts.branch);
  if (!r3.ok) return { ok: false, error: "git-failed", message: r3.message };

  const r4 = await runOrFail(dir, "reset", "--hard", atSha);
  if (!r4.ok) return { ok: false, error: "git-failed", message: r4.message };

  await setStackNode(dir, opts.newBranch, opts.stackName, opts.branch);
  for (const child of plan.reparentedChildren) {
    await setStackNode(dir, child, opts.stackName, opts.newBranch);
  }

  return { ok: true, plan };
}

async function executeByFile(
  dir: string,
  opts: SplitByFileOptions,
  plan: SplitPlan,
): Promise<SplitResult> {
  const changed = await listChangedFiles(dir, plan.parent, opts.branch);
  const extracted = new Set(opts.files);
  const remainder = changed.filter((f) => !extracted.has(f));

  // Capture the original tip so we can restore non-extracted files from it.
  const { code: tipCode, stdout: originalTip } = await runGitCommand(
    dir,
    "rev-parse",
    opts.branch,
  );
  if (tipCode !== 0) {
    return {
      ok: false,
      error: "git-failed",
      message: "cannot resolve branch tip",
    };
  }

  // Build NEW branch off the parent with only the extracted files.
  const r1 = await runOrFail(dir, "checkout", plan.parent);
  if (!r1.ok) return { ok: false, error: "git-failed", message: r1.message };

  const r2 = await runOrFail(dir, "checkout", "-b", opts.newBranch);
  if (!r2.ok) return { ok: false, error: "git-failed", message: r2.message };

  const r3 = await runOrFail(
    dir,
    "checkout",
    originalTip,
    "--",
    ...opts.files,
  );
  if (!r3.ok) return { ok: false, error: "git-failed", message: r3.message };

  const r4 = await runOrFail(dir, "add", "--", ...opts.files);
  if (!r4.ok) return { ok: false, error: "git-failed", message: r4.message };

  const r5 = await runOrFail(dir, "commit", "-m", opts.extractMessage);
  if (!r5.ok) return { ok: false, error: "git-failed", message: r5.message };

  // Reset ORIGINAL branch to NEW, then reapply non-extracted changes from tip.
  const r6 = await runOrFail(dir, "checkout", opts.branch);
  if (!r6.ok) return { ok: false, error: "git-failed", message: r6.message };

  const r7 = await runOrFail(dir, "reset", "--hard", opts.newBranch);
  if (!r7.ok) return { ok: false, error: "git-failed", message: r7.message };

  if (remainder.length > 0) {
    const r8 = await runOrFail(
      dir,
      "checkout",
      originalTip,
      "--",
      ...remainder,
    );
    if (!r8.ok) return { ok: false, error: "git-failed", message: r8.message };

    const r9 = await runOrFail(dir, "add", "--", ...remainder);
    if (!r9.ok) return { ok: false, error: "git-failed", message: r9.message };

    const commit = await runOrFail(
      dir,
      "commit",
      "-m",
      opts.remainderMessage,
    );
    if (!commit.ok) {
      return { ok: false, error: "git-failed", message: commit.message };
    }
  }

  await setStackNode(dir, opts.newBranch, opts.stackName, plan.parent);
  await setStackNode(dir, opts.branch, opts.stackName, opts.newBranch);

  return { ok: true, plan };
}

export async function executeSplit(
  dir: string,
  opts: SplitOptions,
): Promise<SplitResult> {
  const planResult = await planSplit(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;
  const plan = planResult.plan;

  if (opts.mode === "by-commit") return executeByCommit(dir, opts, plan);
  return executeByFile(dir, opts, plan);
}

export function split(
  dir: string,
  opts: SplitOptions,
): Promise<SplitResult> {
  if (opts.dryRun) return planSplit(dir, opts);
  return executeSplit(dir, opts);
}
