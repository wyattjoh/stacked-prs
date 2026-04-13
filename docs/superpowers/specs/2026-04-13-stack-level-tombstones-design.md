# Stack-Level Tombstones for Landed Branches

## Problem

When a branch is landed, `configLandCleanup` writes
`branch.<name>.stack-merged = true` to preserve the branch in the stack tree
for TUI display and nav comment rendering. However, `git branch -D` destroys
the entire `[branch "<name>"]` config section, taking `stack-merged`,
`stack-name`, and `stack-parent` with it. The landed branch vanishes from
`getStackTree`, so the TUI and nav comments lose all knowledge of it.

This was originally built across commits `d250bf8` through `819c985` with the
intent of preserving landed branches in the tree. The implementation is correct
between `configLandCleanup` and `git branch -D`, but the storage location
(`branch.*` namespace) cannot survive branch deletion.

## Solution

Move landed branch tombstones from `branch.<name>.stack-merged` to
`stack.<stackName>.landed-branches` (a multi-value git config key). This
survives branch deletion because it lives in the `[stack]` section, not the
`[branch]` section.

### Storage format

```ini
[stack "my-stack"]
    landed-branches = feature/a
    landed-branches = feature/b
```

- Written with `git config --add stack.<name>.landed-branches <branch>`
- Read with `git config --get-all stack.<name>.landed-branches`
- Cleared with `git config --unset-all stack.<name>.landed-branches`

Each value is a bare branch name. The parent for tombstoned branches is always
the stack's `baseBranch` (since `configLandCleanup` reparents children before
writing the tombstone). No additional metadata is stored.

`addLandedBranch` must be idempotent: if the branch name already exists in the
multi-value list, skip the write. This prevents duplicate entries if
`configLandCleanup` is called multiple times for the same branch (e.g., during
a resumed land).

### Display behavior

Landed branches appear as childless merged root nodes in the tree, rendered
above live roots. This matches the existing behavior when `stack-merged`
config survived (Option A from design discussion). Children of the landed
branch are reparented to the base branch and appear as independent roots or
subtrees.

## Changes

### `src/lib/stack.ts`

- Replace `setStackMerged(dir, branch)` with
  `addLandedBranch(dir, stackName, branch)`. The new function takes `stackName`
  as a parameter and writes to `stack.<stackName>.landed-branches` using
  `git config --add`.
- Remove the `stack-merged` unset from `removeStackBranch`. The
  `branch.<name>.stack-merged` key no longer exists in the new model.
- Update `getStackTree`: after building the live tree from `branch.*` config,
  read `stack.<stackName>.landed-branches` via `--get-all`. For each value,
  create a `StackNode` with `merged: true`, `parent = baseBranch`,
  `children = []`, and prepend to `roots`. Skip any tombstone whose branch name
  already appears in the live tree (deduplication guard).
- Retain the existing `branch.<name>.stack-merged` read in `getStackTree` as a
  backwards-compatibility fallback for repos that have old-format tombstones
  where the branch was not yet deleted.

### `src/commands/config.ts`

- `configLandCleanup`: call `addLandedBranch(dir, stackName, branch)` instead
  of `setStackMerged(dir, branch)`.
- `configSplitStack`: no change needed. Tombstones stay with the original stack
  name. Merged nodes are already excluded from splits.

### `src/commands/land.ts`

- `executeCaseBCleanup`: add `--unset-all` for
  `stack.<name>.landed-branches` alongside the existing `merge-strategy`,
  `base-branch`, and `resume-state` unsets.
- `removeStackBranch` calls after `git branch -D` remain unchanged (they clean
  up any remaining `branch.*` keys).

### No changes needed

- `src/commands/nav.ts`: already handles `node.merged` for strikethrough
  rendering and merged-root ordering.
- `src/commands/restack.ts`: already filters `!node.merged` in
  `topologicalOrder`.
- `src/commands/status.ts`: already returns `"landed"` sync status for merged
  nodes.
- `src/tui/state/loader.ts`: already sets `"landed"` sync for merged nodes.
- `src/tui/lib/layout.ts`: already walks merged roots before live roots.
- `src/tui/components/`: already handle merged cells with dimmed rendering and
  gap rows.
- `src/commands/clean.ts`: tombstones are at the stack level, not the branch
  level, so the branch-focused `detectStaleConfig` scan won't encounter them.

### Git config schema update

Add to `CLAUDE.md` schema:

```
stack.<stack-name>.landed-branches   # Multi-value: branch names landed from this stack
```

## Migration

Old repos may have `branch.<name>.stack-merged = true` entries from prior lands
where the branch has not yet been deleted. `getStackTree` continues to read
this flag as a fallback. No active migration step is needed because the old
format was already fragile (only survived if the branch was not deleted by git).

## Testing

- Unit test in `stack.test.ts`: verify `addLandedBranch` writes to stack-level
  config and `getStackTree` reconstructs merged root nodes from it.
- Unit test: verify tombstone survives `git branch -D` (create branch, add to
  stack, add tombstone, delete branch, read tree, assert merged node present).
- Unit test: verify deduplication (tombstone for a branch that still exists in
  the live tree is skipped).
- Unit test in `config.test.ts`: verify `configLandCleanup` writes stack-level
  tombstone instead of branch-level `stack-merged`.
- Integration test in `land.test.ts`: verify that after a full root-merged land
  (including branch deletion), the landed branch appears in the tree as a
  merged root.
- Integration test: verify `executeCaseBCleanup` clears `landed-branches`.
- Backwards compat test: verify that a branch with old-style
  `branch.<name>.stack-merged = true` still appears as merged in the tree.
