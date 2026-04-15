import {
  gitConfig,
  type MergeStrategy,
  runGitCommand,
  setBaseBranch,
  setMergeStrategy,
  setStackNode,
} from "../lib/stack.ts";
import {
  discoverChain,
  type DiscoveredNode,
  type DiscoverResult,
} from "./import-discover.ts";

export interface ImportOptions {
  /** Starting branch. Default: current. */
  branch?: string;
  stackName?: string;
  mergeStrategy?: MergeStrategy;
  owner?: string;
  repo?: string;
  dryRun?: boolean;
}

export interface ImportPlanEntry {
  branch: string;
  parent: string;
}

export interface ImportPlan {
  stackName: string;
  mergeStrategy: MergeStrategy;
  baseBranch: string;
  entries: ImportPlanEntry[];
  warnings: string[];
  commands: string[];
}

export type ImportError =
  | "nothing-discovered"
  | "already-in-stack"
  | "stack-exists"
  | "git-failed";

export interface ImportResult {
  ok: boolean;
  plan?: ImportPlan;
  error?: ImportError;
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

function flatten(
  nodes: DiscoveredNode[],
  baseBranch: string,
): ImportPlanEntry[] {
  const out: ImportPlanEntry[] = [];
  const walk = (node: DiscoveredNode, parent: string): void => {
    out.push({ branch: node.branch, parent });
    for (const c of node.children) walk(c, node.branch);
  };
  for (const root of nodes) walk(root, baseBranch);
  return out;
}

function commandsForPlan(plan: Omit<ImportPlan, "commands">): string[] {
  const cmds: string[] = [];
  for (const e of plan.entries) {
    cmds.push(
      gitCmd("config", `branch.${e.branch}.stack-name`, plan.stackName),
    );
    cmds.push(
      gitCmd("config", `branch.${e.branch}.stack-parent`, e.parent),
    );
  }
  cmds.push(
    gitCmd("config", `stack.${plan.stackName}.base-branch`, plan.baseBranch),
  );
  cmds.push(
    gitCmd(
      "config",
      `stack.${plan.stackName}.merge-strategy`,
      plan.mergeStrategy,
    ),
  );
  return cmds;
}

export async function planImport(
  dir: string,
  opts: ImportOptions,
  discover: (
    dir: string,
    branch?: string,
    owner?: string,
    repo?: string,
  ) => Promise<DiscoverResult> = discoverChain,
): Promise<ImportResult> {
  const discovered = await discover(dir, opts.branch, opts.owner, opts.repo);
  if (discovered.roots.length === 0) {
    return {
      ok: false,
      error: "nothing-discovered",
      message:
        `no branch chain discovered relative to base "${discovered.baseBranch}"`,
    };
  }

  const entries = flatten(discovered.roots, discovered.baseBranch);

  // Reject if any discovered branch already has stack metadata.
  for (const e of entries) {
    const existing = await gitConfig(dir, `branch.${e.branch}.stack-name`);
    if (existing) {
      return {
        ok: false,
        error: "already-in-stack",
        message:
          `branch "${e.branch}" is already part of stack "${existing}"; split or clean first`,
      };
    }
  }

  const stackName = opts.stackName ?? entries[0].branch;
  const mergeStrategy: MergeStrategy = opts.mergeStrategy ?? "merge";

  const preexisting = await runGitCommand(
    dir,
    "config",
    "--get-regexp",
    `^stack\\.${escapeRegex(stackName)}\\.`,
  );
  if (preexisting.code === 0 && preexisting.stdout) {
    return {
      ok: false,
      error: "stack-exists",
      message:
        `stack "${stackName}" already has config entries; choose a different --stack-name`,
    };
  }

  const partial: Omit<ImportPlan, "commands"> = {
    stackName,
    mergeStrategy,
    baseBranch: discovered.baseBranch,
    entries,
    warnings: discovered.warnings,
  };
  return {
    ok: true,
    plan: { ...partial, commands: commandsForPlan(partial) },
  };
}

export async function executeImport(
  dir: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  const planResult = await planImport(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;
  const plan = planResult.plan;

  for (const e of plan.entries) {
    await setStackNode(dir, e.branch, plan.stackName, e.parent);
  }
  await setBaseBranch(dir, plan.stackName, plan.baseBranch);
  await setMergeStrategy(dir, plan.stackName, plan.mergeStrategy);

  return { ok: true, plan };
}

export function importStack(
  dir: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  if (opts.dryRun) return planImport(dir, opts);
  return executeImport(dir, opts);
}
