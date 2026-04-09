import { getAllNodes, getStackTree } from "../lib/stack.ts";
import type { StackNode, StackTree } from "../lib/stack.ts";
import { gh } from "../lib/gh.ts";

export interface NavAction {
  action: "create" | "update";
  prNumber: number;
  commentId?: number;
  body: string;
}

/**
 * Generate navigation markdown for a specific PR in the stack.
 *
 * Renders the stack as a nested markdown list of bare `#N` PR references
 * (not a fenced code block) so that GitHub auto-links each entry and shows
 * the PR title on hover. Branches without a PR are omitted entirely; if a
 * hidden node has PR-bearing descendants, those descendants are promoted to
 * the hidden node's depth so the visible tree stays connected. Branch names
 * are intentionally not rendered: on github.com the `#N` link IS the
 * identity, and the tree shape conveys parent/child relationships.
 */
export function generateNavMarkdown(
  tree: StackTree,
  prMap: Map<string, number>,
  currentPrNumber: number,
): string {
  const lines: string[] = [
    "<!-- stack-nav:start -->",
    `**Stack: ${tree.stackName}**`,
    "",
  ];

  const renderNode = (node: StackNode, depth: number): void => {
    const prNum = prMap.get(node.branch);

    if (prNum === undefined) {
      for (const child of node.children) {
        renderNode(child, depth);
      }
      return;
    }

    const indent = "  ".repeat(depth);
    let line: string;
    if (node.merged) {
      line = `${indent}- ~~#${prNum}~~`;
    } else if (prNum === currentPrNumber) {
      line = `${indent}- **#${prNum} 👈 this PR**`;
    } else {
      line = `${indent}- #${prNum}`;
    }
    lines.push(line);

    for (const child of node.children) {
      renderNode(child, depth + 1);
    }
  };

  // Render merged roots before live roots
  const mergedRoots = tree.roots.filter((n) => n.merged);
  const liveRoots = tree.roots.filter((n) => !n.merged);
  for (const root of [...mergedRoots, ...liveRoots]) {
    renderNode(root, 0);
  }

  lines.push(
    "",
    "*Part of a stacked PR chain. Do not merge manually.*",
    "<!-- stack-nav:end -->",
  );

  return lines.join("\n");
}

interface GhPr {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
}

interface GhComment {
  id: number;
  body: string;
}

/** Build a plan of nav comment actions without executing writes. */
export async function buildNavPlan(
  dir: string,
  stackName: string,
  owner: string,
  repo: string,
): Promise<NavAction[]> {
  const tree = await getStackTree(dir, stackName);
  const nodes = getAllNodes(tree);

  // Fetch PRs for all nodes in parallel
  const prResults = await Promise.all(
    nodes.map(async (node) => {
      const result = await gh(
        "pr",
        "list",
        "--head",
        node.branch,
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "number,url,title,state,isDraft",
      );
      const prs = JSON.parse(result) as GhPr[];
      return { node, pr: prs.length > 0 ? prs[0] : null };
    }),
  );

  // Build prMap from the results
  const prMap = new Map<string, number>();
  for (const { node, pr } of prResults) {
    if (pr !== null) {
      prMap.set(node.branch, pr.number);
    }
  }

  // Filter to nodes with PRs
  const withPrs = prResults.filter(
    (r): r is { node: typeof r.node; pr: GhPr } => r.pr !== null,
  );

  if (withPrs.length === 0) {
    return [];
  }

  // Build actions for each PR
  const actions = await Promise.all(
    withPrs.map(async ({ pr }): Promise<NavAction | null> => {
      const body = generateNavMarkdown(tree, prMap, pr.number);

      const commentsResult = await gh(
        "api",
        `repos/${owner}/${repo}/issues/${pr.number}/comments`,
      );
      const comments = JSON.parse(commentsResult) as GhComment[];

      const existing = comments.find((c) =>
        c.body.includes("<!-- stack-nav:start -->")
      );

      if (existing) {
        if (existing.body === body) {
          return null;
        }
        return {
          action: "update",
          prNumber: pr.number,
          commentId: existing.id,
          body,
        };
      }

      return {
        action: "create",
        prNumber: pr.number,
        body,
      };
    }),
  );

  return actions.filter((a): a is NavAction => a !== null);
}

/** Execute a single nav action (create or update a PR comment). */
export async function executeNavAction(
  owner: string,
  repo: string,
  action: NavAction,
): Promise<void> {
  if (action.action === "create") {
    await gh("pr", "comment", String(action.prNumber), "--body", action.body);
    return;
  }

  await gh(
    "api",
    "--method",
    "PATCH",
    `repos/${owner}/${repo}/issues/comments/${action.commentId}`,
    "--field",
    `body=${action.body}`,
  );
}
