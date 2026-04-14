# Tombstone Migration Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address three follow-up issues from the stack-level tombstones migration: orphaned tombstones on stack split (LOG-003), missing tombstones for auto-merged siblings (LOG-001), and a simulation-based integration test that doesn't actually invoke `executeLand` (TEST-001).

**Architecture:** Extend `configSplitStack` to copy tombstones into each new split stack and fully unset the original stack's config. Extend `executeLand` case A and `executeLandFromCli` root-merged delete loops to call `addLandedBranch` before deletion. Add a real `executeLand`-based integration test.

**Tech Stack:** Deno TypeScript, git config CLI

---

### Task 1: Propagate tombstones through `configSplitStack`

**Files:**
- Modify: `src/commands/config.ts:69-128` (`configSplitStack`)
- Modify: `src/commands/config.ts:1-12` (imports if needed)
- Test: `src/commands/config.test.ts`

- [ ] **Step 1: Read current `configSplitStack` to confirm line numbers**

Run: `head -130 /Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs/src/commands/config.ts | tail -65`

- [ ] **Step 2: Write the failing test for tombstone propagation**

Add to `src/commands/config.test.ts` in the existing `describe("configSplitStack")` block:

```typescript
test("copies tombstones to each new split stack", async () => {
  // Tree: main -> feature/a (will be tombstoned) -> feature/b, -> feature/c
  await addBranch(repo.dir, "feature/a", "main");
  await addBranch(repo.dir, "feature/b", "feature/a");
  await addBranch(repo.dir, "feature/c", "feature/a");

  await setBaseBranch(repo.dir, "multi", "main");
  await setStackNode(repo.dir, "feature/a", "multi", "main");
  await setStackNode(repo.dir, "feature/b", "multi", "feature/a");
  await setStackNode(repo.dir, "feature/c", "multi", "feature/a");

  // Reparent feature/b and feature/c to main to simulate post-land state
  await setStackNode(repo.dir, "feature/b", "multi", "main");
  await setStackNode(repo.dir, "feature/c", "multi", "main");
  // feature/a is tombstoned, no longer a live node
  const { removeStackBranch, addLandedBranch, getLandedBranches } =
    await import("../lib/stack.ts");
  await removeStackBranch(repo.dir, "feature/a");
  await addLandedBranch(repo.dir, "multi", "feature/a");

  const result = await configSplitStack(repo.dir, "multi");

  expect(result).toHaveLength(2);
  const stackNames = result.map((s) => s.stackName);
  expect(stackNames).toContain("b");
  expect(stackNames).toContain("c");

  // Each new split stack should have feature/a in its tombstones
  for (const name of stackNames) {
    const landed = await getLandedBranches(repo.dir, name);
    expect(landed).toEqual(["feature/a"]);
  }

  // Original stack's config must be fully unset
  const origLanded = await getLandedBranches(repo.dir, "multi");
  expect(origLanded).toEqual([]);
  const origBase = await gitConfig(repo.dir, "stack.multi.base-branch");
  expect(origBase).toBeUndefined();
});
```

