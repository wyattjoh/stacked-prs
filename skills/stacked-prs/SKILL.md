---
name: stacked-prs
description: >-
  Manages stacked branches and pull requests. Use when working with dependent
  PRs, chained branches, rebasing a branch stack, syncing or submitting
  multiple related PRs, or managing PR base targets. Triggers on "create a
  stack", "stack PRs", "stacked branches", "push to stack", "dependent PRs",
  "chained branches", "rebase my stack", "sync stack", "submit stack",
  "land stack", "import stack", "split branch", "fold branch".
argument-hint: "[init|create|insert|split|fold|move|sync|restack|submit|status|pr|land|import|clean]"
allowed-tools: >-
  Bash(git *), Bash(gh *), Bash(deno run *),
  Read, Grep, Glob, TodoWrite
effort: high
---

# Stacked PRs

Manage stacked branches and pull requests using git config metadata, Deno helper
scripts, and gh CLI.

**Arguments provided**: $ARGUMENTS

**Requires:** git 2.38+ (for `--update-refs`), gh CLI

## Quick Start

1. Create your first branch and commit as usual
2. `/stacked-prs init` to register it as a stack
3. `/stacked-prs create` to add child branches
4. `/stacked-prs submit` to create PRs with correct bases and nav comments
5. `/stacked-prs sync` after rebasing or pulling main
6. `/stacked-prs land` after the bottom PR merges

## Building Review-Ready Stacks

Stacked PRs are reviewed and merged one branch at a time, from the bottom up.
When each PR lands, GitHub runs CI against `main` at that moment. Every branch
must therefore be independently correct: it must compile, pass all tests, and
satisfy any linting/coverage gates on its own, without code that only exists in
an upstack branch.

### The independent-branch rule

Before creating or submitting any branch, confirm it meets both conditions:

1. **Independently buildable.** The code at the tip of this branch would pass CI
   if rebased onto `main` right now, without any upstack branches included.
2. **Scope-complete.** The branch contains every change required for its stated
   purpose. Never leave a feature in a broken or partial state with "will be
   fixed in the next PR" as the plan.

The stack enforces this naturally: as PRs land from the bottom up, each PR's CI
run does not include any upstack code. A branch that only works because of code
in an upstack sibling will block the stack.

### How to draw branch boundaries

Good split points:

- **Preparatory refactors below, new behavior above.** Rename, extract, or
  reorganize in a lower branch so the upper branch's diff is clean and focused.
- **Types or interfaces below, implementations above.** Defining types in a
  lower branch and building against them in a higher branch is a clean, testable
  separation.
- **Tests belong with the code they test.** Never split a feature and its tests
  across branches. A branch that adds code but omits its tests may fail a
  coverage gate when it lands.
- **Feature flags as a boundary tool.** When a feature cannot be split cleanly,
  introduce a flag in a lower branch (gating the new behavior off), implement
  the feature in middle branches, and remove the flag in the top branch. Every
  branch is green because the new code is always behind the flag until the final
  PR flips it on.

Anti-patterns to avoid:

- Leaving failing behavior in a lower branch that a higher branch will "fix
  later". That lower PR will fail CI when it lands.
- Splitting setup and teardown of a single concept across non-adjacent branches.
- Writing a branch that only passes tests because of uncommitted work in the
  working tree.

### Verifying CI health before submitting

Before running `/stacked-prs submit`, verify each branch is clean at its own
tip. The reliable method is a temporary worktree per branch:

```bash
# Verify branch A on its own:
git worktree add /tmp/check-A <branch-A>
cd /tmp/check-A && <your CI command>
git worktree remove /tmp/check-A

# Verify branch B (includes A's commits implicitly since B is stacked on A):
git worktree add /tmp/check-B <branch-B>
cd /tmp/check-B && <your CI command>
git worktree remove /tmp/check-B
```

If any branch fails, fix it before submitting. A stack with a broken lower
branch blocks every upstack PR from landing.

**When helping a user author branches**, proactively flag when proposed changes
would leave a branch in a state that cannot pass CI independently, and suggest
how to restructure the split.

### Commit hygiene within a branch

Reviewers read commits one at a time. Within a branch:

- Keep each commit focused on one logical change.
- Write commit messages that explain _why_, not just _what_.
- Squash exploratory, fixup, or WIP commits with `git rebase -i` before
  submitting.

Stacks limit diff size at the PR level; commits tell the story of _how_ each PR
makes its change.

## Sub-commands

If no argument is provided, assess the current context (branch, dirty state,
stack membership) and suggest the most appropriate action.

