---
name: stacked-prs
description: >-
  Manages stacked branches and pull requests. Use when working with dependent
  PRs, chained branches, rebasing a branch stack, syncing or submitting
  multiple related PRs, or managing PR base targets. Triggers on "create a
  stack", "stack PRs", "stacked branches", "push to stack", "dependent PRs",
  "chained branches", "rebase my stack", "sync stack", "submit stack",
  "land stack", "import stack", "split branch", "fold branch".
argument-hint: "[init|create|insert|split|fold|move|sync|restack|submit|status|land|import|clean|help]"
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

Start a new stack from the current branch.

1. Verify current branch is not `main`/`master`
2. **Guard:** check if current branch already has stack metadata
   (`git config branch.<name>.stack-name`). If it does, report "Branch is
   already part of stack '<name>'" and suggest `status` instead
3. Ask for stack name (default: current branch name)
4. Ask for merge strategy: "merge" (recommended for stacks) or "squash"
5. **Present plan** (config entries to write) and **wait for confirmation**
6. Write git config:
   - `git config branch.<name>.stack-name <stack-name>`
   - `git config branch.<name>.stack-parent main`
   - `git config stack.<stack-name>.merge-strategy <strategy>`
   - `git config stack.<stack-name>.base-branch main`
7. Report stack created

### `import`

Discover and register an existing chain of branches/PRs as a stack.

1. **Guard:** check if current branch already has stack metadata
   (`git config branch.<name>.stack-name`). If it does, report "Branch is
   already part of stack '<name>'" and suggest `status` instead
2. Run
   `cli.ts import-discover [--branch=<name>] [--owner=<owner> --repo=<repo>]`
3. **Guard:** if `branches` array is empty, report "No branch chain found
   between this branch and main" and stop
4. If there are `warnings` (e.g., PR base mismatches), present them to the user
   for awareness
5. Present discovered tree for confirmation
6. Ask for stack name and merge strategy
7. **Present plan** (all config writes + optional nav updates) and **confirm**
8. Write git config for all branches:
   - For each branch: `git config branch.<name>.stack-name <stack>`
     `git config branch.<name>.stack-parent <parent>`
   - `git config stack.<stack>.merge-strategy <strategy>`
   - `git config stack.<stack>.base-branch <base-branch>`
9. Offer to run `submit` to add nav comments to existing PRs

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
  strategy: `merge`).
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

Insert a new branch between a branch and its parent.

1. Run `cli.ts status --stack-name=<name> --json` to read the stack tree
2. Display the tree, ask which branch to insert before (the new branch will
   become a child of that branch's current parent, and the selected branch gets
   reparented to the new branch) and ask for the new branch name
3. **Present plan:**
   - New branch created from the parent of the selected branch
   - Selected branch gets reparented to the new branch
4. **Wait for confirmation**
5. `git checkout -b <new-branch> <parent-of-selected>`
6. Write git config to insert the branch:
   - `git config branch.<new-branch>.stack-name <stack>`
   - `git config branch.<new-branch>.stack-parent <parent-of-selected>`
   - `git config branch.<selected-branch>.stack-parent <new-branch>`
7. If staged changes exist, offer to commit them
8. Suggest `sync --upstack-from=<new-branch>` after committing work to align git
   history

### `split`

Split a branch's content into two branches.

#### `--by-commit`

Original branch keeps earlier commits; new branch above gets later commits.

1. Run `cli.ts status --stack-name=<name> --json`, identify current branch
2. Run `git log --oneline <parent>..<current-branch>` to list commits
3. **Guard:** if there is only one commit, report "Branch has only one commit,
   nothing to split" and stop
4. Display numbered commit list (oldest first), ask: "Split after which commit?"
5. Ask for new branch name (for the upper portion)
6. **Present plan:**
   - Original branch keeps commits 1..N
   - New branch gets commits N+1..end
   - New branch inserted above original; original's children stay with original