Ensure `gitConfig` is imported in `config.test.ts` from `../lib/stack.ts`. If not already, add it.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs && deno test --allow-run=git --allow-env --allow-read --allow-write src/commands/config.test.ts --filter "copies tombstones"`

Expected: FAIL (tombstones are not propagated; original stack still has the tombstone + base-branch)

- [ ] **Step 4: Implement tombstone propagation in `configSplitStack`**

In `src/commands/config.ts`, update the imports to include `getLandedBranches`:

```typescript
import {
  addLandedBranch,
  getAllNodes,
  getLandedBranches,
  getMergeStrategy,
  getStackTree,
  type MergeStrategy,
  removeStackBranch,
  runGitCommand,
  setBaseBranch,
  setMergeStrategy,
  setStackNode,
  type StackTree,
} from "../lib/stack.ts";
```

(`runGitCommand` is needed for the `unset` calls; confirm it is exported from `stack.ts`.)

Then replace the body of `configSplitStack` with:

```typescript
export async function configSplitStack(
  dir: string,
  stackName: string,
): Promise<SplitInfo[]> {
  const tree = await getStackTree(dir, stackName);
  const baseBranch = tree.baseBranch;
  const mergeStrategy = await getMergeStrategy(dir, stackName);

  // Only live (non-merged) roots need to be split into new stacks
  const liveRoots = tree.roots.filter((n) => !n.merged);

  if (liveRoots.length <= 1) {
    return [];
  }

  // Build new stack names, ensuring no collisions
  const usedNames = new Set<string>();
  const splits: SplitInfo[] = [];

  for (const root of liveRoots) {
    let newName = deriveStackName(root.branch);
    // Resolve collision by appending a suffix
    if (usedNames.has(newName)) {
      let i = 2;
      while (usedNames.has(`${newName}-${i}`)) i++;
      newName = `${newName}-${i}`;
    }
    usedNames.add(newName);

    const subtreeNodes = getAllNodes({ ...tree, roots: [root] });
    const branches = subtreeNodes.map((n) => n.branch);
    splits.push({ stackName: newName, branches });
  }

  const nodeByBranch = new Map(getAllNodes(tree).map((n) => [n.branch, n]));

  // Write stack-level metadata for each split
  for (const split of splits) {
    await setBaseBranch(dir, split.stackName, baseBranch);
    if (mergeStrategy) {
      await setMergeStrategy(dir, split.stackName, mergeStrategy);
    }
  }

  // Copy tombstones from the original stack into every new split stack.
  // Each split is a logical continuation of the pre-land stack and should
  // display the same merge history.
  const tombstones = await getLandedBranches(dir, stackName);
  for (const split of splits) {
    for (const branch of tombstones) {
      await addLandedBranch(dir, split.stackName, branch);
    }
  }

  // Remove stack metadata only from live nodes
  const liveNodes = [...nodeByBranch.values()].filter((n) => !n.merged);
  for (const node of liveNodes) {
    await removeStackBranch(dir, node.branch);
  }

  // Write branch-level metadata pointing to new stacks
  for (const split of splits) {
    for (const branch of split.branches) {
      const node = nodeByBranch.get(branch)!;
      await setStackNode(dir, branch, split.stackName, node.parent);
    }
  }

  // Fully unset the original stack's config so it does not linger as an
  // orphan that `clean` would detect as empty.
  await unsetStackConfig(dir, stackName);

  return splits;
}

async function unsetStackConfig(
  dir: string,
  stackName: string,
): Promise<void> {
  const keys = [
    `stack.${stackName}.base-branch`,
    `stack.${stackName}.merge-strategy`,
    `stack.${stackName}.resume-state`,
  ];
  for (const key of keys) {
    await runGitCommand(dir, "config", "--unset", key);
  }
  // landed-branches is multi-value, use --unset-all
  await runGitCommand(
    dir,
    "config",
    "--unset-all",
    `stack.${stackName}.landed-branches`,
  );
}
```

- [ ] **Step 5: Run the new test**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/commands/config.test.ts --filter "copies tombstones"`
Expected: PASS

- [ ] **Step 6: Run full config.test.ts to check for regressions**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/commands/config.test.ts`
Expected: All pass. Existing split tests may break if they assert the original stack's base-branch still exists. If so, update those assertions: the original stack is now fully cleaned up after a split.

- [ ] **Step 7: Run `deno task check`**
Expected: clean

- [ ] **Step 8: Commit**

```bash
git add src/commands/config.ts src/commands/config.test.ts
git commit -m "feat(config): propagate tombstones to split stacks and clean up original"
```

---

### Task 2: End-to-end test for `configLandCleanup` triggering a split

**Files:**
- Test: `src/commands/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/commands/config.test.ts` in the existing `describe("configLandCleanup")` block (the one around line 268):

```typescript
test("split-triggering land: each new split sees the landed branch as tombstone", async () => {
  // Tree: main -> feature/a -> feature/b, -> feature/c
  // Land feature/a; splits into stacks b and c. Both must see feature/a
  // as a merged root in their reconstructed tree.
  await addBranch(repo.dir, "feature/a", "main");
  await addBranch(repo.dir, "feature/b", "feature/a");
  await addBranch(repo.dir, "feature/c", "feature/a");

  await setBaseBranch(repo.dir, "my-stack", "main");
  await setStackNode(repo.dir, "feature/a", "my-stack", "main");
  await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
  await setStackNode(repo.dir, "feature/c", "my-stack", "feature/a");

  const result = await configLandCleanup(repo.dir, "my-stack", "feature/a");

  expect(result.splitInto).toHaveLength(2);
  const stackNames = result.splitInto.map((s) => s.stackName);
  expect(stackNames).toContain("b");
  expect(stackNames).toContain("c");

  // Each split stack's tree must include feature/a as a merged root
  for (const name of stackNames) {
    const tree = await getStackTree(repo.dir, name);
    const tombstoneA = tree.roots.find((n) =>
      n.branch === "feature/a" && n.merged === true
    );
    expect(tombstoneA).toBeDefined();
    expect(tombstoneA!.parent).toBe("main");
    expect(tombstoneA!.children).toEqual([]);
  }
});
```

- [ ] **Step 2: Run the test**

Run: `deno test --allow-run=git --allow-env --allow-read --allow-write src/commands/config.test.ts --filter "split-triggering land"`
Expected: PASS (this exercises the Task 1 behavior end-to-end through `configLandCleanup`)

- [ ] **Step 3: Commit**

```bash
git add src/commands/config.test.ts
git commit -m "test(config): verify split-triggering land propagates tombstones"
```

---

### Task 3: Tombstone every deleted branch in `executeLand` case A

**Files:**
- Modify: `src/commands/land.ts` (delete loop in `executeCaseA`, around line 1078-1101)
- Modify: `src/commands/land.ts` imports (add `addLandedBranch` if not present)

No new test in this task. Task 5's end-to-end `executeLand` integration test validates the merged root is tombstoned. Auto-merged fixture setup is fragile and the call is idempotent with `configLandCleanup`, so the narrowly-scoped integration in Task 5 is sufficient.

- [ ] **Step 1: Verify `addLandedBranch` is importable**

Run: `grep -n 'addLandedBranch\|from "../lib/stack.ts"' /Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs/src/commands/land.ts`

If `addLandedBranch` is not already in the import from `../lib/stack.ts`, add it.

- [ ] **Step 2: Add `addLandedBranch` call to the delete loop**

In `src/commands/land.ts`, find `executeCaseA`'s delete loop (currently around line 1078-1101). It currently looks like:

```typescript
  // Delete the merged root and any auto-merged branches. Deletion failures
  // are best-effort: the stack has already landed at this point.
  const toDelete = [mergedRoot, ...state.autoMerged];
  await detachHeadFromDeleted(dir, toDelete);
  for (const branch of toDelete) {
    emit(hooks, { kind: "delete", branch }, "running");
    const { code: existsCode } = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    );
    if (existsCode !== 0) {
      emit(hooks, { kind: "delete", branch }, "skipped", "already absent");
      continue;
    }
    const { code, stderr } = await runGitCommand(dir, "branch", "-D", branch);
    if (code !== 0) {
      emit(hooks, { kind: "delete", branch }, "failed", stderr);
      continue;
    }
    await removeStackBranch(dir, branch);
    emit(hooks, { kind: "delete", branch }, "ok");
  }
