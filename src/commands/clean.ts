import {
  gitConfig,
  gitConfigGetRegexp,
  rebaseInProgress,
  runGitCommand,
} from "../lib/stack.ts";

export type CleanFindingKind =
  | "missing-branch"
  | "stale-stack-parent"
  | "empty-stack"
  | "stale-resume-state";

export interface CleanFinding {
  kind: CleanFindingKind;
  /** Branch name for branch-level findings, undefined for stack-level findings. */
  branch?: string;
  /** Stack name for stack-level findings, undefined for branch-level findings. */
  stackName?: string;
  /** Human-readable description of what's stale. */
  details: string;
  /** Git config keys this finding would remove. */
  configKeys: string[];
}

export interface CleanReport {
  findings: CleanFinding[];
  /** Number of stacks scanned. */
  stacksScanned: number;
  /** Number of branch config entries scanned. */
  branchesScanned: number;
}

export interface CleanApplyResult {
  /** All git config keys actually removed. */
  removed: string[];
  /** Findings that were applied. */
  applied: CleanFinding[];
}

interface BranchEntry {
  branch: string;
  stackName: string;
}

/** Parse `branch.<name>.stack-name` entries into {branch, stackName} records. */
function parseBranchEntries(
  entries: Array<[string, string]>,
): BranchEntry[] {
  const result: BranchEntry[] = [];
  for (const [key, value] of entries) {
    const match = key.match(/^branch\.(.+)\.stack-name$/);
    if (!match) continue;
    result.push({ branch: match[1], stackName: value });
  }
  return result;
}

/** Parse `stack.<name>.base-branch` entries into {stackName, baseBranch} records. */
function parseStackEntries(
  entries: Array<[string, string]>,
): Array<{ stackName: string; baseBranch: string }> {
  const result: Array<{ stackName: string; baseBranch: string }> = [];
  for (const [key, value] of entries) {
    const match = key.match(/^stack\.(.+)\.base-branch$/);
    if (!match) continue;
    result.push({ stackName: match[1], baseBranch: value });
  }
  return result;
}

/** True iff `refs/heads/<branch>` exists in `dir`. */
async function branchRefExists(
  dir: string,
  branch: string,
): Promise<boolean> {
  const { code } = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  );
  return code === 0;
}

/** Escape a branch/stack name for use inside a git config regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collect all `branch.<name>.stack-*` config keys for a given branch. */
async function collectBranchStackKeys(
  dir: string,
  branch: string,
): Promise<string[]> {
  const pattern = `^branch\\.${escapeRegex(branch)}\\.stack-`;
  const entries = await gitConfigGetRegexp(dir, pattern);
  return entries.map(([key]) => key);
}

/** Collect all `stack.<name>.*` config keys for a given stack. */
async function collectStackKeys(
  dir: string,
  stackName: string,
): Promise<string[]> {
  const pattern = `^stack\\.${escapeRegex(stackName)}\\.`;
  const entries = await gitConfigGetRegexp(dir, pattern);
  return entries.map(([key]) => key);
}

