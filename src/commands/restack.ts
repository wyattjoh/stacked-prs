import {
  findNode,
  getAllNodes,
  getStackTree,
  runGitCommand,
  type StackNode,
  type StackTree,
} from "../lib/stack.ts";

export interface Segment {
  tip: string;
  base: string;
  branches: string[];
}

export interface RebaseSegment extends Segment {
  command: string;
  exitCode: number;
  stderr?: string;
  conflictFiles?: string[];
}

export interface RestackResult {
  ok: boolean;
  error?: "conflict" | "other";
  segments: RebaseSegment[];
  skipped: Array<{
    tip: string;
    base: string;
    branches: string[];
    reason: string;
  }>;
  recovery?: {
    resolve: string;
    abort: string;
    resume: string;
  };
}

/**
 * Decompose a StackTree into rebase segments.
 *
 * Walk the tree recursively:
 * - Leaf node (0 children): close the current segment
 * - Single-child node: continue the current segment
 * - Fork node (2+ children): close segment at this node, start new segments for each child
 */
export function decomposeSegments(tree: StackTree): Segment[] {
  const segments: Segment[] = [];

  const walk = (
    node: StackNode,
    segmentBase: string,
    segmentBranches: string[],
  ): void => {
    const currentBranches = [...segmentBranches, node.branch];

    if (node.children.length === 0) {
      // Leaf: close segment
      segments.push({
        tip: node.branch,
        base: segmentBase,
        branches: currentBranches,
      });
      return;
    }

    if (node.children.length === 1) {
      // Single child: continue segment
      walk(node.children[0], segmentBase, currentBranches);
      return;
    }

    // Fork: close segment at this node, start new segments for each child
    segments.push({
      tip: node.branch,
      base: segmentBase,
      branches: currentBranches,
    });

    for (const child of node.children) {
      walk(child, node.branch, []);
    }
  };

  for (const root of tree.roots) {
    walk(root, tree.baseBranch, []);
  }

  return segments;
}

async function isAncestor(
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const { code } = await runGitCommand(
    dir,
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  );
  return code === 0;
}

async function getConflictFiles(dir: string): Promise<string[]> {
  const { stdout } = await runGitCommand(
    dir,
    "diff",
    "--name-only",
    "--diff-filter=U",
  );
  return stdout ? stdout.split("\n").filter(Boolean) : [];
}

function filterSegments(
  segments: Segment[],
  tree: StackTree,
  opts: { upstackFrom?: string; downstackFrom?: string; only?: string },
): Segment[] {
  if (!opts.upstackFrom && !opts.downstackFrom && !opts.only) {
    return segments;
  }

  if (opts.only) {
    return segments.filter((s) => s.tip === opts.only);
  }

  if (opts.upstackFrom) {
    // Include the named segment and all segments whose base comes from it
    const targetNode = findNode(tree, opts.upstackFrom);
    if (!targetNode) return segments;

    // Collect all branch names reachable from the target node (inclusive)
    const included = new Set<string>();
    const collectSubtree = (node: StackNode): void => {
      included.add(node.branch);
      for (const child of node.children) collectSubtree(child);
    };
    collectSubtree(targetNode);

    return segments.filter((s) => included.has(s.tip));
  }

  if (opts.downstackFrom) {
    // Include only segments on the path from root to this branch
    const path = getAllNodes(tree)
      .filter((n) => {
        // A node is "downstack from" the target if the target is in its subtree,
        // or the node itself is the target or an ancestor of it.
        const targetNode = findNode(tree, opts.downstackFrom!);
        if (!targetNode) return false;

        // Walk up from target to find ancestors
        const ancestors = new Set<string>();
        const findAncestors = (node: StackNode, parentBranch: string): void => {
          if (node.branch === opts.downstackFrom!) {
            ancestors.add(parentBranch);
          }
          for (const child of node.children) {
            findAncestors(child, node.branch);
          }
        };
        for (const root of tree.roots) {
          findAncestors(root, tree.baseBranch);
        }

        return ancestors.has(n.branch) || n.branch === opts.downstackFrom;
      })
      .map((n) => n.branch);

    const pathSet = new Set(path);
    return segments.filter((s) => pathSet.has(s.tip));
  }

  return segments;
}

export async function restack(
  dir: string,
  stackName: string,
  opts?: { upstackFrom?: string; downstackFrom?: string; only?: string },
): Promise<RestackResult> {
  const tree = await getStackTree(dir, stackName);
  const allSegments = decomposeSegments(tree);
  const segments = filterSegments(allSegments, tree, opts ?? {});

  const resultSegments: RebaseSegment[] = [];
  const skipped: RestackResult["skipped"] = [];
  // Track which bases have failed so we can skip dependent segments
  const failedBases = new Set<string>();
  // First failure recorded (conflict or other), returned after full iteration
  let firstFailure: {
    error: "conflict" | "other";
    recovery?: RestackResult["recovery"];
  } | undefined;

  for (const segment of segments) {
    // If the segment's base had a conflict, skip this segment
    if (failedBases.has(segment.base) || firstFailure !== undefined) {
      skipped.push({
        tip: segment.tip,
        base: segment.base,
        branches: segment.branches,
        reason: `Skipped because base "${segment.base}" had a conflict`,
      });
      // Mark this segment's tip as failed too so descendants are also skipped
      failedBases.add(segment.tip);
      continue;
    }

    // Check if already synced
    const alreadySynced = await isAncestor(dir, segment.base, segment.tip);
    if (alreadySynced) {
      resultSegments.push({
        ...segment,
        command: `git merge-base --is-ancestor ${segment.base} ${segment.tip}`,
        exitCode: 0,
      });
      continue;
    }

    // Checkout the tip branch
    const checkoutResult = await runGitCommand(dir, "checkout", segment.tip);
    if (checkoutResult.code !== 0) {
      resultSegments.push({
        ...segment,
        command: `git checkout ${segment.tip}`,
        exitCode: checkoutResult.code,
        stderr: checkoutResult.stderr,
      });
      failedBases.add(segment.tip);
      firstFailure = { error: "other" };
      continue;
    }

    // Run rebase
    const rebaseArgs = segment.branches.length > 1
      ? ["rebase", "--update-refs", segment.base]
      : ["rebase", segment.base];
    const command = `git ${rebaseArgs.join(" ")}`;
    const rebaseResult = await runGitCommand(dir, ...rebaseArgs);

    if (rebaseResult.code === 0) {
      resultSegments.push({
        ...segment,
        command,
        exitCode: 0,
      });
    } else {
      // Conflict or other error
      const conflictFiles = await getConflictFiles(dir);
      const isConflict = rebaseResult.stderr.includes("CONFLICT") ||
        rebaseResult.stdout.includes("CONFLICT") ||
        conflictFiles.length > 0;

      resultSegments.push({
        ...segment,
        command,
        exitCode: rebaseResult.code,
        stderr: rebaseResult.stderr || rebaseResult.stdout,
        conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
      });

      // Mark this tip as failed so dependent segments are skipped
      failedBases.add(segment.tip);
      firstFailure = {
        error: isConflict ? "conflict" : "other",
        recovery: {
          resolve: "git add <conflicting files> && git rebase --continue",
          abort: "git rebase --abort",
          resume:
            `deno run --allow-run=git,gh --allow-env cli.ts restack --stack-name=${stackName} --resume`,
        },
      };
    }
  }

  if (firstFailure !== undefined) {
    return {
      ok: false,
      error: firstFailure.error,
      segments: resultSegments,
      skipped,
      recovery: firstFailure.recovery,
    };
  }

  return {
    ok: true,
    segments: resultSegments,
    skipped,
  };
}