7. **Wait for confirmation**
8. Save current tip: `tip=$(git rev-parse HEAD)`
9. Reset original branch: `git reset --hard <commit-N>`
10. Create new branch: `git checkout -b <new-branch> <tip>`
11. Write git config to register new-branch above original:
    - `git config branch.<new-branch>.stack-name <stack>`
    - `git config branch.<new-branch>.stack-parent <original-branch>`
    - Reparent each child of original-branch:
      `git config branch.<child>.stack-parent <new-branch>`
12. Suggest `sync --upstack-from=<new-branch>` if there are children

#### `--by-file`

Extract files matching a pathspec into a new branch inserted **below** the
original. Note: this is inherently lossy with commit history. Ask user for new
commit messages.

1. Run `cli.ts status --stack-name=<name> --json`, identify current branch
2. Run `git diff --name-only <parent>..<current-branch>` to list changed files
3. **Guard:** if no changed files are found, report "Branch has no file changes
   relative to its parent" and stop
4. Ask for pathspec or file list to extract
5. Ask for new branch name (goes below the original)
6. **Present plan:**
   - New branch (below) gets only matched file changes
   - Original branch keeps everything else
   - New branch inserted before the original (between original and its parent)
7. **Wait for confirmation**
8. Checkout parent: `git checkout <parent-branch>`
9. Create extraction branch: `git checkout -b <new-branch>`
10. `git checkout <original-branch> -- <matched-files>` then commit
11. Back on original: `git checkout <original-branch>`
12. `git reset --soft <parent>` then re-commit excluding extracted files
13. Write git config to register new-branch below original (between original and
    its parent):
    - `git config branch.<new-branch>.stack-name <stack>`
    - `git config branch.<new-branch>.stack-parent <parent-of-original>`
    - `git config branch.<original-branch>.stack-parent <new-branch>`
14. Suggest `sync --upstack-from=<original-branch>` if needed

### `fold`

Merge a branch into its parent. Inverse of split.

1. Run `cli.ts status --stack-name=<name> --json`, identify current branch
2. **Guard:** if the stack has only one branch, report "Cannot fold the only
   branch in the stack" and stop
3. Verify parent is a stack member (not the base branch)
4. **Present plan:**
   - Commits from current branch appended to parent
   - Children of current branch reparented to parent
   - Current branch removed from stack and deleted
5. **Wait for confirmation**
6. Identify parent and children of current branch
7. `git checkout <parent-branch>`
8. Ask user: preserve individual commits or squash?
   - FF: `git merge --ff-only <current-branch>`
   - Squash: `git merge --squash <current-branch> && git commit`
9. Write git config to fold the branch:
   - For each child of the folded branch:
     `git config branch.<child>.stack-parent <parent-branch>`
   - `git config --unset branch.<folded-branch>.stack-name`
   - `git config --unset branch.<folded-branch>.stack-parent`
10. `git branch -d <folded-branch>`
11. Suggest `sync --upstack-from=<parent-branch>` if there were children

### `move`

Detach a branch and reattach it as a child of a different parent.

1. Run `cli.ts status --stack-name=<name> --json`, display the tree
2. Ask which branch to move and which branch to use as the new parent
3. **No-op check:** if the branch's current parent already equals the target
   parent, report "Branch is already a child of <target-parent>" and stop
4. **Present plan:**
   - Branch detaches (its children reparent to its former parent)
   - Branch reattaches as a child of the new parent
5. **Wait for confirmation**
6. Write git config to move the branch:
   - For each child of the moved branch:
     `git config branch.<child>.stack-parent <old-parent>`
   - `git config branch.<moved-branch>.stack-parent <new-parent>`
7. `git rebase --onto <new-parent> <old-parent> <moved-branch>`
8. Suggest `sync --upstack-from=<moved-branch>` for descendants

### `sync`