/** Pure detection: scan repo, return structured findings without mutating. */
export async function detectStaleConfig(
  dir: string,
  opts?: { stackName?: string },
): Promise<CleanReport> {
  const rawBranchEntries = await gitConfigGetRegexp(
    dir,
    "^branch\\..*\\.stack-name$",
  );
  const branchEntries = parseBranchEntries(rawBranchEntries);

  const rawStackEntries = await gitConfigGetRegexp(
    dir,
    "^stack\\..*\\.base-branch$",
  );
  const stackEntries = parseStackEntries(rawStackEntries);

  // Map of stackName -> base branch, from config.
  const stackBaseByName = new Map<string, string>();
  for (const { stackName, baseBranch } of stackEntries) {
    stackBaseByName.set(stackName, baseBranch);
  }

  // Map of stackName -> list of member branch names.
  const branchesByStack = new Map<string, string[]>();
  for (const { branch, stackName } of branchEntries) {
    const list = branchesByStack.get(stackName) ?? [];
    list.push(branch);
    branchesByStack.set(stackName, list);
  }

  const scopeStack = opts?.stackName;
  const findings: CleanFinding[] = [];

  // Partition branch entries into in-scope (for checks 1 and 2) and full set.
  const inScopeBranches = scopeStack
    ? branchEntries.filter((e) => e.stackName === scopeStack)
    : branchEntries;

  // Check 1 and 2: walk each in-scope branch entry.
  for (const entry of inScopeBranches) {
    const { branch, stackName } = entry;
    const refExists = await branchRefExists(dir, branch);

    if (!refExists) {
      const configKeys = await collectBranchStackKeys(dir, branch);
      findings.push({
        kind: "missing-branch",
        branch,
        stackName,
        details:
          `Branch '${branch}' is configured for stack '${stackName}' but the ref does not exist.`,
        configKeys,
      });
      continue;
    }

    // Check 2: stale stack-parent.
    const parent = await gitConfig(dir, `branch.${branch}.stack-parent`);
    const baseBranch = stackBaseByName.get(stackName);
    const memberSet = new Set(branchesByStack.get(stackName) ?? []);

    if (!parent) {
      findings.push({
        kind: "stale-stack-parent",
        branch,
        stackName,
        details:
          `Branch '${branch}' claims to be in stack '${stackName}' but has no stack-parent set.`,
        configKeys: [`branch.${branch}.stack-parent`],
      });
      continue;
    }

    if (baseBranch !== undefined && parent === baseBranch) continue;
    if (memberSet.has(parent)) continue;

    const parentRefExists = await branchRefExists(dir, parent);
    if (!parentRefExists) {
      findings.push({
        kind: "stale-stack-parent",
        branch,
        stackName,
        details:
          `Branch '${branch}' parent '${parent}' is not the base branch and the ref does not exist.`,
        configKeys: [`branch.${branch}.stack-parent`],
      });
    }
    // If parent exists but is outside the stack and not the base, leave
    // alone: that's a structural issue, not staleness.
  }

  // Check 3: empty stacks.
  for (const { stackName } of stackEntries) {
    if (scopeStack && stackName !== scopeStack) continue;
    const members = branchesByStack.get(stackName) ?? [];
    if (members.length > 0) continue;
    const configKeys = await collectStackKeys(dir, stackName);
    findings.push({
      kind: "empty-stack",
      stackName,
      details: `Stack '${stackName}' has no member branches.`,
      configKeys,
    });
  }

  // Check 4: stale resume-state.
  const resumeEntries = await gitConfigGetRegexp(
    dir,
    "^stack\\..*\\.resume-state$",
  );
  if (resumeEntries.length > 0) {
    const inProgress = await rebaseInProgress(dir);
    if (!inProgress) {
      for (const [key] of resumeEntries) {
        const match = key.match(/^stack\.(.+)\.resume-state$/);
        if (!match) continue;
        const stackName = match[1];
        if (scopeStack && stackName !== scopeStack) continue;
        // Skip if an "empty-stack" finding already covers this stack (its
        // resume-state key is already listed under the stack-level finding).
        const alreadyCovered = findings.some(
          (f) => f.kind === "empty-stack" && f.stackName === stackName,
        );
        if (alreadyCovered) continue;
        findings.push({
          kind: "stale-resume-state",
          stackName,
          details:
            `Stack '${stackName}' has resume-state but no rebase is in progress.`,
          configKeys: [key],
        });
      }
    }
  }

  return {
    findings,
    stacksScanned: stackEntries.length,
    branchesScanned: branchEntries.length,
  };
}

/** Apply a list of findings by removing their config keys. */
export async function applyClean(
  dir: string,
  findings: CleanFinding[],
): Promise<CleanApplyResult> {
  const removed: string[] = [];
  const applied: CleanFinding[] = [];

  for (const finding of findings) {
    for (const key of finding.configKeys) {
      // git config --unset returns exit 5 if the key does not exist. We
      // treat that as success (idempotent) and still record the key as
      // removed.
      await runGitCommand(dir, "config", "--unset", key);
      removed.push(key);
    }
    applied.push(finding);
  }

  return { removed, applied };
}
