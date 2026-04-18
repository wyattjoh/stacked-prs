---
name: release
description: >-
  Finishes a stacked-prs release after pushing to main. Runs the full
  post-push chain: watches origin CI for the push, merges the
  release-please PR in this repo, watches the tag-cut Release workflow,
  then merges the version-bump PR and the subsequent release-please PR
  in wyattjoh/claude-code-marketplace (using --admin because branch
  protection blocks otherwise), confirming CI at each step. Triggers on
  "/release", "finish the release", "ship this release", "run the
  release chain", "merge the release PR and follow through".
allowed-tools: Bash(gh:*), Bash(git:*), Read
argument-hint: "[--dry-run]"
disable-model-invocation: true
---

# Release

Automates the two-repo release pipeline for this plugin.

Two repositories are in the chain:

1. `wyattjoh/stacked-prs` (this repo): release-please gates the version bump and
   tags the release.
2. `wyattjoh/claude-code-marketplace`: updated by the `update-marketplace` job,
   which opens a `feat(stacked-prs): bump to X.Y.Z` PR; release-please then tags
   the marketplace release.

A full release fires up to four Release workflow runs:

- **Run A**: your feature commit on main. `update-marketplace` is skipped (no
  tag yet). release-please opens/updates a release PR.
- **Run B**: release-please PR merges. The tag is cut, the GitHub Release is
  published, Homebrew formula updates, and `update-marketplace` opens a bump PR
  in the marketplace repo.
- **Run C (marketplace)**: bump PR merges. release-please opens a release-please
  PR in the marketplace repo.
- **Run D (marketplace)**: marketplace release-please PR merges. Tags the
  marketplace release.

## Pre-flight

Verify before starting:

- `git branch --show-current` is `main`.
- `git status --porcelain` is empty.
- `git fetch origin main` then `git rev-list --count HEAD..origin/main` is `0`
  (you are at least as new as origin; force-pushes by release-please are OK on
  its own branch).
- `gh auth status` is authenticated for both repos.

Stop and report if any precheck fails.

## Step 1: Watch Run A (feature commit CI)

Resolve the run triggered by your push, then watch it:

```bash
SHA=$(git rev-parse HEAD)
RUN_A=$(gh run list --branch main --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_A" --exit-status
```

Abort the whole skill on failure. No merge attempts while CI is red.

## Step 2: Merge the release-please PR in this repo

```bash
gh pr list --state open \
  --head 'release-please--branches--main--components--stacked-prs' \
  --json number,title,mergeable,mergeStateStatus
```

- **No PR:** the push was a non-release commit (docs/style/chore). Report "CI
  green, no release PR open. Done." and exit.
- **`mergeable != "MERGEABLE"`:** stop and report `mergeStateStatus`. The user
  must resolve manually.
- **`mergeable == "MERGEABLE"`:** merge with squash. `--auto` is a safe default
  in case branch protection is ever added:

  ```bash
  gh pr merge "$PR_A" --squash --auto
  ```

  Capture the merge commit for Step 3:

  ```bash
  MERGE_A=$(gh pr view "$PR_A" --json mergeCommit --jq '.mergeCommit.oid')
  ```

## Step 3: Watch Run B (tag-cut)

```bash
RUN_B=$(gh run list --branch main --commit "$MERGE_A" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_B" --exit-status
```

Confirm the marketplace dispatch succeeded:

```bash
gh run view "$RUN_B" --json jobs \
  --jq '.jobs[] | select(.name=="update-marketplace") | .conclusion'
```

Must be `success`. If it is `skipped`, release-please did not actually tag a
release on this run. Stop and investigate (usually means the release PR that
merged was already on an older tag).

## Step 4: Merge the marketplace bump PR

```bash
gh pr list --repo wyattjoh/claude-code-marketplace --state open \
  --head 'update/stacked-prs' \
  --json number,title,mergeable,mergeStateStatus
```

- Title should match the version release-please cut (e.g.
  `feat(stacked-prs): bump to 2.2.0`). Sanity-check it matches the new
  `.claude-plugin/plugin.json` version.
- `mergeStateStatus` is typically `BLOCKED`. The marketplace repo does not run
  checks on feature branches, and branch protection requires either a review or
  admin bypass. Admin-merge:

  ```bash
  gh pr merge "$PR_B" --repo wyattjoh/claude-code-marketplace --squash --admin
  MERGE_B=$(gh pr view "$PR_B" --repo wyattjoh/claude-code-marketplace --json mergeCommit --jq '.mergeCommit.oid')
  ```

## Step 5: Watch Run C (marketplace bump CI)

```bash
RUN_C=$(gh run list --repo wyattjoh/claude-code-marketplace --branch main --commit "$MERGE_B" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_C" --repo wyattjoh/claude-code-marketplace --exit-status
```

Abort on failure.

## Step 6: Merge the marketplace release-please PR

```bash
gh pr list --repo wyattjoh/claude-code-marketplace --state open \
  --head 'release-please--branches--main' \
  --json number,title,mergeable,mergeStateStatus
```

Admin-merge (same BLOCKED state as Step 4):

```bash
gh pr merge "$PR_C" --repo wyattjoh/claude-code-marketplace --squash --admin
MERGE_C=$(gh pr view "$PR_C" --repo wyattjoh/claude-code-marketplace --json mergeCommit --jq '.mergeCommit.oid')
```

## Step 7: Watch Run D (marketplace tag-cut)

```bash
RUN_D=$(gh run list --repo wyattjoh/claude-code-marketplace --branch main --commit "$MERGE_C" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_D" --repo wyattjoh/claude-code-marketplace --exit-status
```

## Final report

Print:

- The new stacked-prs version (from `.claude-plugin/plugin.json` or the tag).
- The PR numbers merged: `$PR_A` in this repo, `$PR_B` and `$PR_C` in the
  marketplace repo.
- Links to Run B and Run D (the two tag-cut runs).

## Dry-run

With `--dry-run`, execute every read (run lookups, PR discovery, watches) but
skip every `gh pr merge` call. Print what would be merged at each step. This is
safe to run at any time to audit the release state.

## Idempotency

The skill is safe to re-run. Each step checks current state:

- Run already completed successfully: skip the watch.
- PR already merged (no open PR at the expected head branch): skip the merge,
  advance to the next watch.
- PR not yet open: wait a few seconds and retry; if still absent after one
  retry, stop with an actionable message (usually means release-please hasn't
  run yet).

## Failure modes

- **Run fails:** stop. Fix the cause and re-push; re-run the skill.
- **`mergeable` is not `MERGEABLE`:** print `mergeStateStatus` and stop. Typical
  causes: conflicts, missing required review. Resolve manually.
- **Marketplace `update-marketplace` job failed or was skipped when expected:**
  check that `MARKETPLACE_PAT` (stored at
  `op://Development/stacked-prs-marketplace/secret`) is valid and that the
  Release workflow's `update-marketplace` job condition (typically
  `if: needs.release-please.outputs.release_created`) evaluated true.
- **Another push landed between steps:** the `--commit <sha>` filter on
  `gh run list` isolates the runs this skill cares about, so foreign runs are
  ignored. If a foreign push invalidated the release PR, stop and let the user
  re-run after release-please re-opens.
