# Tombstone Migration: Remaining Cleanup

## Problem

Four loose ends remain from the stack-level tombstone migration and its
follow-ups. Each is small on its own. Bundling them lets one PR close out the
migration.

1. **LOG-002:** The CLI resumable land path (`executeLandFromCli`) does not
   detect auto-merged branches. After rebase, if a child's patch-id matches an
   ancestor on the new base, its `origin/<base>..branch` commit count is zero.
   The TUI executor (`executeLand`) tracks this via `state.autoMerged` and
   skips pushes, closes the PR, and deletes the branch. The CLI path does
   none of this: it pushes stale patches, issues PR retargets for branches
   that are already merged by content, and leaves the local branch. This is a
   pre-existing architectural gap the tombstone migration did not cause, but
   it's directly relevant: the follow-up work added tombstone writes to the
   CLI delete loop, yet the CLI never deletes auto-merged branches, so those
   tombstones are never written in the CLI path.
2. **LEGACY-001:** Repos that landed branches under the pre-migration model
   and kept the branch alive (unusual, e.g. a failed land) retain an orphan
   `branch.<name>.stack-merged = true` key forever. `getStackTree`'s
   backwards-compat read still honors it, so the node renders as merged
   indefinitely even after the branch is healthy again.
3. **DOC-001:** `src/tui/types.ts:61` JSDoc on `GridCell.merged` says
   `"True for historically merged branches (stack-merged = true)."`. The
   `stack-merged` key is no longer the primary source; tombstones live in
   `stack.<stackName>.landed-branches`.
4. **DOC-002:** `skills/stacked-prs/SKILL.md` documents every other git config
   key used by the plugin but never mentions `stack.<name>.landed-branches`.

## Solution

### LOG-002: Port auto-merged detection to `executeLandFromCli`

Extract the post-rebase auto-merge detection logic from `executeLand` into a
shared helper, then call it from the CLI path. The TUI executor sets
`state.autoMerged.add(branch)` at `src/commands/land.ts:833` when
`git rev-list --count origin/<base>..<branch>` returns `0` after rebase.

**New helper in `src/commands/land.ts`:**

```typescript
/**
 * True iff `branch` has zero unique commits beyond `origin/<base>`.
 * Indicates the branch was auto-merged by patch-id during rebase.
 */
async function isBranchAutoMerged(
  dir: string,
  branch: string,
  baseBranch: string,
): Promise<boolean> {
  const { code, stdout } = await runGitCommand(
    dir,
    "rev-list",
    "--count",
    `origin/${baseBranch}..${branch}`,
  );
  if (code !== 0) return false;
  return stdout.trim() === "0";
}
```

**Wire into `executeLandFromCli`** (root-merged path, around line 1440):

After each rebase step completes, check if the branch became auto-merged. If
so:
- Skip its push, PR update, and nav retarget steps (mirror the TUI logic at
  land.ts:895, 958, 1151).
- Add it to a local `autoMerged` set tracked in the resume state.
- Include it in the delete loop.
- Close its PR with the same "auto-merged by patch-id" comment used by the
  TUI path.

Extend `LandResumeState` with `autoMerged: string[]` (serialize as array, load
as Set). Existing resume states missing this field default to empty.

**Result:** CLI landers behave symmetrically to TUI landers. Every auto-merged
branch is pushed-skipped, PR-closed, deleted, and tombstoned.

### LEGACY-001: `clean` detects legacy `stack-merged` on live branches

`detectStaleConfig` in `src/commands/clean.ts` gains a new finding kind:
`"legacy-merged-flag"`. It scans all branches with `branch.<name>.stack-merged
= true` that also have `branch.<name>.stack-name` set. For each, the branch
ref still exists (otherwise `git branch -D` would have wiped the config).
This is the "stranded legacy flag" case: the user had a pre-migration land
that didn't complete, the branch is still around, and the flag is misleading.

`clean --confirm` removes the legacy key via
`git config --unset branch.<name>.stack-merged` (single-value). The branch's
`stack-name`/`stack-parent` config is left alone so the branch keeps its live
position in the stack.

No active migration step. `clean` is opt-in; users who want to scrub legacy
flags run it, users who don't never see a behavior change (the backwards-compat
read in `getStackTree` keeps rendering them as merged until cleaned).

### DOC-001: Update `GridCell.merged` JSDoc

Change `src/tui/types.ts:61` to:

