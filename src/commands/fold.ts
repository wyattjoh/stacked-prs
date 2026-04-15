import {
  findNode,
  getAllNodes,
  getStackTree,
  type MergeStrategy,
  runGitCommand,
} from "../lib/stack.ts";
import { configFoldBranch } from "../lib/config.ts";

export type FoldStrategy = "ff" | "squash";

export interface FoldOptions {
  stackName: string;
  branch: string;
  strategy: FoldStrategy;
  squashMessage?: string;
  dryRun?: boolean;
}

export interface FoldPlan {
  stackName: string;
  branch: string;
  parent: string;
  children: string[];
  strategy: FoldStrategy;
  baseBranch: string;
  mergeStrategy: MergeStrategy | undefined;
  commands: string[];
}

export type FoldError =
  | "not-in-stack"
  | "only-branch"
  | "parent-is-base"
  | "nothing-to-fold"
  | "ff-not-possible"
  | "nothing-staged"
  | "git-failed";

export interface FoldResult {
  ok: boolean;
  plan?: FoldPlan;
  error?: FoldError;
  message?: string;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function gitCmd(...args: string[]): string {
  return ["git", ...args.map(shellQuote)].join(" ");
}

function commandsForPlan(
  plan: Omit<FoldPlan, "commands">,
  squashMessage: string | undefined,
): string[] {
  const cmds: string[] = [];
  cmds.push(gitCmd("checkout", plan.parent));
  if (plan.strategy === "ff") {
    cmds.push(gitCmd("merge", "--ff-only", plan.branch));
  } else {
    cmds.push(gitCmd("merge", "--squash", plan.branch));
    cmds.push(
      gitCmd("commit", "-m", squashMessage ?? `fold ${plan.branch}`),
    );
  }
  for (const child of plan.children) {
    cmds.push(
      gitCmd("config", `branch.${child}.stack-parent`, plan.parent),
    );
  }
  cmds.push(gitCmd("config", "--unset", `branch.${plan.branch}.stack-name`));
  cmds.push(gitCmd("config", "--unset", `branch.${plan.branch}.stack-parent`));
  cmds.push(gitCmd("branch", "-d", plan.branch));
  return cmds;
}

export async function planFold(
  dir: string,
  opts: FoldOptions,
): Promise<FoldResult> {
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

  const liveNodes = getAllNodes(tree).filter((n) => !n.merged);
  if (liveNodes.length <= 1) {
    return {
      ok: false,
      error: "only-branch",
      message: `cannot fold the only live branch in stack "${opts.stackName}"`,
    };
  }

  if (node.parent === tree.baseBranch) {
    return {
      ok: false,
      error: "parent-is-base",
      message:
        `branch "${opts.branch}" has no stack parent to fold into (parent is base "${tree.baseBranch}"); use \`land\` after its PR merges`,
    };
  }

  if (opts.strategy === "ff") {
    const { code } = await runGitCommand(
      dir,
      "merge-base",
      "--is-ancestor",
      node.parent,
      opts.branch,
    );
    if (code !== 0) {
      return {
        ok: false,
        error: "ff-not-possible",
        message:
          `parent "${node.parent}" is not an ancestor of "${opts.branch}"; use --strategy=squash or restack first`,
      };
    }
  }

  const children = node.children.map((c) => c.branch);
  const partial: Omit<FoldPlan, "commands"> = {
    stackName: opts.stackName,
    branch: opts.branch,
    parent: node.parent,
    children,
    strategy: opts.strategy,
    baseBranch: tree.baseBranch,
    mergeStrategy: tree.mergeStrategy,
  };
  return {
    ok: true,
    plan: {
      ...partial,
      commands: commandsForPlan(partial, opts.squashMessage),
    },
  };
}

async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await runGitCommand(dir, "branch", "--show-current");
  return stdout;
}

export async function executeFold(
  dir: string,
  opts: FoldOptions,
): Promise<FoldResult> {
  const planResult = await planFold(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;

  const plan = planResult.plan;
  const startedOn = await currentBranch(dir);

  const checkout = await runGitCommand(dir, "checkout", plan.parent);
  if (checkout.code !== 0) {
    return {
      ok: false,
      error: "git-failed",
      message: (checkout.stderr || checkout.stdout).trim(),
    };
  }

  if (plan.strategy === "ff") {
    const merge = await runGitCommand(
      dir,
      "merge",
      "--ff-only",
      plan.branch,
    );
    if (merge.code !== 0) {
      if (startedOn) await runGitCommand(dir, "checkout", startedOn);
      return {
        ok: false,
        error: "ff-not-possible",
        message: (merge.stderr || merge.stdout).trim(),
      };
    }
  } else {
    const merge = await runGitCommand(
      dir,
      "merge",
      "--squash",
      plan.branch,
    );
    if (merge.code !== 0) {
      if (startedOn) await runGitCommand(dir, "checkout", startedOn);
      return {
        ok: false,
        error: "git-failed",
        message: (merge.stderr || merge.stdout).trim(),
      };
    }
    const diffCheck = await runGitCommand(
      dir,
      "diff",
      "--cached",
      "--quiet",
    );
    if (diffCheck.code === 0) {
      // Nothing was staged by --squash: branch contributed no new commits.
      if (startedOn) await runGitCommand(dir, "checkout", startedOn);
      return {
        ok: false,
        error: "nothing-to-fold",
        message:
          `branch "${plan.branch}" has no new commits over "${plan.parent}"`,
      };
    }
    const commit = await runGitCommand(
      dir,
      "commit",
      "-m",
      opts.squashMessage ?? `fold ${plan.branch}`,
    );
    if (commit.code !== 0) {
      return {
        ok: false,
        error: "git-failed",
        message: (commit.stderr || commit.stdout).trim(),
      };
    }
  }

  await configFoldBranch(dir, plan.stackName, plan.branch);

  const del = await runGitCommand(dir, "branch", "-d", plan.branch);
  if (del.code !== 0) {
    // Fall back to -D since we just folded its commits into the parent; the
    // "not fully merged" warning is a stale reachability check from git's POV.
    const force = await runGitCommand(dir, "branch", "-D", plan.branch);
    if (force.code !== 0) {
      return {
        ok: false,
        error: "git-failed",
        message: (force.stderr || force.stdout).trim(),
      };
    }
  }

  return { ok: true, plan };
}

export function fold(
  dir: string,
  opts: FoldOptions,
): Promise<FoldResult> {
  if (opts.dryRun) return planFold(dir, opts);
  return executeFold(dir, opts);
}
