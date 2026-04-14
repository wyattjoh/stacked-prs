# Tombstone Migration Follow-ups

## Problem

The stack-level tombstone migration (see
`2026-04-13-stack-level-tombstones-design.md`) is correct for the base case but
leaves three loose ends surfaced during end-to-end code review:

1. **LOG-003 (regression):** When `configLandCleanup` triggers a stack split,
   the tombstone lives on the original stack name. The original stack ends up
   with no live branches, so `clean` flags it as empty and deletes it,
   destroying the tombstone. None of the new split stacks inherit the
   tombstone, so history is lost in the TUI for every downstream branch.
2. **LOG-001 (completeness):** Auto-merged siblings deleted in the `executeLand`
   case A cleanup loop never get tombstones written. Pre-migration they were
   also lost, so this is not a regression, but the new storage model makes the
   asymmetry visible (the root is preserved, its auto-merged siblings vanish).
3. **TEST-001 (test quality):** The "tombstone survives branch deletion"
   integration test composes the cleanup steps manually (`configLandCleanup` +
   `git branch -D` + `removeStackBranch`) instead of invoking `executeLand`. If
   `executeLand`'s ordering drifts, the test keeps passing while reality breaks.

## Solution

### LOG-003: Copy tombstones to every split stack

When `configLandCleanup` triggers `configSplitStack`, the tombstone is copied
to every new split stack's `landed-branches` key, and the original stack's
config is fully unset.

**Flow after fix:**

1. `configLandCleanup` reparents children and writes tombstone to
   `stack.<originalName>.landed-branches` (unchanged).
2. `configLandCleanup` calls `configSplitStack` when `liveRoots > 1`.
3. `configSplitStack`:
   - Reads all tombstones from `stack.<originalName>.landed-branches`.
   - For each new split stack, writes those tombstones to
     `stack.<newName>.landed-branches`.
   - After moving live branches, unsets the original stack's `base-branch`,
     `merge-strategy`, `landed-branches`, and `resume-state` (resume-state
     may not exist; that's fine). The original stack name is fully cleaned up.
4. Every split stack's `getStackTree` sees the merged root as a tombstone.

Tombstones are copied verbatim (no deduplication needed since the reader
already dedups against live branches per-stack). The "one tombstone per land"
invariant is loosened to "one tombstone per stack that descended from the
original." This is the correct semantics: each split is a logical continuation
of the pre-land stack and should display the common ancestry.

**No change needed** when the land does NOT trigger a split (linear stack case).
The tombstone stays on the original stack, which still has live branches.

### LOG-001: Write tombstones for auto-merged siblings

In `executeLand` case A (`executeCaseA` in `src/commands/land.ts`) and in
`executeLandFromCli`'s root-merged path, the branch deletion loop walks
`[mergedRoot, ...state.autoMerged]`. Today the loop calls `git branch -D`
followed by `removeStackBranch` for each. The fix: insert
`await addLandedBranch(dir, plan.stackName, branch)` for every branch before
deletion, so auto-merged siblings are tombstoned alongside the root.

Idempotency in `addLandedBranch` means re-running a resumed land does not
produce duplicate tombstone entries.

**executeLandFromCli root-merged path:** The CLI path tracks
`plan.branchesToDelete` but does not compute an `autoMerged` set (pre-existing
gap per LOG-002). For this spec, we only write tombstones for branches the CLI
path already knows it's deleting (i.e. `plan.branchesToDelete`, which contains
only the merged root under current CLI behavior). The broader CLI
auto-merged gap is out of scope.

### TEST-001: Integration test that invokes executeLand

Replace or supplement the "tombstone survives branch deletion" test in
`src/commands/land.test.ts` with a test that:

1. Builds a root-merged fixture (linear stack).
2. Calls `executeLand` end-to-end with a PR state map marking the root as
   MERGED and mock gh fixtures for the PR-update/nav steps.
3. Asserts that after `executeLand` returns, `getStackTree` reconstructs the
   merged root as a tombstone node with `merged: true`, `parent = baseBranch`,
   and `children: []`.