```typescript
  /** True for historically merged (landed) branches. Source: stack-level tombstone or legacy branch-level stack-merged flag. */
  merged?: boolean;
```

Matches the updated JSDoc on `StackNode.merged` in `src/lib/stack.ts`.

### DOC-002: Document `landed-branches` in SKILL.md

`SKILL.md` should list the new key alongside the existing schema. The schema
table is already documented in `CLAUDE.md` at the repo root. `SKILL.md`
references git config keys inline throughout its runbook sections (e.g.
`git config stack.<name>.base-branch`). Add a brief note in the skill's
schema-adjacent section so Claude has context when orchestrating land/split
operations.

Specifically: near the `clean` command documentation (around line 478 in
SKILL.md), add `landed-branches` to the list of keys the clean command
considers. For example:

> `detectStaleConfig` also recognizes `stack.<name>.landed-branches` as the
> stack-level tombstone list. Entries there are expected to reference
> branches that have been landed and deleted; they are not stale.

If no dedicated schema section exists in SKILL.md, one brief paragraph
explaining the two tombstone storage locations (stack-level primary,
branch-level legacy) is sufficient. Do not duplicate the full schema;
reference `CLAUDE.md`.

## Changes

### `src/commands/land.ts`

- Add `isBranchAutoMerged(dir, branch, baseBranch)` helper.
- Add `autoMerged: string[]` to the `LandResumeState` interface.
- In `executeLandFromCli` root-merged path, after each rebase step, call
  `isBranchAutoMerged` and record results in `completed.autoMerged`.
- Skip push, PR update, and nav retarget for any branch in `completed.autoMerged`.
- Close PRs for auto-merged branches (same comment as TUI path).
- Add auto-merged branches to the delete loop.
- Serialize `completed.autoMerged` into resume state writes.

### `src/commands/clean.ts`

- Add `LegacyMergedFlagFinding` to the finding union.
- `detectStaleConfig` scans for `branch.*.stack-merged = true` on branches
  that still have `stack-name` + a live git ref.
- `applyCleanup` (or its equivalent) unsets the legacy key when `--confirm`.
- Update JSON output schema and the stale-config report format.

### `src/tui/types.ts`

- Update JSDoc on `GridCell.merged`.

### `skills/stacked-prs/SKILL.md`

- Note `landed-branches` as an expected key class in the clean section.

### Testing

- Unit test: `isBranchAutoMerged` correctly reports zero-count branches after
  a fixture rebase.
- Integration test: `executeLandFromCli` with an auto-merged child detects it,
  skips the push, closes the PR, deletes the branch, and tombstones it.
- Unit test in `clean.test.ts`: legacy `stack-merged` on a live branch is
  flagged and removed on `--confirm`.
- Unit test: legacy `stack-merged` on a branch with no ref is NOT flagged as
  a legacy-merged-flag finding (it's covered by the existing missing-branch
  path, which should continue to win).
- Manual: verify `deno task check` passes and CLAUDE.md schema is internally
  consistent with SKILL.md.

## Migration

No data migration. Behaviors are additive:
- LOG-002 fix: first run of `executeLandFromCli` after the change cleans up
  any pending auto-merged branches. No state is lost.
- LEGACY-001: `clean` must be run explicitly; default behavior unchanged.
- DOC-001, DOC-002: documentation only.

## Out of Scope

- Removing the backwards-compat read of `branch.<name>.stack-merged` in
  `getStackTree`. That removal can happen after at least one release cycle
  where `clean` has been available to scrub legacy flags.
- Deprecating or removing the CLI path (`executeLandFromCli`) in favor of
  TUI-only landing. That's a UX decision outside this cleanup scope.

## Risks and mitigations

- **LOG-002 complexity:** Porting the TUI auto-merged logic touches push, PR
  update, nav, and delete paths. Each addition must be guarded by the
  `autoMerged` check so existing behavior for non-auto-merged branches is
  preserved. Mitigation: add one code path at a time, run the full suite
  between each, and use `state.autoMerged` from the TUI path as the reference
  implementation. Do not try to share state between the two executors; copy
  the logic, don't abstract it prematurely.
- **LEGACY-001 false positives:** A user who intentionally sets
  `branch.<name>.stack-merged = true` (unlikely, but possible) would see it
  flagged as stale by `clean`. Acceptable: `clean` is opt-in and reports
  findings before mutating.