### `init`

Start a new stack from the current branch. Backed by `cli.ts init`.

1. Run
   `cli.ts init --dry-run [--stack-name <name>] [--merge-strategy
   merge|squash]`
   to compute the plan (the CLI guards against running on the base branch,
   against a branch already in a stack, and against a stack-name collision).
2. **Present plan:** stack name, merge strategy, base branch, and the exact
   config writes.
3. **Wait for confirmation.**
4. Run `cli.ts init --force [...same flags]` to apply. `--force` skips the CLI's
   own TTY prompt since confirmation is already gated above.

Full invocation:

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts init \
  [--branch <name>] [--stack-name <name>] [--merge-strategy merge|squash] \
  [--base-branch <name>] [--force] [--dry-run] [--json]
```

### `import`

Discover and register an existing chain of branches/PRs as a stack. Backed by
`cli.ts import`, which wraps `import-discover` with a config-write step.

1. Run
   `cli.ts import --dry-run [--stack-name <name>] [--merge-strategy
   merge|squash]`
   to compute the plan (calls `import-discover` under the hood and guards
   against already-in-stack branches + stack-name collisions).
2. **Present plan:** every discovered branch and its parent, the chosen stack
   name and merge strategy, plus any PR-base-mismatch warnings surfaced by the
   discoverer.
3. **Wait for confirmation.**
4. Run `cli.ts import --force [...same flags]` to apply.
5. Offer to run `submit` to add nav comments to the now-imported PRs.

Full invocation:

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts import \
  [--branch <name>] [--stack-name <name>] [--merge-strategy merge|squash] \
  [--owner <owner> --repo <repo>] \
  [--force] [--dry-run] [--json]
```

### `create`

Create a new branch in the stack off the current branch. Backed by
`cli.ts create <branch>`.

**Before invoking**, apply the independent-branch rule from "Building
Review-Ready Stacks": confirm the new branch's intended scope is self-contained
and would not leave the current (parent) branch in a CI-failing state. If the
user's plan would violate the rule, flag it and suggest a better split.

1. Run `cli.ts create <branch> --dry-run [flags]` to compute the plan. The
   output lists the resolved case (child / auto-init / auto-init-worktree) and
   the literal git commands that will run.
2. **Present plan:** show the user the case, resolved parent / stack name /
   merge strategy / worktree path (if any), and the exact commands the execution
   step will run.
3. **Wait for confirmation.**
4. Run `cli.ts create <branch> --force [flags]` to apply. `--force` skips the
   CLI's own TTY prompt since confirmation is already gated above.

The CLI resolves the create case automatically:

- **Child branch**: when the current branch is already in a stack.
- **Auto-init from base**: when the current branch is the repo's default branch.
  A new stack is registered (default name: the new branch name; default merge
  strategy: `squash`, overridable via
  `git config stack.default-merge-strategy`).
- **Auto-init + worktree**: same as auto-init, but the new branch lives in a
  worktree at `<dir>/<branch>` and the current repo stays on the base branch.
  Only valid from the base branch.

Full invocation:

```bash
deno run --allow-run=git,gh --allow-env --allow-read --allow-write \
  ${CLAUDE_PLUGIN_ROOT}/src/cli.ts create <branch> \
  [-m <message>] [--create-worktree <dir>] \
  [--stack-name <name>] [--merge-strategy merge|squash] \
  [--force] [--dry-run] [--json]
```

### `insert`

Insert a new branch between a branch and its parent. Backed by
`cli.ts
insert <new-branch> --child <selected>`.

1. Run `cli.ts status --stack-name=<name> --json` to display the tree and help
   the user pick the child to insert before.
2. Run `cli.ts insert <new-branch> --child <selected> --dry-run` to compute the
   plan (branch created off the child's current parent; child reparented under
   the new branch).
3. **Present plan** and **wait for confirmation.**
4. Run `cli.ts insert <new-branch> --child <selected> --force` to apply.
5. If the user has staged changes they want on the new branch, offer to commit
   them (the CLI itself just creates the branch).
6. Suggest `restack --upstack-from=<new-branch>` once commits exist.

Full invocation:

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts insert <branch> \
  [--stack-name <name>] [--child <name>] [--force] [--dry-run] [--json]