```

Add one `addLandedBranch` call between the successful `git branch -D` and `removeStackBranch`:

```typescript
  // Delete the merged root and any auto-merged branches. Deletion failures
  // are best-effort: the stack has already landed at this point.
  const toDelete = [mergedRoot, ...state.autoMerged];
  await detachHeadFromDeleted(dir, toDelete);
  for (const branch of toDelete) {
    emit(hooks, { kind: "delete", branch }, "running");
    const { code: existsCode } = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    );
    if (existsCode !== 0) {
      emit(hooks, { kind: "delete", branch }, "skipped", "already absent");
      continue;
    }
    const { code, stderr } = await runGitCommand(dir, "branch", "-D", branch);
    if (code !== 0) {
      emit(hooks, { kind: "delete", branch }, "failed", stderr);
      continue;
    }
    // Record every deleted branch as a tombstone so the TUI retains history.
    // Idempotent with the configLandCleanup write for mergedRoot.
    await addLandedBranch(dir, plan.stackName, branch);
    await removeStackBranch(dir, branch);
    emit(hooks, { kind: "delete", branch }, "ok");
  }
```

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs && deno task test`
Expected: all 93 pass (no new tests added in this task)

- [ ] **Step 4: Run `deno task check`**
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/commands/land.ts
git commit -m "fix(land): tombstone every deleted branch in case A cleanup loop"
```

---

### Task 4: Write tombstones for deleted branches in `executeLandFromCli` root-merged path

**Files:**
- Modify: `src/commands/land.ts:1532-1552` (delete loop in `executeLandFromCli` root-merged path)

- [ ] **Step 1: Inspect the current delete loop in `executeLandFromCli`**

Run: `grep -n 'for (const branch of plan.branchesToDelete)' /Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs/src/commands/land.ts`

Locate the delete loop in the root-merged path (the one that runs after `configLandCleanup`, around line 1532).

- [ ] **Step 2: Add `addLandedBranch` call before `removeStackBranch`**

Modify the delete loop to call `addLandedBranch` for every branch being deleted. The loop currently looks like:

```typescript
  const mergedRoot = plan.branchesToDelete[0];
  await detachHeadFromDeleted(dir, plan.branchesToDelete);
  for (const branch of plan.branchesToDelete) {
    if (completed.deletedBranches.includes(branch)) continue;
    const { code: existsCode } = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    );
    if (existsCode !== 0) {
      completed.deletedBranches.push(branch);
      continue;
    }
    await runGitCommand(dir, "branch", "-D", branch);
    if (branch !== mergedRoot) {
      await removeStackBranch(dir, branch);
    }
    completed.deletedBranches.push(branch);
    await writeLandResumeState(dir, stackName, completed);
  }
