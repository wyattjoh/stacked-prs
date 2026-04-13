# Stack-Level Tombstones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move landed-branch tombstones from branch-level git config (destroyed by `git branch -D`) to stack-level git config so the TUI and nav comments retain knowledge of landed branches.

**Architecture:** Replace `setStackMerged` (writes `branch.<name>.stack-merged`) with `addLandedBranch` (writes multi-value `stack.<stackName>.landed-branches`). Update `getStackTree` to read tombstones from the stack-level key and synthesize merged root nodes. Retain backwards-compat read of the old `branch.<name>.stack-merged` flag.

**Tech Stack:** Deno TypeScript, git config CLI

---

### Task 1: Add `addLandedBranch` and `getLandedBranches` to `stack.ts`

**Files:**
- Modify: `src/lib/stack.ts:209-215` (replace `setStackMerged`)
- Test: `src/lib/stack.test.ts`

- [ ] **Step 1: Write the failing test for `addLandedBranch`**

In `src/lib/stack.test.ts`, add a new describe block after the existing "getStackTree merged field" block (line ~743):

```typescript
describe("addLandedBranch", () => {
  test("writes branch name to stack-level config", async () => {
    const repo = await createTestRepo();
    try {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");

      const { stdout } = await runGitCommand(
        repo.dir,
        "config",
        "--get-all",
        "stack.my-stack.landed-branches",
      );
      expect(stdout).toBe("feature/a");
    } finally {
      await repo.cleanup();
    }
  });

  test("supports multiple landed branches", async () => {
    const repo = await createTestRepo();
    try {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");
      await addLandedBranch(repo.dir, "my-stack", "feature/b");

      const { stdout } = await runGitCommand(
        repo.dir,
        "config",
        "--get-all",
        "stack.my-stack.landed-branches",
      );
      const branches = stdout.split("\n");
      expect(branches).toContain("feature/a");
      expect(branches).toContain("feature/b");
    } finally {
      await repo.cleanup();
    }
  });

  test("is idempotent: skips duplicate branch names", async () => {
    const repo = await createTestRepo();
    try {
      await setBaseBranch(repo.dir, "my-stack", "main");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");
      await addLandedBranch(repo.dir, "my-stack", "feature/a");

      const { stdout } = await runGitCommand(
        repo.dir,
        "config",
        "--get-all",
        "stack.my-stack.landed-branches",
      );
      expect(stdout).toBe("feature/a");
    } finally {
      await repo.cleanup();
    }
  });
});
```

Update the import at the top of `stack.test.ts` to include `addLandedBranch`:

```typescript
import {
  addLandedBranch,
  findNode,
  // ... existing imports
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/lib/stack.test.ts --filter "addLandedBranch"`
Expected: FAIL with "addLandedBranch is not a function" or similar import error

- [ ] **Step 3: Write `addLandedBranch` and `getLandedBranches`**

In `src/lib/stack.ts`, replace `setStackMerged` (lines 209-215) with:

```typescript
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
  await runGitCommand(
    dir,
    "config",
    "--add",
    `stack.${stackName}.landed-branches`,
    branch,
  );
}
```

Keep `setStackMerged` temporarily with a `@deprecated` annotation so the old export doesn't break existing test imports until Task 5 updates them:

```typescript
/**
 * @deprecated Use addLandedBranch instead. Retained for backwards-compat tests.
 */
export async function setStackMerged(
  dir: string,
  branch: string,
): Promise<void> {
  await runGitCommand(dir, "config", `branch.${branch}.stack-merged`, "true");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/lib/stack.test.ts --filter "addLandedBranch"`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/stack.ts src/lib/stack.test.ts
git commit -m "feat(stack): add addLandedBranch and getLandedBranches helpers"
```

---

### Task 2: Update `getStackTree` to read stack-level tombstones

**Files:**
- Modify: `src/lib/stack.ts:334-376` (`getStackTree` function)
- Test: `src/lib/stack.test.ts`

- [ ] **Step 1: Write the failing test for tombstone reconstruction**

In `src/lib/stack.test.ts`, add to the "addLandedBranch" describe block:

```typescript
test("getStackTree reconstructs merged root from stack-level tombstone", async () => {
  const repo = await createTestRepo();
  try {
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");

    // Simulate land: add tombstone, then delete branch (wipes branch config)
    await addLandedBranch(repo.dir, "my-stack", "feature/a");
    await runGit(repo.dir, "checkout", "main");
    await runGit(repo.dir, "branch", "-D", "feature/a");

    const tree = await getStackTree(repo.dir, "my-stack");
    const nodeA = tree.roots.find((n) => n.branch === "feature/a");
    const nodeB = tree.roots.find((n) => n.branch === "feature/b");

    expect(nodeA).toBeDefined();
    expect(nodeA!.merged).toBe(true);
    expect(nodeA!.parent).toBe("main");
    expect(nodeA!.children).toEqual([]);

    expect(nodeB).toBeDefined();
    expect(nodeB!.merged).toBeUndefined();
  } finally {
    await repo.cleanup();
  }
});