Fetch origin base, pre-flight verify-refs, dry-run plan, worktree safety check,
plan, confirm, rebase, post-flight verify-refs, push.

**Flags:** `--upstack-from=<branch>`, `--downstack-from=<branch>`,
`--only=<branch>` (default: full stack)

1. `git fetch origin <base-branch>` (no refspec; local base is never updated).
   If fetch fails (offline, auth), stop with the error.
2. Run `cli.ts verify-refs --stack-name=<name>` (read-only). Parse the JSON:
   - If it reports duplicate patches on unrelated branches or other structural
     problems the per-branch rebase cannot fix, stop and show the report. Tell
     the user to resolve manually.
   - If it reports drift (a parent that is not an ancestor of a child), remember
     the findings for the plan presentation. Do not stop.
   - If clean, continue.
3. Run `cli.ts restack --dry-run --json --stack-name=<name> [flags]`. Parse the
   `rebases` array.
4. **No-op check:** if every entry has status `skipped-clean` AND pre-flight
   `verify-refs` was clean, report "Stack is already fully synced with
   origin/<base-branch>" and stop.
5. Collect branches with status `planned` from the dry-run. Run the worktree
   safety check (library function `checkWorktreeSafety`). If any dirty worktrees
   are returned, present the list with cleanup commands
   (`git -C <path> stash push -u` or manual commit) and stop. No mutation.
