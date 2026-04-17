import { getActiveRefLoader } from "./loaders.ts";

export type MergeStrategy = "merge" | "squash";

/** @deprecated Used only by migration tests to create old-format stack data. Do not use in new code. */
export interface SetStackBranchOpts {
  stackName: string;
  parent: string;
  order: number;
}

const decoder = new TextDecoder();

/**
 * Run a git command, return { code, stdout, stderr } with decoded strings.
 * stdout and stderr are returned raw (not trimmed). Prefer `runGitCommand`
 * unless you need to preserve leading/trailing whitespace or NUL bytes.
 */
export async function runGitCommandRaw(
  dir: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

/** Run a git command, return { code, stdout, stderr } with trimmed strings. */
export async function runGitCommand(
  dir: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runGitCommandRaw(dir, ...args);
  return {
    code: result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

/** Run `git config` with given args, return trimmed stdout or undefined on failure. */
export async function gitConfig(
  dir: string,
  ...args: string[]
): Promise<string | undefined> {
  const { code, stdout } = await runGitCommand(dir, "config", ...args);
  if (code !== 0) return undefined;
  return stdout;
}

/** Run `git config <key> <value>`, throw on failure. */
async function gitConfigSet(
  dir: string,
  key: string,
  value: string,
): Promise<void> {
  const { code, stderr } = await runGitCommand(dir, "config", key, value);
  if (code !== 0) {
    throw new Error(`git config ${key} ${value} failed: ${stderr}`);
  }
}

/**
 * Detect the repo's default branch. Tries origin/HEAD first (the canonical
 * source), then falls back to a local `main` or `master`. Throws when none
 * resolves.
 */
export async function detectDefaultBranch(dir: string): Promise<string> {
  const originHead = await runGitCommand(
    dir,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  if (originHead.code === 0 && originHead.stdout) {
    const trimmed = originHead.stdout.replace(/^origin\//, "");
    if (trimmed) return trimmed;
  }

  for (const candidate of ["main", "master"]) {
    const probe = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${candidate}`,
    );
    if (probe.code === 0) return candidate;
  }

  throw new Error(
    "Could not detect default branch: no origin/HEAD and no local main or master",
  );
}

/**
 * Run `git rev-parse <ref>` and return the trimmed SHA. Throws on failure.
 * Shared by restack and land to avoid duplicate implementations.
 *
 * When an active ref loader is installed (see `loaders.ts`), the lookup
 * batches through it so parallel callers share one `git cat-file
 * --batch-check` subprocess instead of forking per-ref.
 */
export async function revParse(dir: string, ref: string): Promise<string> {
  const loader = getActiveRefLoader();
  if (loader) {
    const sha = await loader.load(ref);
    if (sha !== null) return sha;
    throw new Error(`git rev-parse ${ref} failed: ref not found`);
  }
  const { code, stdout, stderr } = await runGitCommand(dir, "rev-parse", ref);
  if (code !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${stderr}`);
  }
  return stdout;
}

export interface ResumeStore<T> {
  read(): Promise<T | null>;
  write(state: T): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Build a JSON-backed resume-state store against `stack.<stackName>.<key>`.
 * Reads return null if the key is absent or fails to parse; writes overwrite;
 * clear removes the key (swallowing "key absent" exit codes).
 */
export function resumeStore<T>(
  dir: string,
  stackName: string,
  key: string,
): ResumeStore<T> {
  const configKey = `stack.${stackName}.${key}`;
  return {
    async read() {
      const { code, stdout } = await runGitCommand(dir, "config", configKey);
      if (code !== 0) return null;
      try {
        return JSON.parse(stdout) as T;
      } catch {
        return null;
      }
    },
    async write(state: T) {
      await runGitCommand(dir, "config", configKey, JSON.stringify(state));
    },
    async clear() {
      await runGitCommand(dir, "config", "--unset", configKey);
    },
  };
}

/**
 * Resolve a ref to its SHA, or return null if it does not exist. Uses
 * `git rev-parse --verify --quiet` so a missing ref is an expected outcome,
 * not an error. Shared probe for sync, submit-plan, restack, etc.
 *
 * When an active ref loader is installed, concurrent calls coalesce
 * into a single `git cat-file --batch-check` subprocess. The loader
 * returns `null` for refs git reports as missing, matching this
 * function's no-ref-found contract.
 */
export async function tryResolveRef(
  dir: string,
  ref: string,
): Promise<string | null> {
  const loader = getActiveRefLoader();
  if (loader) {
    return await loader.load(ref);
  }
  const { code, stdout } = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  );
  if (code !== 0) return null;
  return stdout || null;
}

/**
 * If HEAD currently points to a symbolic ref in `branches`, detach it to the
 * current commit SHA so those branches can be deleted. No-op when HEAD is
 * already detached or points to a surviving branch.
 */
export async function detachHeadIfIn(
  dir: string,
  branches: readonly string[],
): Promise<void> {
  const { code, stdout } = await runGitCommand(
    dir,
    "symbolic-ref",
    "--short",
    "HEAD",
  );
  if (code !== 0) return; // already detached
  if (!branches.includes(stdout.trim())) return;
  const { code: shaCode, stdout: sha } = await runGitCommand(
    dir,
    "rev-parse",
    "HEAD",
  );
  if (shaCode !== 0) return;
  await runGitCommand(dir, "checkout", "--detach", sha.trim());
}

/** Return the list of unmerged (conflict) file paths in `dir`. */
export async function getConflictFiles(dir: string): Promise<string[]> {
  const { stdout } = await runGitCommand(
    dir,
    "diff",
    "--name-only",
    "--diff-filter=U",
  );
  return stdout ? stdout.split("\n").filter(Boolean) : [];
}

/** True iff a git rebase is currently in progress in `dir`. */
export async function rebaseInProgress(dir: string): Promise<boolean> {
  const { code } = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    "REBASE_HEAD",
  );
  return code === 0;
}

export type SyncStatus = "up-to-date" | "behind-parent" | "diverged" | "landed";

/**
 * Determine how `branch`'s tip relates to `parent`'s: up-to-date if parent
 * is an ancestor of branch, behind-parent if the reverse is true, otherwise
 * diverged. Callers map the "landed" variant themselves from tombstones.
 */
export async function computeSyncStatus(
  dir: string,
  branch: string,
  parent: string,
): Promise<SyncStatus> {
  const { code: fwd } = await runGitCommand(
    dir,
    "merge-base",
    "--is-ancestor",
    parent,
    branch,
  );
  if (fwd === 0) return "up-to-date";
  const { code: rev } = await runGitCommand(
    dir,
    "merge-base",
    "--is-ancestor",
    branch,
    parent,
  );
  if (rev === 0) return "behind-parent";
  return "diverged";
}

/** Run `git config --get-regexp <pattern>`, return parsed lines as [key, value] pairs. */
export async function gitConfigGetRegexp(
  dir: string,
  pattern: string,
): Promise<Array<[string, string]>> {
  const result = await gitConfig(dir, "--get-regexp", pattern);
  if (!result) return [];

  return result
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const spaceIndex = line.indexOf(" ");
      const key = line.slice(0, spaceIndex);
      const value = line.slice(spaceIndex + 1);
      return [key, value] as [string, string];
    });
}

/**
 * @deprecated Used only by migration tests to create old-format stack data. Do not use in new code.
 * Write stack metadata for a branch using the old linear format (with stack-order).
 */
export async function setStackBranch(
  dir: string,
  branch: string,
  opts: SetStackBranchOpts,
): Promise<void> {
  await gitConfigSet(dir, `branch.${branch}.stack-name`, opts.stackName);
  await gitConfigSet(dir, `branch.${branch}.stack-parent`, opts.parent);
  await gitConfigSet(dir, `branch.${branch}.stack-order`, String(opts.order));
}

/** Get the merge strategy for a stack. Returns undefined if not set. */
export async function getMergeStrategy(
  dir: string,
  stackName: string,
): Promise<MergeStrategy | undefined> {
  const value = await gitConfig(dir, `stack.${stackName}.merge-strategy`);
  if (!value) return undefined;
  if (value === "merge" || value === "squash") return value;
  return undefined;
}

/**
 * Resolve the default merge strategy for newly-initialized stacks. Reads
 * `stack.default-merge-strategy` from git config (local repo, inherits global
 * and system) and falls back to "squash" when unset or invalid.
 */
export async function getDefaultMergeStrategy(
  dir: string,
): Promise<MergeStrategy> {
  const value = await gitConfig(dir, "stack.default-merge-strategy");
  if (value === "merge" || value === "squash") return value;
  return "squash";
}

/** Set the merge strategy for a stack. */
export async function setMergeStrategy(
  dir: string,
  stackName: string,
  strategy: MergeStrategy,
): Promise<void> {
  await gitConfigSet(dir, `stack.${stackName}.merge-strategy`, strategy);
}

/** Remove all stack metadata for a branch. */
export async function removeStackBranch(
  dir: string,
  branch: string,
): Promise<void> {
  const keys = [
    `branch.${branch}.stack-name`,
    `branch.${branch}.stack-parent`,
    `branch.${branch}.stack-order`,
  ];

  // Ignore exit codes: key may not exist (exit 5 from git config --unset).
  // Run sequentially to avoid git config file lock contention.
  for (const key of keys) {
    await runGitCommand(dir, "config", "--unset", key);
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface StackNode {
  branch: string;
  stackName: string;
  parent: string;
  children: StackNode[];
  /** True when this branch has been landed. Source: stack.<stackName>.landed-branches or legacy branch.<name>.stack-merged. */
  merged?: boolean;
}

export interface StackTree {
  stackName: string;
  baseBranch: string;
  mergeStrategy: MergeStrategy | undefined;
  roots: StackNode[];
}

/** Write tree-model metadata for a branch (stack-name + stack-parent, no order). */
export async function setStackNode(
  dir: string,
  branch: string,
  stackName: string,
  parent: string,
): Promise<void> {
  await gitConfigSet(dir, `branch.${branch}.stack-name`, stackName);
  await gitConfigSet(dir, `branch.${branch}.stack-parent`, parent);
}

/** Read all landed branch names for a stack (multi-value key). */
export async function getLandedBranches(
  dir: string,
  stackName: string,
): Promise<string[]> {
  const { code, stdout } = await runGitCommand(
    dir,
    "config",
    "--get-all",
    `stack.${stackName}.landed-branches`,
  );
  if (code !== 0 || !stdout) return [];
  return stdout.split("\n").filter(Boolean);
}

/**
 * Record a branch as landed in the stack-level config.
 * Idempotent: skips the write if the branch is already recorded.
 */
export async function addLandedBranch(
  dir: string,
  stackName: string,
  branch: string,
): Promise<void> {
  const existing = await getLandedBranches(dir, stackName);
  if (existing.includes(branch)) return;
  const { code, stderr } = await runGitCommand(
    dir,
    "config",
    "--add",
    `stack.${stackName}.landed-branches`,
    branch,
  );
  if (code !== 0) {
    throw new Error(
      `git config --add stack.${stackName}.landed-branches ${branch} failed: ${stderr}`,
    );
  }
}

/**
 * Read landed PR numbers for a stack as a branch -> PR number map.
 *
 * Stored under the multi-value key `stack.<name>.landed-pr` with values of
 * the form `<branch>:<number>`. Branch names cannot contain `:` per git ref
 * rules, so the delimiter is unambiguous. Values that fail to parse are
 * silently skipped so a hand-edited config can't break the reader.
 */
export async function getLandedPrs(
  dir: string,
  stackName: string,
): Promise<Map<string, number>> {
  const { code, stdout } = await runGitCommand(
    dir,
    "config",
    "--get-all",
    `stack.${stackName}.landed-pr`,
  );
  const result = new Map<string, number>();
  if (code !== 0 || !stdout) return result;
  for (const line of stdout.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const branch = line.slice(0, sep);
    const num = Number(line.slice(sep + 1));
    if (!branch || !Number.isFinite(num)) continue;
    result.set(branch, num);
  }
  return result;
}

/**
 * Record the PR number for a landed branch. Idempotent: a branch that
 * already has a recorded number is left alone (the first number wins).
 */
export async function addLandedPr(
  dir: string,
  stackName: string,
  branch: string,
  prNumber: number,
): Promise<void> {
  const existing = await getLandedPrs(dir, stackName);
  if (existing.has(branch)) return;
  const { code, stderr } = await runGitCommand(
    dir,
    "config",
    "--add",
    `stack.${stackName}.landed-pr`,
    `${branch}:${prNumber}`,
  );
  if (code !== 0) {
    throw new Error(
      `git config --add stack.${stackName}.landed-pr ${branch}:${prNumber} failed: ${stderr}`,
    );
  }
}

/**
 * Read landed parent branches for a stack as a branch -> parent-branch map.
 *
 * Stored under the multi-value key `stack.<n>.landed-parent` with values of
 * the form `<branch>:<parent>`. Written at tombstone time so tombstones
 * keep their structural position in the tree after `git branch -D` wipes
 * their `branch.<name>.stack-*` config.
 */
export async function getLandedParents(
  dir: string,
  stackName: string,
): Promise<Map<string, string>> {
  const { code, stdout } = await runGitCommand(
    dir,
    "config",
    "--get-all",
    `stack.${stackName}.landed-parent`,
  );
  const result = new Map<string, string>();
  if (code !== 0 || !stdout) return result;
  for (const line of stdout.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const branch = line.slice(0, sep);
    const parent = line.slice(sep + 1);
    if (!branch || !parent) continue;
    result.set(branch, parent);
  }
  return result;
}

/**
 * Record the original stack-parent for a landed branch. Idempotent: the
 * first recorded parent wins so split stacks and resumed lands don't
 * overwrite the correct historical parent with a stale one.
 */
export async function addLandedParent(
  dir: string,
  stackName: string,
  branch: string,
  parent: string,
): Promise<void> {
  const existing = await getLandedParents(dir, stackName);
  if (existing.has(branch)) return;
  const { code, stderr } = await runGitCommand(
    dir,
    "config",
    "--add",
    `stack.${stackName}.landed-parent`,
    `${branch}:${parent}`,
  );
  if (code !== 0) {
    throw new Error(
      `git config --add stack.${stackName}.landed-parent ${branch}:${parent} failed: ${stderr}`,
    );
  }
}

/** Get the base branch for a stack. Returns undefined if not set. */
export async function getBaseBranch(
  dir: string,
  stackName: string,
): Promise<string | undefined> {
  return await gitConfig(dir, `stack.${stackName}.base-branch`);
}

/** Set the base branch for a stack. */
export async function setBaseBranch(
  dir: string,
  stackName: string,
  baseBranch: string,
): Promise<void> {
  await gitConfigSet(dir, `stack.${stackName}.base-branch`, baseBranch);
}

/**
 * Remove all stack-level config keys for a stack.
 * Used when a stack is fully landed or split and its namespace should be freed.
 * Tolerates exit 5 ("key absent") from git config --unset; any other non-zero
 * exit is an actual failure (lock contention, permissions, etc.) and throws.
 */
export async function clearStackConfig(
  dir: string,
  stackName: string,
): Promise<void> {
  const singleValueKeys = [
    `stack.${stackName}.base-branch`,
    `stack.${stackName}.merge-strategy`,
    `stack.${stackName}.resume-state`,
    `stack.${stackName}.color`,
  ];
  for (const key of singleValueKeys) {
    const { code, stderr } = await runGitCommand(dir, "config", "--unset", key);
    if (code !== 0 && code !== 5) {
      throw new Error(`git config --unset ${key} failed: ${stderr}`);
    }
  }
  // landed-branches, landed-pr, and landed-parent are multi-value;
  // --unset-all removes all.
  const multiValueKeys = [
    `stack.${stackName}.landed-branches`,
    `stack.${stackName}.landed-pr`,
    `stack.${stackName}.landed-parent`,
  ];
  for (const key of multiValueKeys) {
    const { code, stderr } = await runGitCommand(
      dir,
      "config",
      "--unset-all",
      key,
    );
    if (code !== 0 && code !== 5) {
      throw new Error(`git config --unset-all ${key} failed: ${stderr}`);
    }
  }
}

export interface BranchStackEntry {
  stackName?: string;
  parent?: string;
  merged?: boolean;
  order?: number;
}

/**
 * Scan every `branch.<name>.stack-*` key in the repo in a single git
 * subprocess and parse the result into a per-branch entry map. Cheap to
 * call once at the top of a planner; callers that previously issued
 * N parallel `git config branch.<b>.stack-*` lookups should use this
 * instead.
 */
export async function readAllBranchStackConfig(
  dir: string,
): Promise<Map<string, BranchStackEntry>> {
  const entries = await gitConfigGetRegexp(dir, "^branch\\..*\\.stack-");
  const out = new Map<string, BranchStackEntry>();
  for (const [key, value] of entries) {
    const match = key.match(/^branch\.(.+)\.stack-(name|parent|merged|order)$/);
    if (!match) continue;
    const [, branch, field] = match;
    const entry = out.get(branch) ?? {};
    if (field === "name") entry.stackName = value;
    else if (field === "parent") entry.parent = value;
    else if (field === "merged") entry.merged = value === "true";
    else if (field === "order") entry.order = Number(value);
    out.set(branch, entry);
  }
  return out;
}

/**
 * Build a StackTree for the given stack name (or detect from current branch).
 *
 * `preScan`, if supplied, is the output of a prior `readAllBranchStackConfig`
 * call. Callers that build multiple trees in a row (e.g. `getAllStackTrees`,
 * the TUI loader, `computeSyncPlan`) should scan once and pass the result
 * to every `getStackTree` invocation to skip O(N)-per-tree fork overhead.
 */
export async function getStackTree(
  dir: string,
  stackName?: string,
  preScan?: Map<string, BranchStackEntry>,
): Promise<StackTree> {
  let resolvedStackName = stackName;

  if (!resolvedStackName) {
    const { code, stdout } = await runGitCommand(
      dir,
      "branch",
      "--show-current",
    );
    if (code !== 0) throw new Error("Could not determine current branch");

    const currentBranch = stdout;
    if (!currentBranch) throw new Error("Not on any branch");

    resolvedStackName = await gitConfig(
      dir,
      `branch.${currentBranch}.stack-name`,
    );
    if (!resolvedStackName) {
      throw new Error(`Current branch ${currentBranch} is not part of a stack`);
    }
  }

  // Try to read base branch but defer the missing-branch error until after
  // migration, which may write it for the first time from old-format stacks.
  let baseBranch = await getBaseBranch(dir, resolvedStackName);

  const mergeStrategy = await getMergeStrategy(dir, resolvedStackName);

  // Single scan of every `branch.<name>.stack-*` key. One fork replaces
  // what used to be O(N) per-key shell-outs (stack-name, stack-parent,
  // stack-merged, stack-order) during tree construction. Reuse the
  // caller-supplied pre-scan when available so multi-tree callers pay
  // this cost once rather than per tree.
  const branchConfig = preScan ?? await readAllBranchStackConfig(dir);

  const matchingBranches: string[] = [];
  for (const [branch, entry] of branchConfig) {
    if (entry.stackName === resolvedStackName) matchingBranches.push(branch);
  }
  matchingBranches.sort();

  // Auto-migrate old linear format (stack-order keys) to tree format.
  // Only attempt migration when base-branch is missing, indicating an old stack.
  if (!baseBranch) {
    const hasOrderKeys = matchingBranches.some((b) =>
      branchConfig.get(b)?.order !== undefined
    );

    if (hasOrderKeys) {
      // Read all parents to determine which branch's parent is NOT in the stack.
      // That parent is the base branch.
      const branchSet = new Set(matchingBranches);
      const detectedBase = matchingBranches
        .map((b) => branchConfig.get(b)?.parent)
        .find((p) => p !== undefined && !branchSet.has(p));

      if (detectedBase) {
        await setBaseBranch(dir, resolvedStackName, detectedBase);

        // Remove all stack-order keys now that the tree model is in place.
        // Run sequentially to avoid git config file lock contention.
        for (const branch of matchingBranches) {
          await runGitCommand(
            dir,
            "config",
            "--unset",
            `branch.${branch}.stack-order`,
          );
        }

        // Re-read baseBranch now that migration has written it.
        baseBranch = await getBaseBranch(dir, resolvedStackName);
      }
    }
  }

  if (!baseBranch) {
    throw new Error(`Stack ${resolvedStackName} has no base branch configured`);
  }

  const branchParents = new Map<string, string>();
  const mergedFlags = new Map<string, boolean>();
  for (const branch of matchingBranches) {
    const entry = branchConfig.get(branch);
    if (entry?.parent) branchParents.set(branch, entry.parent);
    if (entry?.merged) mergedFlags.set(branch, true);
  }

  // Stack-level tombstones mark landed branches. Their structural parent
  // comes from `stack.<n>.landed-parent`, written at tombstone time so it
  // survives `git branch -D` wiping `branch.<name>.stack-*`. When the
  // record is missing (legacy stacks, post-split fallback), the tombstone
  // synthesizes as a root-level merged node below.
  const landedBranches = await getLandedBranches(dir, resolvedStackName);
  const landedSet = new Set(landedBranches);
  const landedParents = await getLandedParents(dir, resolvedStackName);
  const matchingSet = new Set(matchingBranches);
  for (const branch of landedSet) {
    mergedFlags.set(branch, true);
    const recordedParent = landedParents.get(branch);
    if (recordedParent !== undefined && !branchParents.has(branch)) {
      branchParents.set(branch, recordedParent);
    }
  }

  // Build parent -> children map
  const childrenMap = new Map<string, string[]>();
  for (const [branch, parent] of branchParents) {
    const siblings = childrenMap.get(parent) ?? [];
    siblings.push(branch);
    childrenMap.set(parent, siblings);
  }

  // Sort each sibling list alphabetically
  for (const siblings of childrenMap.values()) {
    siblings.sort();
  }

  // Recursively build StackNode from a branch name. Tombstones read their
  // parent from `branchParents` (which is seeded from landed-parent for
  // branches whose live config was wiped on `branch -D`).
  const buildNode = (branch: string): StackNode => {
    const children = (childrenMap.get(branch) ?? []).map(buildNode);
    return {
      branch,
      stackName: resolvedStackName!,
      parent: branchParents.get(branch)!,
      children,
      ...(mergedFlags.get(branch) ? { merged: true } : {}),
    };
  };

  // Roots include live branches rooted at `baseBranch` plus any tombstone
  // whose recorded parent is the base branch. `childrenMap.get(baseBranch)`
  // already covers both when landed-parent has been seeded above.
  const rootBranches = childrenMap.get(baseBranch) ?? [];
  const roots = rootBranches.map(buildNode);

  // Legacy / post-split fallback: tombstones recorded in landed-branches
  // with no parent record and no branch-level stack-name entry get
  // synthesized as root-level merged nodes so nav and status can still
  // render them. If a live descendant still references the legacy
  // tombstone via its stack-parent (manual-edit / partial-write scenarios
  // that a strict schema would disallow), attach that subtree to the
  // synthesized tombstone so the descendant remains visible rather than
  // being silently dropped.
  const placedBranches = new Set<string>();
  const collect = (node: StackNode): void => {
    placedBranches.add(node.branch);
    for (const c of node.children) collect(c);
  };
  for (const r of roots) collect(r);

  const legacyTombstones: StackNode[] = [];
  for (const branch of landedSet) {
    if (placedBranches.has(branch)) continue;
    if (matchingSet.has(branch)) continue;
    const orphanChildren = (childrenMap.get(branch) ?? [])
      .filter((c) => !placedBranches.has(c))
      .map(buildNode);
    for (const c of orphanChildren) collect(c);
    legacyTombstones.push({
      branch,
      stackName: resolvedStackName,
      parent: baseBranch,
      children: orphanChildren,
      merged: true,
    });
  }
  legacyTombstones.sort((a, b) => a.branch.localeCompare(b.branch));

  return {
    stackName: resolvedStackName,
    baseBranch,
    mergeStrategy,
    roots: [...legacyTombstones, ...roots],
  };
}

/**
 * Build a branch-name -> StackNode lookup for constant-time node queries.
 * Callers that perform many `effectiveParent` / `findNode` lookups over
 * the same tree should build the index once and reuse it rather than
 * letting each call perform an O(N) DFS.
 */
export function indexTree(tree: StackTree): Map<string, StackNode> {
  const index = new Map<string, StackNode>();
  for (const n of getAllNodes(tree)) index.set(n.branch, n);
  return index;
}

// Per-tree memoized index. Stored via WeakMap so the map is released when
// the tree is garbage collected, and never mutated through the public
// StackTree shape (keeps the tree a plain data struct for tests).
const TREE_INDEX = new WeakMap<StackTree, Map<string, StackNode>>();
function lookup(tree: StackTree, branch: string): StackNode | undefined {
  let idx = TREE_INDEX.get(tree);
  if (!idx) {
    idx = indexTree(tree);
    TREE_INDEX.set(tree, idx);
  }
  return idx.get(branch);
}

/**
 * Walk up `node.parent` through tombstone (merged) ancestors until reaching
 * a live branch or the base branch. Returns the first non-tombstone ancestor
 * branch name, or the tree's base branch if the chain is entirely tombstones
 * (or the parent cannot be resolved in the tree).
 *
 * `reparented` is an optional per-branch override: when present, the override
 * short-circuits the walk. Sync uses this to feed a pre-execution projection
 * into planners that read an un-tombstoned tree.
 *
 * Internally this uses a per-tree lookup table memoized on the input `tree`
 * object, so repeated calls with the same tree share a single O(N) index
 * build rather than doing an O(N) DFS per walk step.
 */
export function effectiveParent(
  tree: StackTree,
  node: StackNode,
  reparented?: Record<string, string>,
): string {
  const override = reparented?.[node.branch];
  if (override !== undefined) return override;
  let p = node.parent;
  while (p !== tree.baseBranch) {
    const parentNode = lookup(tree, p);
    if (!parentNode) return tree.baseBranch;
    if (!parentNode.merged) return parentNode.branch;
    p = parentNode.parent;
  }
  return tree.baseBranch;
}

/**
 * Live branches whose effective parent (after walking past tombstones) is
 * the base branch. Used to detect multi-subtree situations after a land,
 * where a single merged root may leave several independent live branches.
 */
export function getLiveSubtreeRoots(tree: StackTree): StackNode[] {
  return getAllNodes(tree)
    .filter((n) => !n.merged)
    .filter((n) => effectiveParent(tree, n) === tree.baseBranch);
}

/** Depth-first pre-order traversal of a single node. */
export function walkDFS(node: StackNode): StackNode[] {
  return [node, ...node.children.flatMap(walkDFS)];
}

/** All leaf nodes (no children) in the tree. */
export function getLeaves(tree: StackTree): StackNode[] {
  return getAllNodes(tree).filter((node) => node.children.length === 0);
}

/** Flat list of all nodes via DFS across all roots. */
export function getAllNodes(tree: StackTree): StackNode[] {
  return tree.roots.flatMap(walkDFS);
}

/** Path from root to a specific branch. Returns undefined if not found. */
export function getPathTo(
  tree: StackTree,
  branch: string,
): StackNode[] | undefined {
  const findPath = (
    node: StackNode,
    target: string,
  ): StackNode[] | undefined => {
    if (node.branch === target) return [node];
    for (const child of node.children) {
      const childPath = findPath(child, target);
      if (childPath) return [node, ...childPath];
    }
    return undefined;
  };

  for (const root of tree.roots) {
    const path = findPath(root, branch);
    if (path) return path;
  }
  return undefined;
}

/** Return the subtree node rooted at the given branch. */
export function getSubtree(
  tree: StackTree,
  branch: string,
): StackNode | undefined {
  return findNode(tree, branch);
}

export interface RenderTreeOptions {
  /** Map of branch name -> annotation string (e.g., "PR #101 (open)  up-to-date") */
  annotations?: Map<string, string>;
  /** Branch name to mark with "<- you are here" */
  currentBranch?: string;
  /** Branch name to mark with "◄" (for nav comments) */
  highlightBranch?: string;
  /** Map of branch name -> status prefix (e.g., "✓", "✗", "⊘") */
  statusIcons?: Map<string, string>;
}

/**
 * Render a StackTree as a box-drawing tree string.
 *
 * Root nodes get no connector prefix. Non-root children get "├── " (if not
 * last sibling) or "└── " (if last). Continuation indent under ├── is "│   "
 * and under └── is "    ".
 */
export function renderTree(tree: StackTree, opts: RenderTreeOptions): string {
  const lines: string[] = [];

  const renderNode = (
    node: StackNode,
    prefix: string,
    connector: string,
  ): void => {
    const icon = opts.statusIcons?.get(node.branch);
    const annotation = opts.annotations?.get(node.branch);

    const namePart = icon ? `${icon} ${node.branch}` : node.branch;

    let suffix = "";
    if (annotation) suffix += `  ${annotation}`;
    if (opts.highlightBranch === node.branch) suffix += " ◄";
    if (opts.currentBranch === node.branch) suffix += "  <- you are here";

    lines.push(`${prefix}${connector}${namePart}${suffix}`);

    const childPrefix = prefix +
      (connector === "├── " ? "│   " : connector === "└── " ? "    " : "");

    for (let i = 0; i < node.children.length; i++) {
      const isLast = i === node.children.length - 1;
      renderNode(
        node.children[i],
        childPrefix,
        isLast ? "└── " : "├── ",
      );
    }
  };

  for (let i = 0; i < tree.roots.length; i++) {
    renderNode(tree.roots[i], "", "");
  }

  return lines.join("\n");
}

/** Find a node by branch name. */
export function findNode(
  tree: StackTree,
  branch: string,
): StackNode | undefined {
  // Reuse the per-tree WeakMap index so repeated lookups over the same
  // tree are O(1) after the first O(N) build, instead of paying O(N) DFS
  // on every call.
  return lookup(tree, branch);
}

/** Validate a tree's metadata consistency.
 *
 * Checks:
 * 1. All branches in the tree resolve to real git refs.
 * 2. Any branch recorded in git config with this stack-name that is NOT
 *    present in the tree is reported as orphaned.
 */
export async function validateStackTree(
  dir: string,
  tree: StackTree,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const nodes = getAllNodes(tree);
  const nodeSet = new Set(nodes.map((n) => n.branch));

  // Check 1: every live node must resolve to a real git ref. Tombstones are
  // intentionally refless, so skip them.
  await Promise.all(
    nodes.filter((n) => !n.merged).map(async (node) => {
      const { code } = await runGitCommand(
        dir,
        "rev-parse",
        "--verify",
        `refs/heads/${node.branch}`,
      );
      if (code !== 0) {
        errors.push(
          `Branch ${node.branch} does not exist as a git ref`,
        );
      }
    }),
  );

  // Check 2: find orphaned branches (in config for this stack but not in tree)
  const configLines = await gitConfigGetRegexp(
    dir,
    "^branch\\..*\\.stack-name$",
  );
  const configBranches = configLines
    .filter(([, value]) => value === tree.stackName)
    .map(([key]) => {
      const match = key.match(/^branch\.(.+)\.stack-name$/);
      return match ? match[1] : null;
    })
    .filter((branch): branch is string => branch !== null);

  for (const branch of configBranches) {
    if (!nodeSet.has(branch)) {
      errors.push(
        `Branch ${branch} is orphaned: it has stack metadata for "${tree.stackName}" but is not reachable in the tree`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Enumerate all configured stack names in the repo, sorted alphabetically. */
export async function listAllStacks(dir: string): Promise<string[]> {
  const branchConfig = await readAllBranchStackConfig(dir);
  const set = new Set<string>();
  for (const entry of branchConfig.values()) {
    if (entry.stackName) set.add(entry.stackName);
  }
  return [...set].sort();
}

/** Load every configured stack in the repo as a StackTree.
 *
 * Broken stacks (missing base branch, unresolvable parents, etc.) are
 * skipped silently; only successfully loaded trees are returned. Callers
 * that need to distinguish "stack is broken" from "stack does not exist"
 * should call `getStackTree` directly per name from `listAllStacks`.
 *
 * One `branch.*.stack-*` config scan is shared across every per-stack
 * `getStackTree` call so loading M stacks pays O(1) config-scan forks
 * instead of O(M).
 */
export async function getAllStackTrees(dir: string): Promise<StackTree[]> {
  const branchConfig = await readAllBranchStackConfig(dir);
  const names = new Set<string>();
  for (const entry of branchConfig.values()) {
    if (entry.stackName) names.add(entry.stackName);
  }
  const results = await Promise.all(
    [...names].sort().map(async (name) => {
      try {
        return await getStackTree(dir, name, branchConfig);
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((tree): tree is StackTree => tree !== undefined);
}
