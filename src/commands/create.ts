import { join } from "@std/path";
import {
  detectDefaultBranch,
  getDefaultMergeStrategy,
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
  /** The literal git commands that will execute in order. For display only. */
  commands: string[];
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

async function currentBranch(
  dir: string,
): Promise<
  | { ok: true; branch: string; detached: boolean }
  | { ok: false; message: string }
> {
  const { code, stdout, stderr } = await runGitCommand(
    dir,
    "branch",
    "--show-current",
  );
  if (code !== 0) {
    return { ok: false, message: (stderr || stdout).trim() };
  }
  if (!stdout) {
    return { ok: true, branch: "", detached: true };
  }
  return { ok: true, branch: stdout, detached: false };
}

/** Escape a string for safe use as a literal match in a git `--get-regexp` pattern. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// attemptCommit checks the index first (locale-free) before running git commit.
// Returns nothing-staged when the index is clean, git-failed on commit error.
async function attemptCommit(
  dir: string,
  message: string,
): Promise<
  | { ok: true }
  | { ok: false; error: "nothing-staged" | "git-failed"; message: string }
> {
  // git diff --cached --quiet exits 0 when index is clean, 1 when staged changes exist.
  const diffCheck = await runGitCommand(dir, "diff", "--cached", "--quiet");
  if (diffCheck.code === 0) {
    return {
      ok: false,
      error: "nothing-staged",
      message: "nothing staged; stage changes before using -m",
    };
  }
  const commit = await runGitCommand(dir, "commit", "-m", message);
  if (commit.code !== 0) {
    return {
      ok: false,
      error: "git-failed",
      message: (commit.stderr || commit.stdout).trim(),
    };
  }
  return { ok: true };
}

// addWorktree wraps git worktree add and remaps path/registration conflicts to
// the worktree-exists error rather than the generic git-failed error.
async function addWorktree(
  dir: string,
  ...args: string[]
): Promise<
  | { ok: true }
  | { ok: false; error: "worktree-exists" | "git-failed"; message: string }
> {
  const { code, stdout, stderr } = await runGitCommand(
    dir,
    "worktree",
    "add",
    ...args,
  );
  if (code === 0) return { ok: true };
  const combined = (stderr || stdout).toLowerCase();
  if (
    combined.includes("already exists") ||
    combined.includes("already registered") ||
    combined.includes("is already used by worktree")
  ) {
    return {
      ok: false,
      error: "worktree-exists",
      message: (stderr || stdout).trim(),
    };
  }
  return { ok: false, error: "git-failed", message: (stderr || stdout).trim() };
}

// rollbackNewBranch attempts to undo a checkout -b that succeeded before a
// subsequent step failed. Reports whether the rollback was fully completed so
// callers can surface a warning when it is only partial.
async function rollbackNewBranch(
  dir: string,
  baseBranch: string,
  newBranch: string,
): Promise<{ fullyRolledBack: boolean }> {
  const checkout = await runGitCommand(dir, "checkout", baseBranch);
  if (checkout.code !== 0) {
    return { fullyRolledBack: false };
  }
  const del = await runGitCommand(dir, "branch", "-D", newBranch);
  return { fullyRolledBack: del.code === 0 };
}

function shellQuote(arg: string): string {
  // Conservative: quote anything containing chars that would matter in a
  // copy-paste shell invocation. Simple single-quote strategy with escape.
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function gitCmd(...args: string[]): string {
  return ["git", ...args.map(shellQuote)].join(" ");
}

function commandsForPlan(
  plan: Omit<CreatePlan, "commands">,
  message: string | undefined,
): string[] {
  const cmds: string[] = [];

  if (plan.case === "child" || plan.case === "auto-init") {
    cmds.push(gitCmd("checkout", "-b", plan.branch));
    if (message !== undefined) {
      cmds.push(gitCmd("commit", "-m", message));
    }
  } else if (plan.case === "auto-init-worktree") {
    if (message !== undefined) {
      cmds.push(gitCmd("checkout", "-b", plan.branch));
      cmds.push(gitCmd("commit", "-m", message));
      cmds.push(gitCmd("checkout", "-"));
      cmds.push(gitCmd("worktree", "add", plan.worktreePath!, plan.branch));
    } else {
      cmds.push(
        gitCmd("worktree", "add", plan.worktreePath!, "-b", plan.branch),
      );
    }
  }

  cmds.push(
    gitCmd("config", `branch.${plan.branch}.stack-name`, plan.stackName),
  );
  cmds.push(
    gitCmd("config", `branch.${plan.branch}.stack-parent`, plan.parent),
  );

  if (plan.case !== "child") {
    cmds.push(
      gitCmd(
        "config",
        `stack.${plan.stackName}.base-branch`,
        plan.baseBranch,
      ),
    );
    cmds.push(
      gitCmd(
        "config",
        `stack.${plan.stackName}.merge-strategy`,
        plan.mergeStrategy,
      ),
    );
  }

  return cmds;
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

  const currentResult = await currentBranch(dir);
  if (!currentResult.ok) {
    return {
      ok: false,
      error: "git-failed",
      message: currentResult.message,
    };
  }
  if (currentResult.detached) {
    return {
      ok: false,
      error: "not-on-stack",
      message:
        "not on a branch (detached HEAD); run `init` or switch to a stack branch",
    };
  }
  const current = currentResult.branch;

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

    const childPlan: Omit<CreatePlan, "commands"> = {
      case: "child",
      branch: opts.branch,
      parent: current,
      baseBranch,
      stackName: currentStack,
      mergeStrategy: strategy,
      willCommit: opts.message !== undefined,
    };

    return {
      ok: true,
      plan: {
        ...childPlan,
        commands: commandsForPlan(childPlan, opts.message),
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
  const mergeStrategy: MergeStrategy = opts.mergeStrategy ??
    await getDefaultMergeStrategy(dir);

  // Use --get-regexp to catch any orphan stack-level keys from a prior partial
  // run, not just the base-branch key.
  const existingStack = await runGitCommand(
    dir,
    "config",
    "--get-regexp",
    `^stack\\.${escapeRegex(stackName)}\\.`,
  );
  if (existingStack.code === 0 && existingStack.stdout) {
    return {
      ok: false,
      error: "stack-exists",
      message:
        `stack "${stackName}" already has config entries; choose a different --stack-name`,
    };
  }

  const worktreeCase = opts.createWorktree !== undefined;
  const worktreePath = worktreeCase
    ? join(opts.createWorktree!, opts.branch)
    : undefined;

  if (worktreeCase && worktreePath) {
    try {
      await Deno.stat(worktreePath);
      return {
        ok: false,
        error: "worktree-exists",
        message: `worktree path already exists: ${worktreePath}`,
      };
    } catch {
      // Does not exist — good.
    }
  }

  const partialPlan: Omit<CreatePlan, "commands"> = {
    case: worktreeCase ? "auto-init-worktree" : "auto-init",
    branch: opts.branch,
    parent: defaultBranch,
    baseBranch: defaultBranch,
    stackName,
    mergeStrategy,
    willCommit: opts.message !== undefined,
    worktreePath,
  };

  return {
    ok: true,
    plan: {
      ...partialPlan,
      commands: commandsForPlan(partialPlan, opts.message),
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
      const commit = await attemptCommit(dir, opts.message);
      if (!commit.ok) {
        return { ok: false, error: commit.error, message: commit.message };
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
      const commit = await attemptCommit(dir, opts.message);
      if (!commit.ok) {
        return { ok: false, error: commit.error, message: commit.message };
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

  if (plan.case === "auto-init-worktree") {
    if (!plan.worktreePath) {
      return {
        ok: false,
        error: "git-failed",
        message: "internal: auto-init-worktree plan missing worktreePath",
      };
    }

    if (opts.message !== undefined) {
      // Commit staged work on the new branch in the main worktree, then
      // return to base and eject the new branch into its own worktree.
      const checkout = await runGitOrFail(dir, "checkout", "-b", plan.branch);
      if (!checkout.ok) {
        return { ok: false, error: "git-failed", message: checkout.message };
      }

      const commit = await attemptCommit(dir, opts.message);
      if (!commit.ok) {
        const rb = await rollbackNewBranch(dir, plan.baseBranch, plan.branch);
        const suffix = rb.fullyRolledBack
          ? ""
          : ` (rollback incomplete; run \`cli.ts clean\` to tidy up)`;
        return {
          ok: false,
          error: commit.error,
          message: commit.message + suffix,
        };
      }

      const back = await runGitOrFail(dir, "checkout", "-");
      if (!back.ok) {
        const rb = await rollbackNewBranch(dir, plan.baseBranch, plan.branch);
        const suffix = rb.fullyRolledBack
          ? ""
          : ` (rollback incomplete; run \`cli.ts clean\` to tidy up)`;
        return {
          ok: false,
          error: "git-failed",
          message: back.message + suffix,
        };
      }

      const wtAdd = await addWorktree(
        dir,
        plan.worktreePath,
        plan.branch,
      );
      if (!wtAdd.ok) {
        const rb = await rollbackNewBranch(dir, plan.baseBranch, plan.branch);
        const suffix = rb.fullyRolledBack
          ? ""
          : ` (rollback incomplete; run \`cli.ts clean\` to tidy up)`;
        return {
          ok: false,
          error: wtAdd.error,
          message: wtAdd.message + suffix,
        };
      }
    } else {
      const wtAdd = await addWorktree(
        dir,
        plan.worktreePath,
        "-b",
        plan.branch,
      );
      if (!wtAdd.ok) {
        return { ok: false, error: wtAdd.error, message: wtAdd.message };
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

  return {
    ok: false,
    error: "git-failed",
    message: `internal: unknown plan case ${plan.case}`,
  };
}

export function create(
  dir: string,
  opts: CreateBranchOptions,
): Promise<CreateResult> {
  if (opts.dryRun) return planCreate(dir, opts);
  return executeCreate(dir, opts);
}