6. **Present the full plan:**
   - Base: rebasing against `origin/<base-branch>`.
   - Drift notes from pre-flight `verify-refs`, if any (e.g. "propagating
     previously-unpropagated commits from <branch> into descendants").
   - Per-branch rebase list as a tree, showing old-parent to new-target.
   - Branches to force-push.
7. **Wait for confirmation.**
8. Run `cli.ts restack --stack-name=<name> [flags]`.
   - If conflicts: the rebase stops at the first conflicted branch and leaves
     git mid-rebase. Pause, help the user resolve the files, then run
     `git rebase --continue` (or re-invoke `cli.ts restack` with `--resume` to
     pick up the remaining branches).
9. Run `cli.ts verify-refs --stack-name=<name>` (post-flight). If it is not
   clean, **abort the push**, print the report, and tell the user to inspect. Do
   not roll back automatically.
10. `git push --force-with-lease origin <rebased-branches>`.
11. Report result.

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

Create or update PRs for all branches, add/update stack navigation comments.

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

1. Determine repo owner/name from `gh repo view --json owner,name`
2. Run `cli.ts submit-plan --stack-name=<name> --owner=<owner> --repo=<repo>`
3. **No-op check:** if `isNoOp` is true, report "All PRs are up to date with
   correct bases, draft state, and nav comments" and stop
4. **Present full plan:**
   - Git: branches to push
   - GitHub: PRs to create (branches with action "create"; show base + suggest
     title; flag `--draft` for any branch where `desiredDraft` is true)
   - GitHub: PRs to update base (branches with action "update-base"; show old ->
     new base)
   - GitHub: PRs to flip draft state (branches with `draftAction` of "to-draft"
     or "to-ready"; show the transition and the reason, e.g. "parent is feat/a,
     not main")
   - Comments: nav comments to create/update (from navComments array)
5. **Wait for confirmation**
6. `git push --force-with-lease origin <all-branches>`
7. Create/update PRs:
   - For action "create": run `gh pr create --base <parent> ...`. Pass `--draft`
     when `desiredDraft` is true (i.e., parent is not the stack's base branch)
   - For action "update-base": run `gh pr edit <num> --base <new-parent>`
   - For draftAction "to-draft": run `gh pr ready <num> --undo`
   - For draftAction "to-ready": run `gh pr ready <num>`
8. Execute nav plan via `cli.ts nav --stack-name=<name>`
9. Report all PR URLs

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

`clean` also understands `stack.<name>.landed-branches` and
`stack.<name>.landed-pr`: multi-value keys that act as the stack-level tombstone
list for branches that have been landed and deleted (the latter records the PR
number as `<branch>:<number>` so nav comments can keep showing merged PRs after
the branch ref is gone). Entries there are expected and are not stale. The
branch-level `branch.<name>.stack-merged = true` key is the legacy pre-migration
form; when it appears on a live branch with a live `stack-name`, `clean` reports
a `legacy-merged-flag` finding and `--force` removes it. See `CLAUDE.md` for the
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

### `help`

Display available commands with ASCII diagrams.

**No confirmation needed** (read-only).

Without arguments, print the full command list:

```
Stacked PRs - Manage tree-shaped branch stacks

LIFECYCLE

  init - Start a new stack from the current branch

    Before:                    After:
    main - A                   main - A (stack: my-stack)

  create - Create a new child branch off the current branch

    Before:                    After:
    main - A                   main - A
                                      └── B

  import - Discover and register an existing branch chain

    Before:                    After:
    main - A - B               main - A - B (stack: imported)
         └- C                       └- C

STRUCTURE

  insert - Insert a new branch between a branch and its parent

    Before:                    After:
    main - A - B               main - A - NEW - B

  split --by-commit - New branch gets later commits

    Before:                    After:
    main - A[1,2,3]            main - A[1,2] - B[3]

  split --by-file - Extract files into a new branch below

    Before:                    After:
    main - A{x,y}              main - NEW{x} - A{y}

  fold - Merge a branch into its parent

    Before:                    After:
    main - A - B - C           main - AB - C

  move - Detach a branch and reattach under a different parent

    Before:                    After:
    main - A - B               main - A
              └- C                    ├- B
                                      └- C

SYNC

  restack - Rebase the stack tree (no fetch, no push)

    Before:                    After:
    main* - A - B              main* - A' - B'
    (* = has new commits)

  sync - Fetch main, restack, then push

    Before:                    After:
    origin/main* - A - B      origin/main* - A' - B' (pushed)

    Flags: --upstack-from, --downstack-from, --only

REVIEW

  status - Show the current stack tree with PR and sync info

    Output:
    feature/auth              PR #101 (open)     up-to-date
    ├── feature/auth-api      PR #103 (open)     up-to-date
    └── feature/auth-tests    PR #102 (draft)    behind-parent
        └── feature/auth-ui   (no PR)            up-to-date

  submit - Create/update PRs and navigation comments

    Creates PRs with correct base branches and adds tree-shaped
    navigation comments to each PR.

LANDING

  land - Clean up after a merged PR, auto-split if tree forks

    Before:                    After (auto-split):
    main - A - B               Stack: B          Stack: C
              └- C               B                 C
          (A merged)

  help - Show this help (or help <command> for details)
```

With a command name (`/stacked-prs help create`), print detailed help for that
command.

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
  [--stack-name=<name>] [--owner=<owner> --repo=<repo>] [--json] [-i|--interactive]
```

Returns human-readable tree output by default. Pass `--json` for structured JSON
with full stack state. Pass `-i` / `--interactive` to launch the read-only TUI
that renders every stack as a horizontal tree with per-stack colors, PR state,
sync status, and a live commit detail pane.

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

### `submit-plan`

```bash
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts submit-plan \
  [--stack-name=<name>] [--owner=<owner> --repo=<repo>]
```

Computes the full submit plan for a stack: which PRs need creating, which need
base updates, and what nav comment changes are needed. Iterates nodes in DFS
order. Returns JSON with per-branch actions and an `isNoOp` flag.

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

### Config operations

Config operations (set-branch, remove-branch, set-strategy, get, validate,
land-cleanup, insert-branch, fold-branch, move-branch, split-stack) are library
functions in `src/commands/config.ts`, not CLI subcommands. They are called
internally by the other subcommands and are not invoked directly.

## References

- [Git commands reference](references/git-commands.md) for rebase, --onto,
  conflict resolution, and edge cases
