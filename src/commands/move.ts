import {
  findNode,
  getAllNodes,
  getPathTo,
  getStackTree,
  revParse,
  runGitCommand,
} from "../lib/stack.ts";
import { configMoveBranch } from "../lib/config.ts";

export interface MoveOptions {
  stackName: string;
  branch: string;
  newParent: string;
  dryRun?: boolean;
}

export interface MovePlan {
  stackName: string;
  branch: string;
  oldParent: string;
  newParent: string;
  reparentedChildren: string[];
  baseBranch: string;
  commands: string[];
}

export type MoveError =
  | "not-in-stack"
  | "noop"
  | "parent-not-in-stack"
  | "would-create-cycle"
  | "git-failed"
  | "conflict";

export interface MoveResult {
  ok: boolean;
  plan?: MovePlan;
  error?: MoveError;
  message?: string;
  recovery?: {
    resolve: string;
    resume: string;
    abort: string;
  };
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function gitCmd(...args: string[]): string {
  return ["git", ...args.map(shellQuote)].join(" ");
}

function commandsForPlan(plan: Omit<MovePlan, "commands">): string[] {
  const cmds: string[] = [];
  for (const child of plan.reparentedChildren) {
    cmds.push(
      gitCmd("config", `branch.${child}.stack-parent`, plan.oldParent),
    );
  }
  cmds.push(
    gitCmd("config", `branch.${plan.branch}.stack-parent`, plan.newParent),
  );
  cmds.push(
    gitCmd(
      "rebase",
      "--onto",
      plan.newParent,
      plan.oldParent,
      plan.branch,
    ),
  );
  return cmds;
}

export async function planMove(
  dir: string,
  opts: MoveOptions,
): Promise<MoveResult> {
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

  if (node.parent === opts.newParent) {
    return {
      ok: false,
      error: "noop",
      message:
        `branch "${opts.branch}" is already a child of "${opts.newParent}"`,
    };
  }

  const inStack = getAllNodes(tree).some((n) => n.branch === opts.newParent);
  const isBase = opts.newParent === tree.baseBranch;
  if (!inStack && !isBase) {
    return {
      ok: false,
      error: "parent-not-in-stack",
      message:
        `new parent "${opts.newParent}" is not a member of stack "${opts.stackName}" (and not the base branch)`,
    };
  }

  // Cycle check: new parent must not be a descendant of the moved branch.
  const path = getPathTo(tree, opts.newParent);
  if (path && path.some((n) => n.branch === opts.branch)) {
    return {
      ok: false,
      error: "would-create-cycle",
      message:
        `cannot move "${opts.branch}" under "${opts.newParent}": it would create a cycle`,
    };
  }

  const reparentedChildren = node.children.map((c) => c.branch);
  const partial: Omit<MovePlan, "commands"> = {
    stackName: opts.stackName,
    branch: opts.branch,
    oldParent: node.parent,
    newParent: opts.newParent,
    reparentedChildren,
    baseBranch: tree.baseBranch,
  };
  return {
    ok: true,
    plan: { ...partial, commands: commandsForPlan(partial) },
  };
}

export async function executeMove(
  dir: string,
  opts: MoveOptions,
): Promise<MoveResult> {
  const planResult = await planMove(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;

  const plan = planResult.plan;

  // Snapshot old-parent SHA before config mutation so rebase --onto always
  // uses the pre-move upstream, even if the caller's old parent has since
  // advanced.
  const oldParentSha = await revParse(dir, plan.oldParent);

  await configMoveBranch(dir, {
    stack: plan.stackName,
    branch: plan.branch,
    newParent: plan.newParent,
  });

  const rebase = await runGitCommand(
    dir,
    "rebase",
    "--onto",
    plan.newParent,
    oldParentSha,
    plan.branch,
  );
  if (rebase.code !== 0) {
    return {
      ok: false,
      plan,
      error: "conflict",
      message: (rebase.stderr || rebase.stdout).trim(),
      recovery: {
        resolve: "resolve conflicts, then run: git add <files>",
        resume: "git rebase --continue",
        abort: "git rebase --abort",
      },
    };
  }

  return { ok: true, plan };
}

export function move(
  dir: string,
  opts: MoveOptions,
): Promise<MoveResult> {
  if (opts.dryRun) return planMove(dir, opts);
  return executeMove(dir, opts);
}
