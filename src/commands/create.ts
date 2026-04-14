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

export function planCreate(
  _dir: string,
  _opts: CreateBranchOptions,
): Promise<CreateResult> {
  return Promise.reject(new Error("planCreate not implemented"));
}

export function executeCreate(
  _dir: string,
  _opts: CreateBranchOptions,
): Promise<CreateResult> {
  return Promise.reject(new Error("executeCreate not implemented"));
}

export function create(
  dir: string,
  opts: CreateBranchOptions,
): Promise<CreateResult> {
  if (opts.dryRun) return planCreate(dir, opts);
  return executeCreate(dir, opts);
}

// Referenced by later tasks to keep imports stable.
export const _internal = { detectDefaultBranch, gitConfig, runGitCommand };