```

### `split`

Split a branch's content into two branches. Backed by `cli.ts split`, which
supports two modes via `--by-commit <sha>` or `--by-file <paths>`.

#### `--by-commit`

Original branch keeps earlier commits; new branch above gets later commits.

1. Run `cli.ts status --stack-name=<name> --json` and
   `git log --oneline <parent>..<current-branch>` to help the user pick the last
   SHA to keep on the original branch.
2. Run
   `cli.ts split --branch <current> --new-branch <upper> --by-commit
   <sha> --dry-run`
   (the CLI guards against single-commit branches, branch-name collisions, and
   splits at the tip).
3. **Present plan:** kept SHAs, moved SHAs, reparented children (original's
   children will be reparented to the new upper branch).
4. **Wait for confirmation.**
5. Run `cli.ts split ... --force` to apply.
6. Suggest `restack --upstack-from=<new-branch>` if the original had children.

#### `--by-file`

Extract files into a new branch inserted **below** the original. This is
inherently lossy with commit history — the CLI collapses the extracted portion
into a single commit on the new lower branch, and the remainder into a single
commit on the original.

1. Run `git diff --name-only <parent>..<current>` to help the user choose the
   file list.
2. Run
   `cli.ts split --branch <current> --new-branch <lower> --by-file
   <f1,f2,...> --extract-message <msg> --remainder-message <msg> --dry-run`.
3. **Present plan:** extracted files, remainder files, parent/child rewiring.
4. **Wait for confirmation.**
5. Run `cli.ts split ... --force`.
6. Suggest `restack --upstack-from=<original-branch>` if the original had
   children.

Full invocation:

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts split \
  [--stack-name <name>] [--branch <name>] --new-branch <name> \
  (--by-commit <sha> | --by-file <f1,f2,...>) \
  [--extract-message <msg>] [--remainder-message <msg>] \
  [--force] [--dry-run] [--json]
```

### `fold`

Merge a branch into its parent. Inverse of split. Backed by `cli.ts fold`.

1. Decide the strategy: `ff` (preserve commits) or `squash` (collapse into a
   single commit on the parent).
2. Run `cli.ts fold --branch <current> --strategy <ff|squash> --dry-run` (the
   CLI guards against folding the only branch, folding a root whose parent is
   the base branch, and against ff when the branch has diverged from its
   parent).
3. **Present plan:** parent, children to reparent, strategy, and the exact
   merge/commit/config/branch-delete commands.
4. **Wait for confirmation.**
5. Run `cli.ts fold ... --force` to apply. The CLI runs the merge, reparents
   children, removes the folded branch's stack metadata, and deletes the branch.
6. Suggest `restack --upstack-from=<parent>` if children were reparented.

Full invocation:

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts fold \
  [--stack-name <name>] [--branch <name>] [--strategy ff|squash] \
  [--message <msg>] [--force] [--dry-run] [--json]
```

### `move`

Detach a branch and reattach it as a child of a different parent. Backed by
`cli.ts move`.

1. Run `cli.ts status --stack-name=<name> --json` and help the user pick the
   branch to move and its new parent.
2. Run `cli.ts move --branch <branch> --new-parent <parent> --dry-run` (the CLI
   guards against no-ops, cycle creation, and non-stack new parents).
3. **Present plan:** the moved branch's old and new parent, any children being
   reparented back to the old parent, and the `git rebase --onto` call.
4. **Wait for confirmation.**
5. Run `cli.ts move ... --force` to apply. On conflict the CLI stops and reports
   `recovery.resolve` / `resume` / `abort` commands (same shape as `restack` /
   `sync`).
6. Suggest `restack --upstack-from=<moved-branch>` for descendants.

Full invocation:

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts move \
  [--stack-name <name>] [--branch <name>] --new-parent <name> \
  [--force] [--dry-run] [--json]
```

### `sync`

Bring every stack in the repo back in line with origin. Mirrors `gt sync`:
applies to **every** stack, not just the one containing the current branch. In
one pass the CLI:

- Fetches every base branch referenced by any stack (for example, `main`).
- Fast-forwards each local base branch when safe, warning and skipping any base
  that has diverged from origin.
- Detects PRs that merged on GitHub, deletes those branches locally, reparents
  their children onto the next surviving ancestor, retargets the children's PR
  bases via `gh`, and updates navigation comments.
- Restacks the surviving branches and force-pushes with `--force-with-lease`.

Backed by `cli.ts sync`, which has three modes:

- `--dry-run`: compute and print the plan without mutating anything.
- No flags: print the plan and prompt `[y/N]` before executing.
- `--force`: execute without the prompt (non-interactive or trusted automation).

