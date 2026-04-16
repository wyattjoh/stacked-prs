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
 */
export async function revParse(dir: string, ref: string): Promise<string> {
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
 */
export async function tryResolveRef(
  dir: string,
  ref: string,
): Promise<string | null> {
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
  ];
  for (const key of singleValueKeys) {
    const { code, stderr } = await runGitCommand(dir, "config", "--unset", key);
    if (code !== 0 && code !== 5) {
      throw new Error(`git config --unset ${key} failed: ${stderr}`);
    }
  }
  // landed-branches and landed-pr are multi-value; --unset-all removes all.
  const multiValueKeys = [
    `stack.${stackName}.landed-branches`,
    `stack.${stackName}.landed-pr`,
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

/** Build a StackTree for the given stack name (or detect from current branch). */
export async function getStackTree(
  dir: string,
  stackName?: string,
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

  const lines = await gitConfigGetRegexp(dir, "^branch\\..*\\.stack-name$");

  const matchingBranches = lines
    .filter(([, value]) => value === resolvedStackName)
    .map(([key]) => {
      const match = key.match(/^branch\.(.+)\.stack-name$/);
      return match ? match[1] : null;
    })
    .filter((branch): branch is string => branch !== null);

  // Auto-migrate old linear format (stack-order keys) to tree format.
  // Only attempt migration when base-branch is missing, indicating an old stack.
  if (!baseBranch) {
    const orderValues = await Promise.all(
      matchingBranches.map((branch) =>
        gitConfig(dir, `branch.${branch}.stack-order`)
      ),
    );
    const hasOrderKeys = orderValues.some((v) => v !== undefined);

    if (hasOrderKeys) {
      // Read all parents to determine which branch's parent is NOT in the stack.
      // That parent is the base branch.
      const branchSet = new Set(matchingBranches);
      const parents = await Promise.all(
        matchingBranches.map(async (branch) => ({
          branch,
          parent: await gitConfig(dir, `branch.${branch}.stack-parent`),
        })),
      );

      const detectedBase = parents.find(
        ({ parent }) => parent !== undefined && !branchSet.has(parent),
      )?.parent;

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
  await Promise.all(
    matchingBranches.map(async (branch) => {
      const parent = await gitConfig(dir, `branch.${branch}.stack-parent`);
      if (parent) branchParents.set(branch, parent);
    }),
  );

  const mergedFlags = new Map<string, boolean>();
  await Promise.all(
    matchingBranches.map(async (branch) => {
      const val = await gitConfig(dir, `branch.${branch}.stack-merged`);
      if (val === "true") mergedFlags.set(branch, true);
    }),
  );

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

  // Recursively build StackNode from a branch name
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

  // Roots are branches whose parent is the base branch
  const rootBranches = childrenMap.get(baseBranch) ?? [];
  const roots = rootBranches.map(buildNode);

  // Synthesize merged root nodes from stack-level tombstones.
  // Skip any tombstone that already appears in the live tree (dedup guard).
  // Use matchingBranches (all stack-name holders), not just tree nodes, so
  // partially-configured live branches still suppress tombstones.
  const liveBranches = new Set(matchingBranches);
  const landedBranches = await getLandedBranches(dir, resolvedStackName);
  const tombstoneRoots: StackNode[] = [];
  for (const branch of landedBranches) {
    if (liveBranches.has(branch)) continue;
    tombstoneRoots.push({
      branch,
      stackName: resolvedStackName,
      parent: baseBranch,
      children: [],
      merged: true,
    });
  }
  tombstoneRoots.sort((a, b) => a.branch.localeCompare(b.branch));

  return {
    stackName: resolvedStackName,
    baseBranch,
    mergeStrategy,
    roots: [...tombstoneRoots, ...roots],
  };
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
  const search = (node: StackNode): StackNode | undefined => {
    if (node.branch === branch) return node;
    for (const child of node.children) {
      const found = search(child);
      if (found) return found;
    }
    return undefined;
  };

  for (const root of tree.roots) {
    const found = search(root);
    if (found) return found;
  }
  return undefined;
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
  const lines = await gitConfigGetRegexp(dir, "^branch\\..*\\.stack-name$");
  const set = new Set<string>();
  for (const [, value] of lines) set.add(value);
  return [...set].sort();
}

/** Load every configured stack in the repo as a StackTree.
 *
 * Broken stacks (missing base branch, unresolvable parents, etc.) are
 * skipped silently; only successfully loaded trees are returned. Callers
 * that need to distinguish "stack is broken" from "stack does not exist"
 * should call `getStackTree` directly per name from `listAllStacks`.
 */
export async function getAllStackTrees(dir: string): Promise<StackTree[]> {
  const names = await listAllStacks(dir);
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        return await getStackTree(dir, name);
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((tree): tree is StackTree => tree !== undefined);
}
