import {
  effectiveParent,
  getAllNodes,
  getMergeStrategy,
  getStackTree,
  runGitCommand,
  tryResolveRef,
} from "./stack.ts";
import type { MergeStrategy } from "./stack.ts";
import { type GhPrListInfo, listPrsForBranch } from "./gh.ts";
import { buildNavPlan } from "./nav.ts";
import type { NavAction } from "./nav.ts";

export interface BranchSubmitPlan {
  branch: string;
  parent: string;
  isCurrent: boolean;
  pr: GhPrListInfo | null;
  action: "create" | "update-base" | "none";
  /**
   * True when the local branch tip differs from `refs/remotes/origin/<branch>`
   * (or when the remote ref does not exist yet). A fresh fetch is the caller's
   * responsibility; the planner reads whatever the local remote-tracking ref
   * points to, and `--force-with-lease` at execute time catches any drift.
   */
  needsPush: boolean;
  /**
   * True when the PR for this branch should be a draft. PRs whose parent is
   * the stack's base branch (e.g. "main") are ready for review; all other PRs
   * in the stack are kept as drafts so they cannot be merged out of order.
   */
  desiredDraft: boolean;
  /**
   * Draft state transition needed for an existing PR. "none" when the PR
   * already matches `desiredDraft`, or when no PR exists yet (the create
   * step uses `desiredDraft` directly).
   */
  draftAction: "to-draft" | "to-ready" | "none";
}

export interface NavCommentPlan {
  prNumber: number;
  action: "create" | "update";
  body: string;
  commentId?: number;
}

export interface SubmitPlan {
  stackName: string;
  mergeStrategy: MergeStrategy | undefined;
  branches: BranchSubmitPlan[];
  navComments: NavCommentPlan[];
  isNoOp: boolean;
}

async function computeNeedsPush(dir: string, branch: string): Promise<boolean> {
  const [local, remote] = await Promise.all([
    tryResolveRef(dir, branch),
    tryResolveRef(dir, `refs/remotes/origin/${branch}`),
  ]);
  if (local === null) return false;
  if (remote === null) return true;
  return local !== remote;
}

function toNavCommentPlan(action: NavAction): NavCommentPlan {
  return {
    prNumber: action.prNumber,
    action: action.action,
    body: action.body,
    ...(action.commentId !== undefined ? { commentId: action.commentId } : {}),
  };
}

export async function computeSubmitPlan(
  dir: string,
  stackName: string,
  owner: string,
  repo: string,
): Promise<SubmitPlan> {
  const [tree, mergeStrategy, currentBranchResult] = await Promise.all([
    getStackTree(dir, stackName),
    getMergeStrategy(dir, stackName),
    runGitCommand(dir, "branch", "--show-current"),
  ]);

  const currentBranch = currentBranchResult.stdout;
  // Tombstoned (merged) nodes have no live ref, so `gh pr list --head` returns
  // nothing (merged PRs are excluded by gh's default state filter) and the
  // planner would otherwise fall through to `action: "create"` for a branch
  // that has already landed. Filter them out so submit never tries to push,
  // recreate, or modify PRs for already-landed branches.
  const nodes = getAllNodes(tree).filter((n) => !n.merged);

  // Fetch PR info and compute push state for all nodes in parallel.
  // `listPrsForBranch` short-circuits to the active repo-wide PR index
  // when a CLI handler has wrapped the call in `withPrIndex`, so this
  // whole loop collapses to a single `gh pr list` round-trip per
  // invocation instead of one per branch.
  const branchPlans = await Promise.all(
    nodes.map(async (b): Promise<BranchSubmitPlan> => {
      const [pr, needsPush] = await Promise.all([
        listPrsForBranch(b.branch, { owner, repo }),
        computeNeedsPush(dir, b.branch),
      ]);

      // If the recorded stack-parent is a tombstone, the PR's base on
      // GitHub should target the first live ancestor (or the base
      // branch). Walking through tombstones here keeps submitted PRs
      // retargeted correctly after a land without requiring a sync run.
      const effParent = effectiveParent(tree, b, undefined);

      let action: BranchSubmitPlan["action"];
      if (!pr) {
        action = "create";
      } else if (pr.baseRefName !== effParent) {
        action = "update-base";
      } else {
        action = "none";
      }

      const desiredDraft = effParent !== tree.baseBranch;

      let draftAction: BranchSubmitPlan["draftAction"];
      if (!pr) {
        draftAction = "none";
      } else if (pr.isDraft !== desiredDraft) {
        draftAction = desiredDraft ? "to-draft" : "to-ready";
      } else {
        draftAction = "none";
      }

      return {
        branch: b.branch,
        parent: effParent,
        isCurrent: b.branch === currentBranch,
        pr,
        action,
        needsPush,
        desiredDraft,
        draftAction,
      };
    }),
  );

  // Get nav comment actions
  const navActions = await buildNavPlan(dir, stackName, owner, repo);
  const navComments = navActions.map(toNavCommentPlan);

  const isNoOp =
    branchPlans.every((b) =>
      b.action === "none" && b.draftAction === "none" && !b.needsPush
    ) && navComments.length === 0;

  return {
    stackName,
    mergeStrategy,
    branches: branchPlans,
    navComments,
    isNoOp,
  };
}