Optionally restrict the run to a subset of stacks with `--filter=<globs>`: a
comma-separated list of stack-name globs where any entry starting with `!` is a
negation. A filter with only negations (e.g. `--filter="!di*"`) includes every
stack except those matching the excludes. A filter with any positive glob
narrows to those matches (minus any negations). When the filter matches no
configured stacks, `cli.ts sync` prints `No stacks match --filter=...` and exits
without fetching or prompting. The dry-run plan's `filter` and `filteredOut`
fields surface the active expression and the stack names that were skipped so
Claude can report them to the user.

1. Run `cli.ts sync --dry-run --json [--filter=<globs>]` to inspect the plan.
   Parse the returned `stacks[]` array (each entry has `stackName`,
   `baseBranch`, `rebases[]`, `branchesToPush[]`, `prunes[]`, and `isNoOp`) plus
   top-level `baseFastForwards[]` with
   `{ baseBranch, action: "ff" | "skip-diverged", ... }` entries.
2. **No-op check:** if `plan.isNoOp` is true, report "All stacks are already
   synced with origin" and stop. The CLI still fetches base branches in this
   path so the user's origin refs stay current.
3. For each non-no-op stack, run `cli.ts verify-refs --stack-name=<name>`
   (read-only). If any stack reports duplicate patches or structural drift that
   the per-branch rebase cannot fix, stop and ask the user to resolve manually.
4. Collect every branch with status `planned` across all stacks. Run
   `checkWorktreeSafety` on the union. If any dirty worktrees are returned,
   present them with cleanup commands and stop.
5. **Present the full plan** grouped by section:
   - Base branches to fetch and fast-forward, plus any bases flagged
     `skip-diverged` (call out the warning; the CLI will continue past them).
   - Merged PRs to prune per stack (branch to delete, PR number, children being
     reparented, PR bases to retarget on GitHub).
   - Each stack's rebase list (old-parent to new-target) and branches to
     force-push.
6. **Wait for confirmation.**
7. Run `cli.ts sync --force [--filter=<globs>]` to execute. Forward the same
   `--filter` expression used during planning so execution operates on the same
   stack set. Execution order per stack is: prune merged branches (with PR base
   retargets and nav updates), restack survivors, then
   `git push --force-with-lease`. On the first conflict or push failure it stops
   and reports `failedAt: <stackName>`.
   - If a conflict: resolve the files in the stack that failed, then run
     `cli.ts restack --stack-name=<failed> --resume`. Re-run
     `cli.ts sync [--filter=<globs>]` to finish the remaining stacks.
8. Run `cli.ts verify-refs --stack-name=<name>` per synced stack as a
   post-flight check. If it is not clean on any stack, print the report and ask
   the user to inspect.
9. Report per-stack results: fast-forwarded bases, pruned branches, pushed
   branches.

### `restack`

Rebase the stack tree without fetching or pushing. Useful for local
reorganization before reviewing the diff.

**Flags:** `--upstack-from=<branch>`, `--downstack-from=<branch>`,
`--only=<branch>` (default: full stack)

1. Run `cli.ts verify-refs --stack-name=<name>` (read-only). If it reports
   structural problems, stop. If it reports drift, remember for the plan.
2. Run `cli.ts restack --dry-run --json --stack-name=<name> [flags]`.
3. **No-op check:** if every entry is `skipped-clean` and verify-refs was clean,
   report "Stack is already fully synced" and stop.
4. Collect `planned` branches from the dry-run and run `checkWorktreeSafety`. If
   any dirty worktrees, present and stop.
5. **Present plan** (tree with old-parent to new-target, drift notes if any).
6. **Wait for confirmation.**
7. Run `cli.ts restack --stack-name=<name> [flags]`. On conflict, the rebase
   stops at the first conflicted branch; resolve the files and run
   `git rebase --continue` or `cli.ts restack --stack-name=<name> --resume`.
8. Run `cli.ts verify-refs` (informational only, do not gate; there is no push
   step). If it reports problems, print them so the user can inspect.

### `submit`

Push every stack branch, create or update PRs with correct bases and draft
state, and refresh the stack navigation comments. Mirrors `gt submit`. Backed by
`cli.ts submit`.

