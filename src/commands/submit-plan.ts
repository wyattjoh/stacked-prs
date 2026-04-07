import {
  getAllNodes,
  getMergeStrategy,
  getStackTree,
  runGitCommand,
} from "../lib/stack.ts";
import type { MergeStrategy } from "../lib/stack.ts";
import { gh } from "../lib/gh.ts";
import { buildNavPlan } from "./nav.ts";
import type { NavAction } from "./nav.ts";

export interface BranchSubmitPlan {
  branch: string;
  parent: string;
  isCurrent: boolean;
  pr: GhPrInfo | null;
  action: "create" | "update-base" | "none";
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

interface GhPrInfo {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
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
  const nodes = getAllNodes(tree);

  // Fetch PR info for all nodes in parallel
  const branchPlans = await Promise.all(
    nodes.map(async (b): Promise<BranchSubmitPlan> => {
      const result = await gh(
        "pr",
        "list",
        "--head",
        b.branch,
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "number,url,title,state,isDraft,baseRefName",
      );
      const prs = JSON.parse(result) as GhPrInfo[];
      const pr = prs.length > 0 ? prs[0] : null;

      let action: BranchSubmitPlan["action"];
      if (!pr) {
        action = "create";
      } else if (pr.baseRefName !== b.parent) {
        action = "update-base";
      } else {
        action = "none";
      }

      const desiredDraft = b.parent !== tree.baseBranch;

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
        parent: b.parent,
        isCurrent: b.branch === currentBranch,
        pr,
        action,
        desiredDraft,
        draftAction,
      };
    }),
  );

  // Get nav comment actions
  const navActions = await buildNavPlan(dir, stackName, owner, repo);
  const navComments = navActions.map(toNavCommentPlan);

  const isNoOp = branchPlans.every((b) => b.action === "none") &&
    navComments.length === 0;

  return {
    stackName,
    mergeStrategy,
    branches: branchPlans,
    navComments,
    isNoOp,
  };
}
