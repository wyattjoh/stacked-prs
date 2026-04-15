import { findNode, getStackTree, runGitCommand } from "../lib/stack.ts";
import { configInsertBranch } from "../lib/config.ts";

export interface InsertOptions {
  stackName: string;
  /** Branch that will be reparented to become a child of the new branch. */
  child: string;
  /** Name of the new branch to insert. */
  branch: string;
  dryRun?: boolean;
}

export interface InsertPlan {
  stackName: string;
  branch: string;
  parent: string;
  child: string;
  baseBranch: string;
  commands: string[];
}

export type InsertError =
  | "child-not-in-stack"
  | "invalid-branch-name"
  | "branch-exists"
  | "git-failed";

export interface InsertResult {
  ok: boolean;
  plan?: InsertPlan;
  error?: InsertError;
  message?: string;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function gitCmd(...args: string[]): string {
  return ["git", ...args.map(shellQuote)].join(" ");
}

function commandsForPlan(plan: Omit<InsertPlan, "commands">): string[] {
  return [
    gitCmd("checkout", "-b", plan.branch, plan.parent),
    gitCmd("config", `branch.${plan.branch}.stack-name`, plan.stackName),
    gitCmd("config", `branch.${plan.branch}.stack-parent`, plan.parent),
    gitCmd("config", `branch.${plan.child}.stack-parent`, plan.branch),
  ];
}

export async function planInsert(
  dir: string,
  opts: InsertOptions,
): Promise<InsertResult> {
  const nameCheck = await runGitCommand(
    dir,
    "check-ref-format",
    "--branch",
    opts.branch,
  );
  if (nameCheck.code !== 0) {
    return {
      ok: false,
      error: "invalid-branch-name",
      message: (nameCheck.stderr || `invalid branch name: ${opts.branch}`)
        .trim(),
    };
  }

  const exists = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${opts.branch}`,
  );
  if (exists.code === 0) {
    return {
      ok: false,
      error: "branch-exists",
      message: `branch "${opts.branch}" already exists`,
    };
  }

  const tree = await getStackTree(dir, opts.stackName);
  const childNode = findNode(tree, opts.child);
  if (!childNode) {
    return {
      ok: false,
      error: "child-not-in-stack",
      message:
        `branch "${opts.child}" is not part of stack "${opts.stackName}"`,
    };
  }

  const partial: Omit<InsertPlan, "commands"> = {
    stackName: opts.stackName,
    branch: opts.branch,
    parent: childNode.parent,
    child: opts.child,
    baseBranch: tree.baseBranch,
  };
  return {
    ok: true,
    plan: { ...partial, commands: commandsForPlan(partial) },
  };
}

export async function executeInsert(
  dir: string,
  opts: InsertOptions,
): Promise<InsertResult> {
  const planResult = await planInsert(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;

  const plan = planResult.plan;

  const checkout = await runGitCommand(
    dir,
    "checkout",
    "-b",
    plan.branch,
    plan.parent,
  );
  if (checkout.code !== 0) {
    return {
      ok: false,
      error: "git-failed",
      message: (checkout.stderr || checkout.stdout).trim(),
    };
  }

  await configInsertBranch(dir, {
    stack: plan.stackName,
    branch: plan.branch,
    parent: plan.parent,
    child: plan.child,
  });

  return { ok: true, plan };
}

export function insert(
  dir: string,
  opts: InsertOptions,
): Promise<InsertResult> {
  if (opts.dryRun) return planInsert(dir, opts);
  return executeInsert(dir, opts);
}