**Before running submit**, remind the user to verify each branch is CI-clean at
its own tip (see "Verifying CI health before submitting" in the "Building
Review-Ready Stacks" section). If the user has not yet verified, ask whether
they want to do so before proceeding. A stack with a broken lower branch will
block every upstack PR from landing once it reaches GitHub CI.

**Draft policy:** A PR's draft state is a function of its position in the stack.
PRs whose parent is the stack's base branch (e.g. `main`) are submitted as ready
for review. All other PRs in the stack are kept as drafts so they cannot be
merged out of order. The submit plan reconciles drift on every run via the
`desiredDraft` and `draftAction` fields per branch.

`cli.ts submit` has three modes:

- `--dry-run`: compute and print the plan without mutating anything.
- No flags: print the plan and prompt `[y/N]` before executing.
- `--force`: execute without the prompt.

1. Run `cli.ts submit --dry-run --stack-name=<name>` to inspect the plan. Add
   `--json` to get the raw `SubmitPlan` shape.
2. **No-op check:** if the plan reports `isNoOp: true`, report "All PRs are up
   to date with correct bases, draft state, and nav comments" and stop.
3. **Present full plan:**
   - Git: branches to force-push.
   - GitHub: PRs to create (branches with action "create"; show base + flag
     `--draft` for any branch where `desiredDraft` is true).
   - GitHub: PRs to update base (branches with action "update-base"; show old ->
     new base).
   - GitHub: PRs to flip draft state (branches with `draftAction` of "to-draft"
     or "to-ready"; show the transition and the reason, e.g. "parent is feat/a,
     not main").
   - Comments: nav comments to create/update. Note that the dry-run plan only
     reflects nav actions for PRs that already exist on GitHub. Any branch with
     action `"create"` will also get a nav comment posted after its PR is
     opened, even though the dry-run plan doesn't list it.
4. **Wait for confirmation.**
5. Run `cli.ts submit --force --stack-name=<name>` to execute. The CLI pushes
   with `--force-with-lease`, then creates/edits PRs via `gh pr create|edit`,
   flips draft state via `gh pr ready` / `gh pr ready --undo`, and finally
   rebuilds the nav plan against the live PR set (so freshly-created PRs are
   included) and posts/updates nav comments.
6. Report the PR URLs from the CLI output.

### `pr`

Open the pull request for a branch in the browser. Mirrors `gt pr`. Backed by
`cli.ts pr`. Read-only and needs no confirmation.

- `cli.ts pr` opens the current branch's PR.
- `cli.ts pr --branch <name>` opens the PR for an explicit branch.
- `cli.ts pr --print` prints the URL instead of opening the browser.
- `cli.ts pr --json` returns a structured lookup result.

### `status`

Show current stack state. **No confirmation needed** (read-only).

1. Run `cli.ts status --stack-name=<name>` to get tree output
2. Display formatted (tree shape with box-drawing characters):
   ```
   Stack: auth-rework (squash merge)

     feature/auth              PR #101 (open)      up-to-date
     ├── feature/auth-api      PR #103 (open)      up-to-date
     └── feature/auth-tests    PR #102 (draft)     behind-parent  <- you are here
         └── feature/auth-ui   (no PR)             up-to-date
   ```

#### Interactive view

Run `deno run ... cli.ts status -i` (or `--interactive`) to launch a TUI. The
TUI renders every configured stack as a horizontal left-to-right tree with
per-stack colors, shows PR state and sync status per branch, and provides
arrow-key navigation plus a live commit detail pane for the focused branch.

Key bindings: `?` shows the full list. Press `L` on a branch whose stack is
eligible to land (root PR merged, or every PR merged) to open the land modal,
which plans and executes the full cleanup automatically without requiring
Claude.

### `land`

Handle cleanup after a PR merges. Auto-splits the stack if landing creates
multiple roots.

**Preferred path:** press `L` in the TUI. It plans and executes the full land
automatically. Use the Claude-orchestrated steps below only when the TUI is not
available.

Two supported shapes are handled by `executeLandFromCli` (in
`src/commands/land.ts`):

- **root-merged:** exactly one root PR is merged, no other branch is merged.
  Remaining branches are rebased onto the base branch and force-pushed.
- **all-merged:** every PR in the stack is merged. No rebase or push is needed;
  all branches are deleted and config is removed.

**Claude-orchestrated steps:**

1. Run `cli.ts land --stack-name=<name> --json`
2. If `ok: true`: report landed branches and any splits shown in the output.
3. If `error: "conflict"`:
   - Show the user the `conflictFiles` list and `recovery.resolve` command.
   - After the user resolves conflicts, run `recovery.resume` (the `--resume`
     command).
   - Repeat from step 1 until `ok: true`.
4. If `error: "blocked"`: report the preflight blockers and ask the user to
   resolve them.

Read-only operations (`cli.ts status`, `cli.ts land --dry-run --json`) run
without confirmation. The `cli.ts land` command itself requires no separate
confirmation step -- the plan is built and executed in one call.

### `clean`

Detect and remove stale stack/branch config entries (orphaned branches, missing
parents, empty stacks, stale resume-state, legacy `stack-merged` flags on live
branches).

`clean` also understands `stack.<name>.landed-branches`,
`stack.<name>.landed-pr`, and `stack.<name>.landed-parent`: multi-value keys
that act as the stack-level tombstone list for branches that have been landed
and deleted (the second records the PR number as `<branch>:<number>` so nav
comments can keep showing merged PRs after the branch ref is gone, and the third
records the branch's stack-parent as `<branch>:<parent>` so the tombstone keeps
its structural position in the tree). Entries in any of these keys are expected
and are not stale. A branch with a live stack-name entry whose ref is missing is
ALSO not stale when that branch appears in `landed-branches` - the tombstone's
structural placement is preserved intentionally. The branch-level
`branch.<name>.stack-merged = true` key is the legacy pre-migration form; when
it appears on a live branch with a live `stack-name`, `clean` reports a
`legacy-merged-flag` finding and `--force` removes it. See `CLAUDE.md` for the
full git-config schema.

**Flags:** `--stack-name=<name>`, `--force`, `--json`

1. Run `cli.ts clean [--stack-name=<name>] --json` (read-only, no gate needed)
   to get the structured report.
2. **No-op check:** if `findings` is empty, report "No stale config found" and
   stop.
3. **Present plan:** show each finding with its kind, subject (branch or stack),
   details, and the config keys that would be removed.
4. **Wait for confirmation.**
5. Run `cli.ts clean [--stack-name=<name>] --force` to apply.
6. Report the removed keys.

## Confirmation Gate Rules

**CRITICAL: Never execute any of these without showing the plan first:**

- `git push` (any variant)
- `git rebase`
- `git branch -d`
- `gh pr create`
- `gh pr edit`
- `gh pr ready`
- `gh pr comment`
- `gh api --method PATCH`

**Always allowed without confirmation (read-only):**

- `git status`, `git log`, `git branch --show-current`, `git fetch`
- `gh pr list`, `gh pr view`, `gh repo view`
- `deno run ... cli.ts status`
- `deno run ... cli.ts status --json`
- `deno run ... cli.ts status -i` / `--interactive`
- `deno run ... cli.ts nav --dry-run`
- `deno run ... cli.ts verify-refs`
- `deno run ... cli.ts restack --dry-run` (with or without `--json`)
- `deno run ... cli.ts clean --json` (report-only; `--force` mutates)
- `deno run ... cli.ts create --dry-run` (with or without `--json`)
- `deno run ... cli.ts land --dry-run` (with or without `--json`)
- `deno run ... cli.ts submit --dry-run` (with or without `--json`)
- `deno run ... cli.ts sync --dry-run` (with or without `--json`)
- `deno run ... cli.ts init --dry-run` (with or without `--json`)
- `deno run ... cli.ts import --dry-run` (with or without `--json`)
- `deno run ... cli.ts insert ... --dry-run` (with or without `--json`)
- `deno run ... cli.ts fold ... --dry-run` (with or without `--json`)
- `deno run ... cli.ts move ... --dry-run` (with or without `--json`)
- `deno run ... cli.ts split ... --dry-run` (with or without `--json`)
- `deno run ... cli.ts pr` (read-only PR lookup; also opens the browser, which
  is a local action, not a repo mutation)

**If the plan changes mid-execution** (e.g., rebase conflicts), pause and
re-present the remaining operations before continuing.

## Scripts

All scripts are accessed through a single unified CLI entry point:

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts <subcommand> [flags]
```

`--stack-name` is auto-detected from the current branch's git config when not
provided. `--owner` and `--repo` are auto-detected from `gh repo view` when not
provided.

### `status`

```bash
deno run --allow-run=git,gh,pbcopy,wl-copy,clip.exe --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts status \
  [--stack-name=<name>] [--owner=<owner> --repo=<repo>] [--json] [-i|--interactive] [--theme <theme>]
```

Returns human-readable tree output by default. Pass `--json` for structured JSON
with full stack state. Pass `-i` / `--interactive` to launch the read-only TUI
that renders every stack as a horizontal tree with per-stack colors, PR state,
sync status, and a live commit detail pane. Pass `--theme light` or
`--theme dark` to override auto-detection.

### `restack`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts restack \
  [--stack-name=<name>] \
  [--upstack-from=<branch>] \
  [--downstack-from=<branch>] \
  [--only=<branch>] \
  [--resume] \
  [--dry-run] \
  [--json]
```

Performs per-branch topological rebase of the tree. Walks the tree in DFS order,
snapshots each branch's parent SHA before any mutation, and rebases each branch
individually with an explicit `git rebase --onto` call against the new target
and the snapshotted old-parent SHA. Root branches target `origin/<base-branch>`;
intermediate branches target their parent's current (possibly just-rewritten)
tip. On the first conflicted branch the walk stops and leaves git mid-rebase;
resolve the files and run `git rebase --continue` or re-invoke with `--resume`
to pick up the remaining branches. Pass `--dry-run` to report the plan without
touching git (combine with `--json` for structured output). Pass `--json` for
structured output of an executed run.

### `nav`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts nav \
  [--stack-name=<name>] [--owner=<owner> --repo=<repo>] [--dry-run]
```

Creates or updates stack navigation comments on PRs. Use `--dry-run` to preview
without writing.

### `verify-refs`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts verify-refs \
  [--stack-name=<name>]
```

Verifies all stack branches have correct ancestry after a rebase and detects
duplicate patches across branch ranges (caused by failed `--update-refs`).
Outputs JSON with branch status, repair commands for stale branches, and a
`duplicates` array listing commits whose patch-id appears in multiple branches.
Exits with code 1 if any branches are stale or duplicates are found.

### `create`

```bash
deno run --allow-run=git,gh --allow-env --allow-read --allow-write ${CLAUDE_PLUGIN_ROOT}/src/cli.ts create <branch> \
  [-m <message>] [--create-worktree <dir>] \
  [--stack-name <name>] [--merge-strategy merge|squash] \
  [--force] [--dry-run] [--json]
```

Creates a new branch in the stack off the current branch. Auto-resolves between
child-in-stack, auto-init, and auto-init-with-worktree based on the current
branch's git config. Prints a plan (including the literal git commands that
would run) and prompts on TTY unless `--force` is passed. `--dry-run` reports
the plan without mutating anything.

### `import-discover`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts import-discover \
  [--branch=<name>] [--owner=<owner> --repo=<repo>]
```

Discovers the tree of local branches between the given branch and main, then
annotates each with PR data from GitHub. Returns JSON with the discovered tree,
base branch, and any warnings (e.g., PR base mismatches).

### `submit`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts submit \
  [--stack-name=<name>] [--owner=<owner> --repo=<repo>] \
  [--dry-run] [--force] [--json]
```

Runs the full submit flow: force-pushes branches, creates or edits PRs (with
`--draft` derived from the stack's shape), flips draft state when needed, and
applies the nav comment plan. `--dry-run` prints the plan without mutating
(combine with `--json` for the raw `SubmitPlan` shape: per-branch actions, an
`isNoOp` flag, and nav comment plan); with no flags the CLI prints the plan and
prompts `[y/N]`; `--force` skips the prompt.

### `sync`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts sync \
  [--dry-run] [--force] [--filter=<globs>] [--json]
```

Applies to **every** stack in the repo by default. Fetches each distinct base
branch from origin once, fast-forwards each local base branch when safe (warning
and continuing past any that have diverged), prunes branches whose PRs merged
(deleting the branch locally, reparenting its children, retargeting their PR
bases on GitHub, and refreshing nav comments), then for each surviving stack
runs `restack` and force-pushes with `--force-with-lease`. Stops at the first
conflict or push failure; the returned JSON (`--json`) records
`failedAt: <stackName>` so the caller can resume that stack with
`cli.ts restack --stack-name=<failed> --resume` and then re-run `cli.ts sync`
for the rest. Same three-mode shape as submit: `--dry-run`, interactive default,
`--force`.

Pass `--filter=<globs>` with a comma-separated list of stack-name globs to
restrict the run to a subset of stacks. Entries prefixed with `!` are negations:
`--filter="!di*"` syncs every stack whose name does not match `di*`;
`--filter="feat-*,!feat-draft*"` syncs stacks named `feat-*` except those
matching `feat-draft*`. Only matched stacks' base branches are fetched and
fast-forwarded; skipped stack names appear in `plan.filteredOut`. If the filter
matches nothing, the CLI prints `No stacks match --filter=...` and exits without
fetching.

### `pr`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts pr \
  [--branch=<name>] [--owner=<owner> --repo=<repo>] [--print] [--json]
```

Opens the PR for the current (or specified) branch in the browser via
`gh pr
view --web`. `--print` emits the URL instead. `--json` returns the raw
lookup result (`{ ok, branch, pr?: { number, url, state, isDraft }, error? }`).

### `land`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts land \
  [--stack-name=<name>] [--dry-run] [--json] [--resume]
```

Lands a merged PR and cleans up the stack. Builds the land plan, executes
rebases and force-pushes (root-merged case) or deletes all branches (all-merged
case), and auto-splits the stack when multiple roots result. Pass `--dry-run` to
print the plan without executing. Pass `--json` for structured output. Pass
`--resume` to continue after resolving a rebase conflict. Exits with code 1 on
failure (conflict or blocked).

### `clean`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts clean \
  [--stack-name=<name>] [--force] [--json]
```

Detects four classes of stale git config: orphaned branch entries (config
references a deleted ref), stale stack-parent (parent ref does not exist), empty
stacks (stack metadata with no member branches), and stale resume-state (resume
marker but no rebase in progress). Default: print report and prompt to apply.
Pass `--force` for non-interactive use. Pass `--json` for structured output.

### `init`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts init \
  [--branch <name>] [--stack-name <name>] [--merge-strategy merge|squash] \
  [--base-branch <name>] [--force] [--dry-run] [--json]
```

Initializes the current branch (or `--branch`) as the root of a new stack. The
CLI guards against running on the base branch, against a branch already in a
stack, and against a stack-name collision. Same three-mode shape as submit:
`--dry-run`, interactive default, `--force`.

### `import`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts import \
  [--branch <name>] [--stack-name <name>] [--merge-strategy merge|squash] \
  [--owner <owner> --repo <repo>] [--force] [--dry-run] [--json]
```

Wraps `import-discover` with a config-write step. Flattens the discovered tree
into `(branch, parent)` pairs and writes all four config keys per branch in a
single run. Guards against any discovered branch already being in a stack, and
against stack-name collisions. Warnings from the discovery phase (e.g. PR base
mismatches) are surfaced in the plan.

### `insert`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts insert <branch> \
  [--stack-name <name>] [--child <name>] [--force] [--dry-run] [--json]
```

Creates `<branch>` off the parent of `--child` (default: current branch) and
reparents the child under the new branch. Config-only plus the branch creation;
no rebase happens because the inserted branch starts empty.

### `fold`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts fold \
  [--stack-name <name>] [--branch <name>] [--strategy ff|squash] \
  [--message <msg>] [--force] [--dry-run] [--json]
```

Merges `--branch` (default: current) into its parent, reparents its children
onto the parent, removes the folded branch's stack metadata, and deletes the
branch ref. `--strategy=ff` requires a fast-forward; `--strategy=squash`
collapses the branch into a single commit on the parent.

### `move`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts move \
  [--stack-name <name>] [--branch <name>] --new-parent <name> \
  [--force] [--dry-run] [--json]
```

Reparents `--branch` under `--new-parent`, reparents its direct children back to
its previous parent, and runs
`git rebase --onto <new-parent> <old-parent>
<branch>`. On conflict the CLI
stops and returns recovery commands matching the `restack` / `sync` shape.

### `split`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts split \
  [--stack-name <name>] [--branch <name>] --new-branch <name> \
  (--by-commit <sha> | --by-file <f1,f2,...>) \
  [--extract-message <msg>] [--remainder-message <msg>] \
  [--force] [--dry-run] [--json]
```

Two modes:

- `--by-commit <sha>`: keep commits up to `<sha>` on the original branch, move
  the remaining commits onto a new upper branch, and reparent the original's
  children under the new branch.
- `--by-file <paths>`: extract the listed file changes into a new lower branch
  inserted between the original and its parent. Lossy: each side collapses to a
  single commit with `--extract-message` and `--remainder-message`.

### Config operations

Config operations (set-branch, remove-branch, set-strategy, get, validate,
land-cleanup) are library functions in `src/lib/config.ts`, not CLI subcommands.
They are called internally by the other subcommands and are not invoked
directly. The branch-structure primitives (`configInsertBranch`,
`configFoldBranch`, `configMoveBranch`, `configSplitStack`) are the underlying
config mutations used by `insert`, `fold`, `move`, and the auto-split path of
`land`.

## References

- [Workflows and usage guide](references/workflows.md) for end-to-end recipes
  combining CLI commands and Claude-orchestrated skill flows. Surface this when
  a user asks "how do I use this?" or wants a worked example.
- [Git commands reference](references/git-commands.md) for rebase, --onto,
  conflict resolution, and edge cases