4. Asserts that the local branch for the merged root is deleted
   (`rev-parse --verify refs/heads/<name>` exits non-zero).

The existing simulated test can stay as a unit-level guard on the
`configLandCleanup` → `branch -D` → `removeStackBranch` ordering. The new test
is the real integration guard.

Add a second integration test for LOG-001: a root-merged land with an
auto-merged sibling. Assert both branches appear as tombstones in the
post-land tree.

## Changes

### `src/commands/config.ts`

- `configSplitStack`: after computing `splits` and writing per-split
  `base-branch`/`merge-strategy`, read
  `getLandedBranches(dir, stackName)` and for each tombstone call
  `addLandedBranch(dir, split.stackName, branch)` for every split. Then unset
  `stack.<originalStackName>.{base-branch, merge-strategy, landed-branches,
  resume-state}`.
- Add an internal helper `unsetStackConfig(dir, stackName)` or inline the
  four `runGitCommand --unset` calls; the helper is cleaner and easier to
  keep in sync with new stack-level keys in the future.

### `src/lib/stack.ts`

No changes. The existing `getLandedBranches` and `addLandedBranch` helpers
already support multi-value reads and idempotent writes.

### `src/commands/land.ts`

- In `executeCaseA`'s delete loop (around line 1075-1101), before
  `removeStackBranch`, call
  `await addLandedBranch(dir, plan.stackName, branch)`.
- In `executeLandFromCli`'s root-merged delete loop (around line 1534-1546),
  same change.

### `src/commands/clean.ts`

No changes required. After the fix, `configLandCleanup`-driven splits leave no
orphan original-stack keys, so `detectStaleConfig` never encounters them.

### `src/commands/config.test.ts`

- Add a test for `configSplitStack` that asserts tombstones propagate to each
  new stack and the original stack's config is fully unset.
- Add a test for `configLandCleanup` where a land triggers a split and the
  resulting stacks each see the landed branch as a merged root.

### `src/commands/land.test.ts`

- Add an end-to-end `executeLand` test (case A, linear) that asserts the
  merged root survives as a tombstone in `getStackTree`.
- Add an `executeLand` test for a root-merged land with an auto-merged sibling.
  Assert both appear as tombstones.

## Migration

No data migration needed. Existing repos do not have orphan original-stack
tombstones (the bug was introduced by the first migration and not shipped
outside local development). Going forward:

- New splits automatically propagate tombstones.
- If any repo does end up with an orphan original-stack key (e.g., from a land
  that completed between the first migration and this fix), `clean` will flag
  it and the user can remove it manually or via `clean --confirm`. The loss of
  that one tombstone is acceptable since the bug has been present only briefly.

## Testing

- Unit: `configSplitStack` copies tombstones to all splits and unsets original
  stack config.
- Unit: `configLandCleanup` in a multi-child root-merged scenario leaves each
  new split with the correct tombstone.
- Integration: `executeLand` case A (linear) preserves tombstone.
- Integration: `executeLand` case A with auto-merged sibling preserves both
  tombstones.
- Regression: all existing `configLandCleanup` tests continue to pass
  (non-split path unchanged).

## Out of Scope

- **LOG-002**: The CLI `executeLandFromCli` path does not track
  auto-merged branches at all. This is a pre-existing architectural gap
  orthogonal to the tombstone storage model. Fixing it requires porting the
  post-rebase `rev-list --count` detection from the TUI executor. Separate
  concern, separate spec.
- **LEGACY-001**: Repos with old-format `branch.<name>.stack-merged` keys on
  live branches. These keys linger harmlessly; `getStackTree`'s backwards-compat
  read still honors them. A one-shot migration in `getStackTree` could rewrite
  them as tombstones on load, but the risk/benefit doesn't justify the complexity
  for an edge case affecting only repos that had a failed pre-migration land.
- **DOC-001, DOC-002**: Minor doc drift in `src/tui/types.ts:61` and unverified
  `SKILL.md`. Address as a single cleanup commit separate from this spec.
