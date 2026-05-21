# Drop "stack name" from the data model

## Summary

Remove the `stackName` concept entirely. A stack is no longer an
identifiable, named entity with its own git-config namespace. Instead, a
stack is the set of branches reachable from a root via parent pointers,
where a root is any branch whose `stack-parent` equals the base branch.
The root branch's name doubles as the stack's UI label.

Stack-level metadata (base branch, merge strategy) is replicated per
branch with cascade lookup. Resume state is a single repo-level slot.
Color is derived deterministically from the root branch name. Tombstones
(`landed-*` multi-values) are removed entirely: `land` reparents children
to the nearest surviving ancestor and deletes the landed branch outright,
matching Graphite's model.

A one-shot auto-migration converts legacy `stack.<name>.*` and
`branch.<n>.stack-name` configs to the new schema on first run of any
command. The migration is silent (one stderr notice), idempotent, and
runs in-line.

This is a 3.0 release.

## Motivation

The `stackName` key is a second source of truth alongside the parent
pointer tree, and it drifts. Renames, lands, and reparents require
keeping the name in sync with the topology, and bugs there have shown up
several times (tombstone reparenting, root-land state migration, the
`stack-order` removal migration). Graphite's CLI proves the data model
works without a named stack entity: stacks are pure derived views over
parent pointers.

Side benefits:

- Removes a creation-time hurdle (no name to invent at `init`/`import`).
- Removes a class of "which stack does this branch belong to?" bugs by
  collapsing identity into topology.
- Shrinks the git-config schema by eliminating the `stack.*` namespace
  and the `landed-*` multi-values.

## Data Model

### New git-config schema

| Scope      | Key                                  | Replaces                       | Notes                                                                                |
| ---------- | ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------ |
| per-branch | `branch.<name>.stack-parent`         | (kept)                         | Parent branch name, or the base branch name for root branches                        |
| per-branch | `branch.<name>.base-branch`          | `stack.<sn>.base-branch`       | Replicated to every branch in the stack at creation time                             |
| per-branch | `branch.<name>.merge-strategy`       | `stack.<sn>.merge-strategy`    | Replicated to every branch in the stack at creation time                             |
| repo-level | `stacked-prs.resume-state`           | `stack.<sn>.resume-state`      | Single slot; at most one in-flight rebase per repo                                   |
| repo-level | `stacked-prs.default-merge-strategy` | `stack.default-merge-strategy` | Renamed for namespace cleanup; falls back to `"squash"` when unset                   |

### Deleted keys

- `branch.<n>.stack-name`
- `stack.<sn>.base-branch`
- `stack.<sn>.merge-strategy`
- `stack.<sn>.resume-state`
- `stack.<sn>.landed-branches`
- `stack.<sn>.landed-pr`
- `stack.<sn>.landed-parent`
- `stack.<sn>.color`
- `stack.default-merge-strategy`

After migration, the entire `stack.*` namespace is empty.

### Read semantics

Two new helpers in `lib/stack.ts`:

```ts
getEffectiveBaseBranch(branch: string): string;
getEffectiveMergeStrategy(branch: string): "merge" | "squash";
```

Both walk the parent chain from `branch` upward, returning the first
ancestor that has a value set. If no ancestor has one, falls back to the
repo-level default (`stacked-prs.default-merge-strategy` for strategy;
hard error for base branch since every tracked branch must have one
somewhere in its chain).

In practice, `create` always copies parent's values onto the new branch,
so the cascade walk is a one-step lookup. The cascade exists as a
correctness backstop for hand-edited configs and partial migration
states.

### Stack identity

A stack is identified by its root branch's name. A root is any tracked
branch whose `stack-parent` equals the base branch. Two roots with the
same base branch are two separate stacks. There is no synthetic stack
key anywhere in the config or in the in-memory types.

`StackTree.stackName` is removed. Wherever code today identifies a stack
by `stackName`, it identifies it by `rootBranch: string` instead.

## CLI Surface Changes

### Flags removed

| Command                | Before                  | After                   |
| ---------------------- | ----------------------- | ----------------------- |
| `cli.ts init`          | `--stack-name <n>` flag | flag removed            |
| `cli.ts import`        | `--stack-name <n>` flag | flag removed            |
| `cli.ts create --root` | `--stack-name <n>` flag | flag removed            |

All other commands (`status`, `restack`, `nav`, `verify-refs`,
`import-discover`, `submit`, `sync`, `pr`, `land`, `clean`, `insert`,
`fold`, `move`, `split`) take no stack-name input today and are
unaffected at the flag level.

### Behavior of remaining commands

