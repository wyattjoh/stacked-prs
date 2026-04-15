import {
  detectDefaultBranch,
  gitConfig,
  type MergeStrategy,
  runGitCommand,
  setBaseBranch,
  setMergeStrategy,
  setStackNode,
} from "../lib/stack.ts";

export interface InitOptions {
  /** Branch to register as the root of the new stack. Defaults to current branch. */
  branch?: string;
  stackName?: string;
  mergeStrategy?: MergeStrategy;
  /** Base branch to record. Defaults to the detected default branch. */
  baseBranch?: string;
  dryRun?: boolean;
}

export interface InitPlan {
  branch: string;
  stackName: string;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
  commands: string[];
}

export type InitError =
  | "detached"
  | "on-base-branch"
  | "already-in-stack"
  | "stack-exists"
  | "git-failed";

export interface InitResult {
  ok: boolean;
  plan?: InitPlan;
  error?: InitError;
  message?: string;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function gitCmd(...args: string[]): string {
  return ["git", ...args.map(shellQuote)].join(" ");
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function currentBranch(dir: string): Promise<string | undefined> {
  const { code, stdout } = await runGitCommand(dir, "branch", "--show-current");
  if (code !== 0 || !stdout) return undefined;
  return stdout;
}

export async function planInit(
  dir: string,
  opts: InitOptions,
): Promise<InitResult> {
  const branch = opts.branch ?? (await currentBranch(dir));
  if (!branch) {
    return {
      ok: false,
      error: "detached",
      message: "not on a branch (detached HEAD); check out a branch first",
    };
  }

  let baseBranch: string;
  if (opts.baseBranch) {
    baseBranch = opts.baseBranch;
  } else {
    try {
      baseBranch = await detectDefaultBranch(dir);
    } catch (err) {
      return {
        ok: false,
        error: "git-failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (branch === baseBranch) {
    return {
      ok: false,
      error: "on-base-branch",
      message:
        `cannot init a stack rooted at the base branch "${baseBranch}"; check out a feature branch first`,
    };
  }

  const existingStack = await gitConfig(dir, `branch.${branch}.stack-name`);
  if (existingStack) {
    return {
      ok: false,
      error: "already-in-stack",
      message:
        `branch "${branch}" is already part of stack "${existingStack}"; use \`status\` to inspect`,
    };
  }

  const stackName = opts.stackName ?? branch;
  const mergeStrategy: MergeStrategy = opts.mergeStrategy ?? "merge";

  // Guard against a pre-existing stack with the chosen name.
  const existing = await runGitCommand(
    dir,
    "config",
    "--get-regexp",
    `^stack\\.${escapeRegex(stackName)}\\.`,
  );
  if (existing.code === 0 && existing.stdout) {
    return {
      ok: false,
      error: "stack-exists",
      message:
        `stack "${stackName}" already has config entries; choose a different --stack-name`,
    };
  }

  const commands: string[] = [
    gitCmd("config", `branch.${branch}.stack-name`, stackName),
    gitCmd("config", `branch.${branch}.stack-parent`, baseBranch),
    gitCmd("config", `stack.${stackName}.base-branch`, baseBranch),
    gitCmd("config", `stack.${stackName}.merge-strategy`, mergeStrategy),
  ];

  return {
    ok: true,
    plan: { branch, stackName, baseBranch, mergeStrategy, commands },
  };
}

export async function executeInit(
  dir: string,
  opts: InitOptions,
): Promise<InitResult> {
  const planResult = await planInit(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;
  const plan = planResult.plan;

  await setStackNode(dir, plan.branch, plan.stackName, plan.baseBranch);
  await setBaseBranch(dir, plan.stackName, plan.baseBranch);
  await setMergeStrategy(dir, plan.stackName, plan.mergeStrategy);

  return { ok: true, plan };
}

export function init(
  dir: string,
  opts: InitOptions,
): Promise<InitResult> {
  if (opts.dryRun) return planInit(dir, opts);
  return executeInit(dir, opts);
}
