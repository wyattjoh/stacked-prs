import {
  effectiveParent,
  getAllNodes,
  getMergeStrategy,
  getStackTree,
  runGitCommand,
  tryResolveRef,
} from "./stack.ts";
import type { MergeStrategy } from "./stack.ts";
import { getPrBody, type GhPrListInfo, listPrsForBranch } from "./gh.ts";
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
  /**
   * Raw markdown from git's native `branch.<name>.description` key. When
   * present, it is the source of truth for the PR body: creation uses it as
   * the body, and later submits overwrite the PR body on drift. Absent when
   * the branch has no description; such branches keep gh's `--fill` behavior
   * and their PR bodies are never touched.
   */
  description?: string;
  /**
   * PR title used at creation, derived from the subject of the oldest commit
   * unique to the branch. Only set for `action: "create"` with a description
   * present (the `--fill` path derives its own title). Titles are set once
   * and never updated on later submits.
   */
  title?: string;
  /**
   * Body operation for this branch's PR. "set" when a new PR will be created
   * with the description as its body; "update" when an existing open PR's
   * body differs from the description (whitespace-normalized) and will be
   * overwritten; "none" otherwise.
   */
  bodyAction: "set" | "update" | "none";
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
  /**
   * Optional scope filter. When `only` is set, `branches` is restricted to the
   * single named branch; nav comments still cover the full stack so siblings
   * stay correct.
   */
  scope?: { only?: string };
}

export interface ComputeSubmitPlanOptions {
  /**
   * Restrict per-branch ops (push, create, edit, draft flips) to a single
   * branch. The branch must be a live (non-tombstoned) member of the stack;
   * unknown or merged branches throw.
   */
  only?: string;
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

/**
 * Normalize a PR body / branch description for drift comparison. GitHub
 * stores bodies with CRLF line endings and often a trailing newline; neither
 * difference should count as drift.
 */
function normalizeBody(body: string): string {
  return body.replaceAll("\r\n", "\n").trim();
}

/**
 * Subject of the oldest commit unique to `branch` relative to `parent`. Used
 * as the PR title when a branch description supplies the body (matching the
 * commit-derived spirit of gh's `--fill`). Falls back to the branch name when
 * the range is empty or unreadable.
 */
async function oldestCommitSubject(
  dir: string,
  parent: string,
  branch: string,
): Promise<string> {
  const result = await runGitCommand(
    dir,
    "log",
    "--reverse",
    "--format=%s",
    `${parent}..${branch}`,
  );
  if (result.code !== 0) return branch;
  const first = result.stdout.split("\n")[0]?.trim();
  return first || branch;
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
  options: ComputeSubmitPlanOptions = {},
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
  const liveNodes = getAllNodes(tree).filter((n) => !n.merged);

  if (options.only !== undefined) {
    const match = liveNodes.find((n) => n.branch === options.only);
    if (!match) {
      const known = liveNodes.map((n) => n.branch).join(", ") || "(none)";
      throw new Error(
        `Branch '${options.only}' is not a live member of stack '${stackName}'. ` +
          `Known live branches: ${known}.`,
      );
    }
  }

  const nodes = options.only !== undefined
    ? liveNodes.filter((n) => n.branch === options.only)
    : liveNodes;

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

      // Branch descriptions are the source of truth for PR bodies. A new PR
      // gets the description as its body ("set"); an existing open PR whose
      // body has drifted from the description gets overwritten ("update").
      // Branches without a description keep gh's `--fill` behavior and are
      // never body-edited. Closed/merged PRs are left alone.
      let bodyAction: BranchSubmitPlan["bodyAction"] = "none";
      let title: string | undefined;
      if (b.description !== undefined) {
        if (action === "create") {
          bodyAction = "set";
          title = await oldestCommitSubject(dir, effParent, b.branch);
        } else if (pr && pr.state === "OPEN") {
          const liveBody = await getPrBody(pr.number, { owner, repo });
          if (
            liveBody !== null &&
            normalizeBody(liveBody) !== normalizeBody(b.description)
          ) {
            bodyAction = "update";
          }
        }
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
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(title !== undefined ? { title } : {}),
        bodyAction,
      };
    }),
  );

  // Get nav comment actions
  const navActions = await buildNavPlan(dir, stackName, owner, repo);
  const navComments = navActions.map(toNavCommentPlan);

  const isNoOp =
    branchPlans.every((b) =>
      b.action === "none" && b.draftAction === "none" &&
      b.bodyAction === "none" && !b.needsPush
    ) && navComments.length === 0;

  return {
    stackName,
    mergeStrategy,
    branches: branchPlans,
    navComments,
    isNoOp,
    ...(options.only !== undefined ? { scope: { only: options.only } } : {}),
  };
}