test("getStackTree deduplicates: live branch takes precedence over tombstone", async () => {
  const repo = await createTestRepo();
  try {
    await addBranch(repo.dir, "feature/a", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");

    // Add tombstone for a branch that still exists as a live node
    await addLandedBranch(repo.dir, "my-stack", "feature/a");

    const tree = await getStackTree(repo.dir, "my-stack");
    const nodes = getAllNodes(tree);

    // Should appear exactly once (live version, not merged)
    const matching = nodes.filter((n) => n.branch === "feature/a");
    expect(matching).toHaveLength(1);
    expect(matching[0].merged).toBeUndefined();
  } finally {
    await repo.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/lib/stack.test.ts --filter "reconstructs merged root|deduplicates"`
Expected: FAIL (tombstoned branch not found in tree after deletion)

- [ ] **Step 3: Update `getStackTree` to synthesize tombstone nodes**

In `src/lib/stack.ts`, in `getStackTree`, after building `roots` (line ~369) and before the `return` (line ~371), add:

```typescript
  // Roots are branches whose parent is the base branch
  const rootBranches = childrenMap.get(baseBranch) ?? [];
  const roots = rootBranches.map(buildNode);

  // Synthesize merged root nodes from stack-level tombstones.
  // Skip any tombstone that already appears in the live tree (dedup guard).
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

  return {
    stackName: resolvedStackName,
    baseBranch,
    mergeStrategy,
    roots: [...tombstoneRoots, ...roots],
  };
```

Remove the old `return` block that was at lines 371-376.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/lib/stack.test.ts --filter "reconstructs merged root|deduplicates"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/stack.ts src/lib/stack.test.ts
git commit -m "feat(stack): reconstruct merged roots from stack-level tombstones in getStackTree"
```

---

### Task 3: Remove `stack-merged` from `removeStackBranch`

**Files:**
- Modify: `src/lib/stack.ts:158-175` (`removeStackBranch`)

- [ ] **Step 1: Remove `stack-merged` key from `removeStackBranch`**

In `src/lib/stack.ts`, update `removeStackBranch` to remove `stack-merged` from the keys list:

```typescript
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
```

- [ ] **Step 2: Run full test suite to verify nothing breaks**

Run: `deno task test`
Expected: All existing tests pass (the `stack-merged` key is now written by `addLandedBranch` at the stack level, so unsetting it from branch config is a no-op)

- [ ] **Step 3: Commit**

```bash
git add src/lib/stack.ts
git commit -m "refactor(stack): remove stack-merged from removeStackBranch key list"
```

---

### Task 4: Update `configLandCleanup` to write stack-level tombstone

**Files:**
- Modify: `src/commands/config.ts:200-230` (`configLandCleanup`)
- Modify: `src/commands/config.ts:1-12` (imports)
- Test: `src/commands/config.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/commands/config.test.ts`, update the "sets stack-merged on the merged branch instead of removing it" test (line ~365) to verify the new storage:

```typescript
test("writes stack-level tombstone instead of branch-level stack-merged", async () => {
  await addBranch(repo.dir, "feature/a", "main");
  await addBranch(repo.dir, "feature/b", "feature/a");
  await setStackNode(repo.dir, "feature/a", "my-stack", "main");
  await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
  await setBaseBranch(repo.dir, "my-stack", "main");

  await configLandCleanup(repo.dir, "my-stack", "feature/a");

  // Tombstone is at the stack level, not branch level
  const { stdout } = await runGitCommand(
    repo.dir,
    "config",
    "--get-all",
    "stack.my-stack.landed-branches",
  );
  expect(stdout).toBe("feature/a");

  // feature/b must have been reparented to main
  const tree = await getStackTree(repo.dir, "my-stack");
  const nodeB = tree.roots.find((n) =>
    n.branch === "feature/b" && !n.merged
  );
  expect(nodeB).toBeDefined();
  expect(nodeB!.parent).toBe("main");
});
```

Add `runGitCommand` to the imports from `"../lib/stack.ts"` in `config.test.ts` if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/commands/config.test.ts --filter "writes stack-level tombstone"`
Expected: FAIL (still writing to branch-level config)

- [ ] **Step 3: Update `configLandCleanup` to use `addLandedBranch`**

In `src/commands/config.ts`, update the import to replace `setStackMerged` with `addLandedBranch`:

```typescript
import {
  getAllNodes,
  getMergeStrategy,
  getStackTree,
  type MergeStrategy,
  addLandedBranch,
  removeStackBranch,
  setBaseBranch,
  setMergeStrategy,
  setStackNode,
  type StackTree,
} from "../lib/stack.ts";
```

In `configLandCleanup`, replace the `setStackMerged` call (line ~217):

```typescript
  // Mark the merged branch as historical in stack-level config
  await addLandedBranch(dir, stackName, mergedBranch);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/commands/config.test.ts --filter "writes stack-level tombstone"`
Expected: PASS

- [ ] **Step 5: Run full config tests to check for regressions**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/commands/config.test.ts`
Expected: PASS. The "reparents direct children" and "multi-root after landing" tests should still pass because `getStackTree` now reads tombstones from the stack level.

- [ ] **Step 6: Commit**

```bash
git add src/commands/config.ts src/commands/config.test.ts
git commit -m "feat(config): write stack-level tombstone in configLandCleanup"
```

---

### Task 5: Update `land.ts` to clear `landed-branches` in all-merged cleanup

**Files:**
- Modify: `src/commands/land.ts:717-719` (`executeCaseBCleanup`)
- Modify: `src/commands/land.ts:1419-1421` (`executeLandFromCli` all-merged path)

- [ ] **Step 1: Add `--unset-all` for `landed-branches` in `executeCaseBCleanup`**

In `src/commands/land.ts`, in `executeCaseBCleanup` after the existing `unsetConfig` calls (lines 717-719), add:

```typescript
  await unsetConfig(dir, `stack.${plan.stackName}.merge-strategy`);
  await unsetConfig(dir, `stack.${plan.stackName}.base-branch`);
  await unsetConfig(dir, `stack.${plan.stackName}.resume-state`);
  await unsetAllConfig(dir, `stack.${plan.stackName}.landed-branches`);
```

Add the `unsetAllConfig` helper near the existing `unsetConfig` (line ~651):

```typescript
async function unsetAllConfig(dir: string, key: string): Promise<void> {
  await runGitCommand(dir, "config", "--unset-all", key);
}
```

- [ ] **Step 2: Add `--unset-all` in `executeLandFromCli` all-merged path**

In the `executeLandFromCli` function's all-merged path (lines 1419-1421), add the same cleanup:

```typescript
    await unsetConfig(dir, `stack.${stackName}.merge-strategy`);
    await unsetConfig(dir, `stack.${stackName}.base-branch`);
    await unsetConfig(dir, `stack.${stackName}.resume-state`);
    await unsetAllConfig(dir, `stack.${stackName}.landed-branches`);
```

- [ ] **Step 3: Run the existing all-merged land test**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/land.test.ts --filter "all-merged"`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/land.ts
git commit -m "fix(land): clear landed-branches config in all-merged cleanup paths"
```

---

### Task 6: Update existing tests and remove deprecated `setStackMerged`

**Files:**
- Modify: `src/lib/stack.test.ts` (update old merged-field tests)
- Modify: `src/lib/stack.ts` (remove deprecated `setStackMerged`)
- Modify: `src/commands/config.test.ts` (update old deferred-cleanup test)

- [ ] **Step 1: Update the old "getStackTree merged field" tests**

In `src/lib/stack.test.ts`, update the "sets merged=true on nodes whose branch.<name>.stack-merged is 'true'" test (line ~702) to become a backwards-compat test:

```typescript
describe("getStackTree merged field", () => {
  test("backwards compat: reads branch-level stack-merged flag", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feature/a", "main");
      await addBranch(repo.dir, "feature/b", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setStackNode(repo.dir, "feature/b", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");
      // Old-format: write directly to branch-level config
      await runGitCommand(
        repo.dir,
        "config",
        "branch.feature/a.stack-merged",
        "true",
      );

      const tree = await getStackTree(repo.dir, "my-stack");
      const nodeA = tree.roots.find((n) => n.branch === "feature/a");
      const nodeB = tree.roots.find((n) => n.branch === "feature/b");
      expect(nodeA?.merged).toBe(true);
      expect(nodeB?.merged).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  test("stack-level tombstone takes precedence when both formats exist", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feature/a", "main");
      await setStackNode(repo.dir, "feature/a", "my-stack", "main");
      await setBaseBranch(repo.dir, "my-stack", "main");
      // Write both old and new format
      await runGitCommand(
        repo.dir,
        "config",
        "branch.feature/a.stack-merged",
        "true",
      );
      await addLandedBranch(repo.dir, "my-stack", "feature/a");

      const tree = await getStackTree(repo.dir, "my-stack");
      // Should appear exactly once (live node with merged flag from branch-level)
      const matching = getAllNodes(tree).filter(
        (n) => n.branch === "feature/a",
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].merged).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
```

Remove the old "sets merged=true using setStackMerged helper" test since `setStackMerged` will be removed.

- [ ] **Step 2: Update config.test.ts deferred-cleanup test**

The test at line ~365 ("sets stack-merged on the merged branch instead of removing it") was already replaced in Task 4. Remove the old test if still present and verify the replacement test is correct (checking stack-level config, not branch-level).

- [ ] **Step 3: Remove `setStackMerged` from `stack.ts`**

Remove the deprecated `setStackMerged` function entirely from `src/lib/stack.ts`.

Remove `setStackMerged` from the import in `src/lib/stack.test.ts`.

- [ ] **Step 4: Run the full test suite**

Run: `deno task test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/stack.ts src/lib/stack.test.ts src/commands/config.test.ts
git commit -m "refactor(stack): remove deprecated setStackMerged, update tests for stack-level tombstones"
```

---

### Task 7: Update `StackNode.merged` JSDoc and `CLAUDE.md` schema

**Files:**
- Modify: `src/lib/stack.ts:187` (JSDoc on `merged` field)
- Modify: `CLAUDE.md` (git config schema section)

- [ ] **Step 1: Update `StackNode.merged` JSDoc**

In `src/lib/stack.ts`, update the JSDoc on the `merged` field (line ~187):

```typescript
  /** True when this branch has been landed. Source: stack.<stackName>.landed-branches or legacy branch.<name>.stack-merged. */
  merged?: boolean;
```

- [ ] **Step 2: Update `CLAUDE.md` git config schema**

In `CLAUDE.md`, add to the git config schema section:

```
stack.<stack-name>.landed-branches   # Multi-value: branch names landed from this stack
```

- [ ] **Step 3: Run type check**

Run: `deno task check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/stack.ts CLAUDE.md
git commit -m "docs: update StackNode JSDoc and CLAUDE.md schema for stack-level tombstones"
```

---

### Task 8: Integration test verifying tombstone survives `git branch -D`

**Files:**
- Test: `src/commands/land.test.ts`

- [ ] **Step 1: Write integration test**

Add to `src/commands/land.test.ts`, in the "executeLand case B (all-merged)" describe block or as a new sibling describe:

```typescript
describe("tombstone survives branch deletion", () => {
  it("landed branch appears in tree after git branch -D", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await initStack(repo, "s", [["feat/a", "main"], ["feat/b", "feat/a"]]);

      // Simulate what executeLand case A does:
      // 1. configLandCleanup (writes tombstone, reparents children)
      const { configLandCleanup } = await import("./config.ts");
      await configLandCleanup(repo.dir, "s", "feat/a");

      // 2. Delete the branch (destroys all branch.<name>.* config)
      await runGitCommand(repo.dir, "checkout", "main");
      await runGitCommand(repo.dir, "branch", "-D", "feat/a");

      // 3. Remove remaining branch config (mirrors removeStackBranch)
      const { removeStackBranch } = await import("../lib/stack.ts");
      await removeStackBranch(repo.dir, "feat/a");

      // Tree should still contain feat/a as a merged root
      const tree = await getStackTree(repo.dir, "s");
      const nodeA = tree.roots.find((n) => n.branch === "feat/a");
      expect(nodeA).toBeDefined();
      expect(nodeA!.merged).toBe(true);
      expect(nodeA!.parent).toBe("main");
      expect(nodeA!.children).toEqual([]);

      // feat/b should be a live root reparented to main
      const nodeB = tree.roots.find((n) => n.branch === "feat/b");
      expect(nodeB).toBeDefined();
      expect(nodeB!.merged).toBeUndefined();
      expect(nodeB!.parent).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });
});
```

Add `getStackTree` to the imports from `"../lib/stack.ts"` in `land.test.ts` if not already present.

- [ ] **Step 2: Run the test**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/land.test.ts --filter "tombstone survives"`
Expected: PASS

- [ ] **Step 3: Run the full test suite**

Run: `deno task test`
Expected: All tests pass

- [ ] **Step 4: Run `deno task install`**

Run: `deno task install`
Expected: Success (installs the updated binary)

- [ ] **Step 5: Commit**

```bash
git add src/commands/land.test.ts
git commit -m "test(land): add integration test verifying tombstone survives git branch -D"
```