- `init`: writes `stack-parent`, `base-branch`, `merge-strategy` on the
  current branch. Defaults match today's defaults.
- `import`: discovers the tree via the existing `import-discover` logic
  and writes the per-branch trio onto every discovered branch. Reuses
  today's `--base-branch` and `--merge-strategy` flags as the values to
  replicate.
- `create`: copies `base-branch` and `merge-strategy` from parent onto
  the new branch. For the auto-init case (current branch is the base),
  writes the trio onto the new root branch.
- `land`: see "Land behavior change" below.
- `restack`: reads and writes `stacked-prs.resume-state` (repo-level).
  Refuses fresh runs while a resume slot exists, pointing the user at
  `restack --resume`. No semantic change beyond the key location.
- All other commands: lose any internal `stackName` references in their
  types and JSON output (see below).

### JSON output

Every `--json` output today that includes a `stackName` field replaces
it with `rootBranch`. Affected commands: `status`, `restack`, `submit`,
`sync`, `pr`, `land`, `clean`. This is a breaking JSON change documented
in the 3.0 release notes; the TUI and `SKILL.md` consumers are updated
in the same change.

## Land Behavior Change

Today `land` writes tombstones (`stack.<sn>.landed-*` multi-values) and
keeps merged branches present in nav-comment rendering. New behavior:

1. Confirm the PR is merged on GitHub.
2. Fast-forward the local base branch.
3. Reparent every direct child of the landed branch onto the landed
   branch's former parent (the base, for a root land; the nearest
   surviving ancestor, for a mid-stack land). One config write per
   child: `branch.<child>.stack-parent = <new-parent>`.
4. `git branch -D` the landed branch. Its `branch.<n>.*` config keys are
   removed automatically by git.
5. Recompute nav comments for surviving descendants. Merged branches do
   not appear in nav comments anymore.

This makes mid-stack land first-class: any branch whose PR has been
merged can be landed, and reparenting handles its children correctly.
Today's SKILL.md runbook focuses on root land; the runbook is updated to
describe both cases.

`lib/cleanup.ts` loses its tombstone capture/writing helpers. The
merged-branch preview becomes a "branches that will be deleted and
children that will be reparented" preview, used by both `land` and the
TUI's land modal.

## Color

`lib/colors.ts` switches from "assign next color per stack" to a stable
hash of the root branch name:

```ts
function paletteIndexFor(rootBranchName: string): number {
  // stable, deterministic, repo-independent
  return cyrb53(rootBranchName) % palette.length;
}
```

Two repos with the same root branch name produce the same color. A root
rename produces a new color. `stack.<sn>.color` override is dropped with
no replacement flag.

## Resume State

One repo-level slot at `stacked-prs.resume-state`. Holds the same JSON
shape as today's `stack.<sn>.resume-state` value, minus any
`stackName`-equivalent field (the queue of branches and the
`rebasedBranchBase` are enough to resume). At most one in-flight rebase
per repo at any time, matching Graphite. Fresh `restack` calls fail with
a message pointing at `restack --resume` when the slot is non-empty.

## Auto-Migration

### Trigger

`lib/migration.ts` runs at the top of `getAllStackTrees()` and any other
reader that touches legacy state. Each command invocation makes one
cheap probe:

```
git config --local --name-only --get-regexp '^(branch\.[^.]+\.stack-name|stack\.)'
```

If the probe returns nothing, return immediately. Steady-state cost is
one no-op git invocation per command.

### Steps when legacy keys are detected

1. **Snapshot.** Read every `branch.<n>.stack-name`, every
   `stack.<sn>.*`, and `stack.default-merge-strategy` into memory.
2. **Validate.** Refuse migration if more than one legacy stack has a
   non-empty `resume-state`. The user must finish or abort their
   in-flight rebase via the prior version, then re-upgrade.
3. **Write new keys.** For each tracked branch, write
   `branch.<n>.base-branch` and `branch.<n>.merge-strategy` from its
   stack's `stack.<sn>.*` row. Write `stacked-prs.resume-state` if
   exactly one stack has one. Write `stacked-prs.default-merge-strategy`
   if the legacy default existed.
4. **Delete legacy keys.** All `branch.<n>.stack-name`, all `stack.*`.
5. **Notice.** Print one stderr line:
   `stacked-prs: migrated git config to v3 schema (N branches across M stacks)`.

The original command then proceeds normally.

### Idempotency

Every step overwrites unconditionally. A crashed half-migration
converges to the same end state when the next command runs the
migration again. No sentinel key, no `--recover` subcommand.

### Edge cases

