import {
  detectDefaultBranch,
  getDefaultMergeStrategy,
  gitConfig,
  type MergeStrategy,
  runGitCommand,
  setBranchBaseBranch,
  setBranchMergeStrategy,
} from "../lib/stack.ts";

export interface InitOptions {
  /** Branch to register as the root of the new stack. Defaults to current branch. */
  branch?: string;
  mergeStrategy?: MergeStrategy;
  /** Base branch to record. Defaults to the detected default branch. */
  baseBranch?: string;
  dryRun?: boolean;
}

export interface InitPlan {
  branch: string;
  /** @deprecated kept for printer compatibility; equals `branch`. Renamed in a future task. */
  stackName: string;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
  commands: string[];
}

export type InitError =
  | "detached"
  | "on-base-branch"
  | "already-in-stack"
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

  // Guard: branch is already tracked if it already has a stack-parent.
  const existingParent = await gitConfig(dir, `branch.${branch}.stack-parent`);
  if (existingParent) {
    return {
      ok: false,
      error: "already-in-stack",
      message:
        `branch "${branch}" is already tracked (stack-parent: "${existingParent}"); use \`status\` to inspect`,
    };
  }

  const mergeStrategy: MergeStrategy = opts.mergeStrategy ??
    await getDefaultMergeStrategy(dir);

  const commands: string[] = [
    gitCmd("config", `branch.${branch}.stack-parent`, baseBranch),
    gitCmd("config", `branch.${branch}.base-branch`, baseBranch),
    gitCmd("config", `branch.${branch}.merge-strategy`, mergeStrategy),
  ];

  return {
    ok: true,
    plan: { branch, stackName: branch, baseBranch, mergeStrategy, commands },
  };
}

export async function executeInit(
  dir: string,
  opts: InitOptions,
): Promise<InitResult> {
  const planResult = await planInit(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;
  const plan = planResult.plan;

  await runGitCommand(
    dir,
    "config",
    `branch.${plan.branch}.stack-parent`,
    plan.baseBranch,
  );
  await setBranchBaseBranch(dir, plan.branch, plan.baseBranch);
  await setBranchMergeStrategy(dir, plan.branch, plan.mergeStrategy);

  return { ok: true, plan };
}

export function init(
  dir: string,
  opts: InitOptions,
): Promise<InitResult> {
  if (opts.dryRun) return planInit(dir, opts);
  return executeInit(dir, opts);
}
