import { getAllNodes, getStackTree, runGitCommand } from "../lib/stack.ts";

export interface DuplicatePatch {
  branch: string;
  commit: string;
  patchId: string;
  originalBranch: string;
  originalCommit: string;
}

export interface VerifyResult {
  valid: boolean;
  branches: Array<{
    branch: string;
    parent: string;
    status: "ok" | "stale";
  }>;
  repairs: Array<{
    branch: string;
    command: string;
  }>;
  duplicates: DuplicatePatch[];
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

const decoder = new TextDecoder();

async function getPatchIds(
  dir: string,
  parent: string,
  branch: string,
): Promise<Array<{ patchId: string; commitHash: string }>> {
  // Generate patches for all commits in the range
  const formatPatch = new Deno.Command("git", {
    args: ["format-patch", "--stdout", `${parent}..${branch}`],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const fpOutput = await formatPatch.output();
  if (fpOutput.code !== 0 || fpOutput.stdout.length === 0) return [];

  // Pipe patches to git patch-id for stable content-based identification
  const patchIdProc = new Deno.Command("git", {
    args: ["patch-id", "--stable"],
    cwd: dir,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = patchIdProc.stdin.getWriter();
  await writer.write(fpOutput.stdout);
  await writer.close();

  const piOutput = await patchIdProc.output();
  if (!piOutput.success) return [];

  const output = decoder.decode(piOutput.stdout).trim();
  if (!output) return [];

  return output.split("\n").map((line) => {
    const [patchId, commitHash] = line.split(" ");
    return { patchId, commitHash };
  });
}

async function getMergeBase(
  dir: string,
  ref1: string,
  ref2: string,
): Promise<string> {
  const { code, stdout, stderr } = await runGitCommand(
    dir,
    "merge-base",
    ref1,
    ref2,
  );
  if (code !== 0) {
    throw new Error(`git merge-base ${ref1} ${ref2} failed: ${stderr}`);
  }
  return stdout;
}

export async function verifyRefs(
  dir: string,
  stackName: string,
): Promise<VerifyResult> {
  const tree = await getStackTree(dir, stackName);
  // Tombstoned (merged) nodes have no live ref: git merge-base and rev-list
  // against them would fail. Skip them entirely — the stack's live topology
  // is the only thing worth verifying.
  const stack = getAllNodes(tree).filter((n) => !n.merged);

  // Check each branch sequentially so transitive staleness propagates:
  // if a branch is stale, all downstream branches are also considered stale.
  const staleBranches = new Set<string>();
  const branchResults: VerifyResult["branches"] = [];

  for (const b of stack) {
    const parentIsStale = staleBranches.has(b.parent);
    const ok = parentIsStale
      ? false
      : await isAncestor(dir, b.parent, b.branch);
    const status = ok ? ("ok" as const) : ("stale" as const);
    if (status === "stale") staleBranches.add(b.branch);
    branchResults.push({ branch: b.branch, parent: b.parent, status });
  }

  const repairs = await Promise.all(
    branchResults
      .filter((b) => b.status === "stale")
      .map(async (b) => {
        const mergeBase = await getMergeBase(dir, b.parent, b.branch);
        return {
          branch: b.branch,
          command: `git rebase --onto ${b.parent} ${mergeBase} ${b.branch}`,
        };
      }),
  );

  // Detect duplicate patches across branch ranges.
  // After a failed --update-refs, commits can be replayed into the wrong
  // branch's segment while ancestry remains technically correct.
  const seenPatches = new Map<
    string,
    { branch: string; commit: string }
  >();
  const duplicates: DuplicatePatch[] = [];

  for (const b of stack) {
    const patches = await getPatchIds(dir, b.parent, b.branch);
    for (const { patchId, commitHash } of patches) {
      const existing = seenPatches.get(patchId);
      if (existing) {
        duplicates.push({
          branch: b.branch,
          commit: commitHash,
          patchId,
          originalBranch: existing.branch,
          originalCommit: existing.commit,
        });
      } else {
        seenPatches.set(patchId, { branch: b.branch, commit: commitHash });
      }
    }
  }

  return {
    valid: repairs.length === 0 && duplicates.length === 0,
    branches: branchResults,
    repairs,
    duplicates,
  };
}
