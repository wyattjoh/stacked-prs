import {
  detectDefaultBranch,
  gitConfig,
  type MergeStrategy,
  runGitCommand,
} from "../lib/stack.ts";

export interface CreateBranchOptions {
  branch: string;
  message?: string;
  createWorktree?: string;
  stackName?: string;
  mergeStrategy?: MergeStrategy;
  force?: boolean;
  dryRun?: boolean;
}

export type CreateCase = "child" | "auto-init" | "auto-init-worktree";

export interface CreatePlan {
  case: CreateCase;
  branch: string;
  parent: string;
  baseBranch: string;
  stackName: string;
  mergeStrategy: MergeStrategy;
  willCommit: boolean;
  worktreePath?: string;
}

export type CreateError =
  | "invalid-branch-name"
  | "branch-exists"
  | "not-on-stack"
  | "worktree-requires-base"
  | "worktree-exists"
  | "flag-misuse"
  | "stack-exists"
  | "nothing-staged"
  | "git-failed";

export interface CreateResult {
  ok: boolean;
  plan?: CreatePlan;
  error?: CreateError;
  message?: string;
}

async function validateBranchName(
  dir: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!branch) return { ok: false, message: "branch name is required" };
  const { code, stderr } = await runGitCommand(
    dir,
    "check-ref-format",
    "--branch",
    branch,
  );
  if (code !== 0) {
    return { ok: false, message: stderr || `invalid branch name: ${branch}` };
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

async function currentBranch(dir: string): Promise<string> {
  const { code, stdout } = await runGitCommand(dir, "branch", "--show-current");
  if (code !== 0) return "";
  return stdout;
}

async function runGitOrFail(
  dir: string,
  ...args: string[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { code, stderr, stdout } = await runGitCommand(dir, ...args);
  if (code !== 0) {
    return { ok: false, message: (stderr || stdout).trim() };
  }
  return { ok: true };
}

export async function planCreate(
  dir: string,
  opts: CreateBranchOptions,
): Promise<CreateResult> {
  const nameCheck = await validateBranchName(dir, opts.branch);
  if (!nameCheck.ok) {
    return {
      ok: false,
      error: "invalid-branch-name",
      message: nameCheck.message,
    };
  }

  if (await branchExists(dir, opts.branch)) {
    return {
      ok: false,
      error: "branch-exists",
      message:
        `branch "${opts.branch}" already exists; use \`move\` to reparent or delete it first`,
    };
  }

  const current = await currentBranch(dir);
  if (!current) {
    return {
      ok: false,
      error: "not-on-stack",
      message:
        "not on a branch (detached HEAD); run `init` or switch to a stack branch",
    };
  }

  const currentStack = await gitConfig(
    dir,
    `branch.${current}.stack-name`,
  );

  if (currentStack) {
    // Case 1: child in existing stack.
    if (opts.createWorktree !== undefined) {
      return {
        ok: false,
        error: "worktree-requires-base",
        message:
          "--create-worktree only applies when starting a new stack from the base branch",
      };
    }
    if (opts.stackName !== undefined || opts.mergeStrategy !== undefined) {
      return {
        ok: false,
        error: "flag-misuse",
        message:
          "--stack-name and --merge-strategy only apply when auto-initing from the base branch",
      };
    }
    const baseBranch = await gitConfig(
      dir,
      `stack.${currentStack}.base-branch`,
    );
    const strategy = (await gitConfig(
      dir,
      `stack.${currentStack}.merge-strategy`,
    )) as MergeStrategy | undefined;
    if (!baseBranch || !strategy) {
      return {
        ok: false,
        error: "git-failed",
        message:
          `stack "${currentStack}" is missing base-branch or merge-strategy config`,
      };
    }

    return {
      ok: true,
      plan: {
        case: "child",
        branch: opts.branch,
        parent: current,
        baseBranch,
        stackName: currentStack,
        mergeStrategy: strategy,
        willCommit: opts.message !== undefined,
      },
    };
  }

  // Not in a stack — try auto-init from the base branch.
  let defaultBranch: string;
  try {
    defaultBranch = await detectDefaultBranch(dir);
  } catch (err) {
    return {
      ok: false,
      error: "not-on-stack",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (current !== defaultBranch) {
    return {
      ok: false,
      error: "not-on-stack",
      message:
        `current branch "${current}" is not part of a stack and is not the base branch ("${defaultBranch}"); run \`init\` or switch branches`,
    };
  }

  const stackName = opts.stackName ?? opts.branch;
  const mergeStrategy: MergeStrategy = opts.mergeStrategy ?? "merge";

  const existingStackBase = await gitConfig(
    dir,
    `stack.${stackName}.base-branch`,
  );
  if (existingStackBase !== undefined) {
    return {
      ok: false,
      error: "stack-exists",
      message:
        `stack "${stackName}" already exists (stack.${stackName}.base-branch is set); choose a different --stack-name`,
    };
  }

  const worktreeCase = opts.createWorktree !== undefined;

  return {
    ok: true,
    plan: {
      case: worktreeCase ? "auto-init-worktree" : "auto-init",
      branch: opts.branch,
      parent: defaultBranch,
      baseBranch: defaultBranch,
      stackName,
      mergeStrategy,
      willCommit: opts.message !== undefined,
      worktreePath: worktreeCase
        ? `${opts.createWorktree}/${opts.branch}`
        : undefined,
    },
  };
}

export async function executeCreate(
  dir: string,
  opts: CreateBranchOptions,
): Promise<CreateResult> {
  const planResult = await planCreate(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;

  const plan = planResult.plan;

  if (plan.case === "child") {
    const checkout = await runGitOrFail(dir, "checkout", "-b", plan.branch);
    if (!checkout.ok) {
      return { ok: false, error: "git-failed", message: checkout.message };
    }

    if (opts.message !== undefined) {
      const commit = await runGitCommand(
        dir,
        "commit",
        "-m",
        opts.message,
      );
      if (commit.code !== 0) {
        const stderr = (commit.stderr || commit.stdout).toLowerCase();
        if (
          stderr.includes("nothing to commit") ||
          stderr.includes("no changes added")
        ) {
          return {
            ok: false,
            error: "nothing-staged",
            message: "nothing staged; stage changes before using -m",
          };
        }
        return {
          ok: false,
          error: "git-failed",
          message: (commit.stderr || commit.stdout).trim(),
        };
      }
    }

    const setStack = await runGitOrFail(
      dir,
      "config",
      `branch.${plan.branch}.stack-name`,
      plan.stackName,
    );
    if (!setStack.ok) {
      return { ok: false, error: "git-failed", message: setStack.message };
    }
    const setParent = await runGitOrFail(
      dir,
      "config",
      `branch.${plan.branch}.stack-parent`,
      plan.parent,
    );
    if (!setParent.ok) {
      return { ok: false, error: "git-failed", message: setParent.message };
    }

    return { ok: true, plan };
  }

  if (plan.case === "auto-init") {
    const checkout = await runGitOrFail(dir, "checkout", "-b", plan.branch);
    if (!checkout.ok) {
      return { ok: false, error: "git-failed", message: checkout.message };
    }

    if (opts.message !== undefined) {
      const commit = await runGitCommand(dir, "commit", "-m", opts.message);
      if (commit.code !== 0) {
        const stderr = (commit.stderr || commit.stdout).toLowerCase();
        if (
          stderr.includes("nothing to commit") ||
          stderr.includes("no changes added")
        ) {
          return {
            ok: false,
            error: "nothing-staged",
            message: "nothing staged; stage changes before using -m",
          };
        }
        return {
          ok: false,
          error: "git-failed",
          message: (commit.stderr || commit.stdout).trim(),
        };
      }
    }

    const writes: Array<[string, string]> = [
      [`branch.${plan.branch}.stack-name`, plan.stackName],
      [`branch.${plan.branch}.stack-parent`, plan.baseBranch],
      [`stack.${plan.stackName}.base-branch`, plan.baseBranch],
      [`stack.${plan.stackName}.merge-strategy`, plan.mergeStrategy],
    ];
    for (const [key, value] of writes) {
      const r = await runGitOrFail(dir, "config", key, value);
      if (!r.ok) {
        return { ok: false, error: "git-failed", message: r.message };
      }
    }

    return { ok: true, plan };
  }

  // Case 3 added in the next task.
  return {
    ok: false,
    error: "git-failed",
    message: `case ${plan.case} not yet implemented`,
  };
}

export function create(
  dir: string,
  opts: CreateBranchOptions,
): Promise<CreateResult> {
  if (opts.dryRun) return planCreate(dir, opts);
  return executeCreate(dir, opts);
}
