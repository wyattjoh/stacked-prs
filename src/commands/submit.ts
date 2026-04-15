import { runGitCommand } from "../lib/stack.ts";
import { gh } from "../lib/gh.ts";
import { executeNavAction } from "./nav.ts";
import type { SubmitPlan } from "../lib/submit-plan.ts";

export interface SubmitExecutionResult {
  ok: boolean;
  pushedBranches: string[];
  prsCreated: Array<{ branch: string; number: number; url: string }>;
  prsBaseUpdated: Array<{ branch: string; number: number; newBase: string }>;
  draftTransitions: Array<{
    branch: string;
    number: number;
    to: "draft" | "ready";
  }>;
  navCommentsApplied: number;
  error?: string;
}

function emptyResult(): SubmitExecutionResult {
  return {
    ok: true,
    pushedBranches: [],
    prsCreated: [],
    prsBaseUpdated: [],
    draftTransitions: [],
    navCommentsApplied: 0,
  };
}

function parsePrNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Execute a `SubmitPlan`: force-push every stack branch, then create or edit
 * PRs and flip draft state to match the plan's `desiredDraft`, then apply the
 * nav comment actions. Push happens in a single `git push --force-with-lease`
 * so the refs land atomically from git's perspective and any per-branch gh
 * operations see up-to-date remote tips.
 */
export async function executeSubmit(
  dir: string,
  plan: SubmitPlan,
  owner: string,
  repo: string,
): Promise<SubmitExecutionResult> {
  const result = emptyResult();

  const branchesToPush = plan.branches
    .filter((b) => b.needsPush)
    .map((b) => b.branch);
  if (branchesToPush.length > 0) {
    const pushResult = await runGitCommand(
      dir,
      "push",
      "--force-with-lease",
      "origin",
      ...branchesToPush,
    );
    if (pushResult.code !== 0) {
      return {
        ...result,
        ok: false,
        error: `git push failed: ${pushResult.stderr || pushResult.stdout}`,
      };
    }
    result.pushedBranches = branchesToPush;
  }

  for (const b of plan.branches) {
    if (b.action === "create") {
      const createArgs = [
        "pr",
        "create",
        "--repo",
        `${owner}/${repo}`,
        "--base",
        b.parent,
        "--head",
        b.branch,
        "--fill",
      ];
      if (b.desiredDraft) createArgs.push("--draft");
      const output = (await gh(...createArgs)).trim();
      const number = parsePrNumberFromUrl(output);
      if (number !== undefined) {
        result.prsCreated.push({ branch: b.branch, number, url: output });
      }
      // Newly created PRs already match desiredDraft via --draft (or not), so
      // there is no draft transition to apply.
      continue;
    }

    if (b.action === "update-base" && b.pr) {
      await gh(
        "pr",
        "edit",
        String(b.pr.number),
        "--repo",
        `${owner}/${repo}`,
        "--base",
        b.parent,
      );
      result.prsBaseUpdated.push({
        branch: b.branch,
        number: b.pr.number,
        newBase: b.parent,
      });
    }

    if (b.draftAction === "to-draft" && b.pr) {
      await gh(
        "pr",
        "ready",
        String(b.pr.number),
        "--repo",
        `${owner}/${repo}`,
        "--undo",
      );
      result.draftTransitions.push({
        branch: b.branch,
        number: b.pr.number,
        to: "draft",
      });
    } else if (b.draftAction === "to-ready" && b.pr) {
      await gh(
        "pr",
        "ready",
        String(b.pr.number),
        "--repo",
        `${owner}/${repo}`,
      );
      result.draftTransitions.push({
        branch: b.branch,
        number: b.pr.number,
        to: "ready",
      });
    }
  }

  for (const nav of plan.navComments) {
    await executeNavAction(owner, repo, {
      action: nav.action,
      prNumber: nav.prNumber,
      body: nav.body,
      ...(nav.commentId !== undefined ? { commentId: nav.commentId } : {}),
    });
    result.navCommentsApplied++;
  }

  return result;
}

/**
 * Render a submit plan as a human-readable summary (used by the interactive
 * confirmation path and by `submit --dry-run`).
 */
export function renderSubmitPlan(plan: SubmitPlan): string {
  const lines: string[] = [];
  lines.push(`Stack: ${plan.stackName}`);
  if (plan.isNoOp) {
    lines.push(
      "  All PRs are up to date. Nothing to push, create, or update.",
    );
    return lines.join("\n");
  }

  const toPush = plan.branches.filter((b) => b.needsPush);
  if (toPush.length > 0) {
    lines.push("");
    lines.push("  Push (--force-with-lease):");
    for (const b of toPush) {
      lines.push(`    ${b.branch}`);
    }
  }

  const creates = plan.branches.filter((b) => b.action === "create");
  if (creates.length > 0) {
    lines.push("");
    lines.push("  Create PRs:");
    for (const b of creates) {
      const draftTag = b.desiredDraft ? " [draft]" : "";
      lines.push(`    ${b.branch}  base=${b.parent}${draftTag}`);
    }
  }

  const rebases = plan.branches.filter((b) =>
    b.action === "update-base" && b.pr
  );
  if (rebases.length > 0) {
    lines.push("");
    lines.push("  Update PR base:");
    for (const b of rebases) {
      lines.push(
        `    #${b.pr!.number}  ${b.pr!.baseRefName} -> ${b.parent}`,
      );
    }
  }

  const toDraft = plan.branches.filter((b) =>
    b.draftAction === "to-draft" && b.pr
  );
  const toReady = plan.branches.filter((b) =>
    b.draftAction === "to-ready" && b.pr
  );
  if (toDraft.length > 0 || toReady.length > 0) {
    lines.push("");
    lines.push("  Flip draft state:");
    for (const b of toDraft) {
      lines.push(`    #${b.pr!.number} ${b.branch}  ready -> draft`);
    }
    for (const b of toReady) {
      lines.push(`    #${b.pr!.number} ${b.branch}  draft -> ready`);
    }
  }

  if (plan.navComments.length > 0) {
    lines.push("");
    lines.push("  Nav comments:");
    for (const c of plan.navComments) {
      lines.push(`    #${c.prNumber} ${c.action}`);
    }
  }

  return lines.join("\n");
}