```

Change it to:

```typescript
  const mergedRoot = plan.branchesToDelete[0];
  await detachHeadFromDeleted(dir, plan.branchesToDelete);
  for (const branch of plan.branchesToDelete) {
    if (completed.deletedBranches.includes(branch)) continue;
    const { code: existsCode } = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    );
    if (existsCode !== 0) {
      completed.deletedBranches.push(branch);
      continue;
    }
    await runGitCommand(dir, "branch", "-D", branch);
    // Idempotent: configLandCleanup already tombstoned mergedRoot above.
    await addLandedBranch(dir, stackName, branch);
    if (branch !== mergedRoot) {
      await removeStackBranch(dir, branch);
    }
    completed.deletedBranches.push(branch);
    await writeLandResumeState(dir, stackName, completed);
  }
```

- [ ] **Step 3: Run full test suite**

Run: `deno task test`
Expected: All pass. There is no specific test for the CLI auto-merged gap (LOG-002 is out of scope for this plan), but `plan.branchesToDelete` always includes the merged root, so the new call is harmlessly idempotent there.

- [ ] **Step 4: Run `deno task check`**
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/commands/land.ts
git commit -m "fix(land): tombstone deleted branches in CLI root-merged path"
```

---

### Task 5: Integration test exercising `executeLand` end-to-end

**Files:**
- Test: `src/commands/land.test.ts`

- [ ] **Step 1: Locate existing integration test patterns**

Run: `grep -n 'describe("executeLand case B' /Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs/src/commands/land.test.ts`

Note the pattern: creates a real git repo, sets up a stack via `initStack`, builds a `PrStateByBranch`, calls `planLand`, calls `executeLand`, asserts on repo state.

- [ ] **Step 2: Add an `executeLand` case A integration test**

Add to `src/commands/land.test.ts` near the existing `describe("executeLand case B (all-merged)")` block:

```typescript
describe("executeLand case A tombstone integration", () => {
  it("preserves merged root as tombstone after executeLand", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await commitFile(repo.dir, "feat/a", "a.txt", "a");
      await addBranch(repo.dir, "feat/b", "feat/a");
      await commitFile(repo.dir, "feat/b", "b.txt", "b");
      await initStack(repo, "s", [
        ["feat/a", "main"],
        ["feat/b", "feat/a"],
      ]);

      const prStates: PrStateByBranch = new Map([
        ["feat/a", "MERGED"],
        ["feat/b", "OPEN"],
      ]);
      const plan = await planLand(repo.dir, "s", prStates, new Map());

      await executeLand(repo.dir, plan, {
        onProgress: () => {},
        freshPrStates: () => Promise.resolve(prStates),
      });

      // feat/a local branch must be gone
      const probe = await runGitCommand(
        repo.dir,
        "rev-parse",
        "--verify",
        "refs/heads/feat/a",
      );
      expect(probe.code !== 0).toBe(true);

      // getStackTree must reconstruct feat/a as a merged root
      const tree = await getStackTree(repo.dir, "s");
      const tombstone = tree.roots.find((n) =>
        n.branch === "feat/a" && n.merged === true
      );
      expect(tombstone).toBeDefined();
      expect(tombstone!.parent).toBe("main");
      expect(tombstone!.children).toEqual([]);

      // feat/b must be a live root reparented to main
      const liveB = tree.roots.find((n) =>
        n.branch === "feat/b" && !n.merged
      );
      expect(liveB).toBeDefined();
      expect(liveB!.parent).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });
});
```

Ensure any required imports (`commitFile`, `PrStateByBranch`, `planLand`, `executeLand`, `getStackTree`) are already present at the top of the file. If any are missing, add them to the import block.

- [ ] **Step 3: Run the test**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/land.test.ts --filter "tombstone integration"`
Expected: PASS

- [ ] **Step 4: Run full test suite and `deno task check`**

Run: `deno task test && deno task check`
Expected: all pass, clean check

- [ ] **Step 5: Commit**

```bash
git add src/commands/land.test.ts
git commit -m "test(land): integration test for tombstone preservation via executeLand"
```

---

### Task 6: Run `deno task install` and final sanity check

**Files:** none

- [ ] **Step 1: Install the updated binary**

Run: `cd /Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs && deno task install`
Expected: success. The user runs the global binary as their daily driver.

- [ ] **Step 2: Final full test run**

Run: `deno task test`
Expected: All tests pass.

- [ ] **Step 3: Verify commit history**

Run: `git log --oneline bfd2ac3..HEAD`
Expected: 5 commits from this plan (one per Task 1-5).