- Branch has `stack-name` but the pointed-at `stack.<sn>.*` is missing:
  treat as untracked. Skip writing per-branch keys for it. Print a
  warning.
- `stack.<sn>.*` keys exist but no branch references the name: orphan;
  delete in step 4.
- Sibling branches with different merge-strategy from different legacy
  stacks: each branch gets its own stack's value (no conflict).
- Tombstones (`landed-*` multi-values): dropped silently. The new schema
  has no equivalent; merged branches are no longer remembered.
- Already-migrated repo (no legacy keys): probe returns empty, fast path
  exits in microseconds.

## Affected Files

### Modified

- `src/lib/stack.ts`: drop `stackName` from `StackTree` and related
  types; add `getEffectiveBaseBranch` and `getEffectiveMergeStrategy`;
  drop the `stack-order` auto-migration cleanup branch (the legacy
  migration covers it).
- `src/lib/config.ts`: rewrite every helper that reads or writes
  `stack.<name>.*` to operate on per-branch keys.
- `src/lib/cleanup.ts`: remove tombstone capture and writing helpers;
  simplify the merged-branch preview to "delete + reparent".
- `src/lib/submit-plan.ts`: drop `stackName` field in the plan output;
  add `rootBranch` field.
- `src/lib/colors.ts`: switch to deterministic hash of root branch
  name; drop the per-stack `stack.<sn>.color` config read.
- `src/commands/init.ts`, `import.ts`, `create.ts`: drop `--stack-name`
  flag; write per-branch metadata.
- `src/commands/land.ts`: rewrite `planLand` and `executeLand` to
  reparent children instead of writing tombstones; delete the landed
  branch outright.
- `src/commands/nav.ts`: stop rendering merged branches in nav
  comments.
- `src/commands/restack.ts`: switch resume-state read/write to
  `stacked-prs.resume-state`.
- `src/commands/status.ts`: replace `stackName` with `rootBranch` in
  JSON output and TUI hand-off.
- `src/commands/clean.ts`: drop `stack.<sn>.*` detection from stale
  config logic.
- `src/commands/import-discover.ts`: drop stack-name discovery; emit
  per-branch metadata only.
- `src/tui/state/loader.ts`, `app.tsx`, components: switch from
  `stackName` to `rootBranch` in props and reducer state.
- `src/cli.ts`: drop `--stack-name` from command definitions.
- `skills/stacked-prs/SKILL.md`: rewrite runbook examples; drop
  `--stack-name`; update the scripts table.
- `README.md`: drop "stack name" language; add upgrade note.
- `CLAUDE.md`: update schema table, commands table, tree-model section.

### Added

- `src/lib/migration.ts`: legacy detection, snapshot, validate, write
  new keys, delete old keys. Idempotent; runs from any reader.
- `src/lib/migration.test.ts`: covers the cases in the migration
  edge-cases section.
- `src/lib/colors.test.ts`: deterministic palette index from root
  branch name.

### Tests removed

- All tombstone-related tests in `lib/cleanup.test.ts`, `commands/land.test.ts`, `commands/nav.test.ts`.
- `--stack-name` flag tests in `commands/init.test.ts`, `commands/import.test.ts`, `commands/create.test.ts`.
- Stack-name validation tests in `lib/stack.test.ts`.

### Tests updated

- Every test using `setMockDir` and `gh.ts` fixtures that contained
  `stack-name` references in command output.
- Existing `lib/stack.test.ts` cases that read `stack-name`: rewrite to
  read the new per-branch keys; topology assertions unchanged.

## Release

- Single major version bump to 3.0.0. release-please's existing
  `extra-files` rules bump both `deno.json` and
  `.claude-plugin/plugin.json`.
- Headline commit: `feat!: drop stack-name from data model` with a
  `BREAKING CHANGE:` footer naming the auto-migration as the upgrade
  path.
- SKILL.md updates ride along under the `feat!:` headline (they are
  shipped artifacts per CLAUDE.md commit-type rules).
- Release notes draft surfaces:
  - Removed CLI flags (`--stack-name`).
  - JSON field renames (`stackName` to `rootBranch`).
  - Tombstone removal (merged branches no longer appear in nav
    comments).
  - Mid-stack land support.
  - Auto-migration on first run.

## Out of Scope

- Migrating from git-config storage to `refs/branch-metadata/<n>` blobs
  (Graphite's approach). Storage stays in git config per the user's
  scope direction. This could be a future change but is independent of
  the stack-name removal.
- Renaming commands to match Graphite vocabulary (e.g. `init` to
  `track`). The current command names stay.
- Cross-machine portability of stack metadata. Today's git-config
  storage is local-only; that does not change.
