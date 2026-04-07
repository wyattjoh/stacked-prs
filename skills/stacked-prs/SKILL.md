---
name: stacked-prs
description: >-
  Manages stacked branches and pull requests. Use when working with dependent
  PRs, chained branches, rebasing a branch stack, syncing or submitting
  multiple related PRs, or managing PR base targets. Triggers on "create a
  stack", "stack PRs", "stacked branches", "push to stack", "dependent PRs",
  "chained branches", "rebase my stack", "sync stack", "submit stack",
  "land stack", "import stack", "split branch", "fold branch".
argument-hint: "[init|create|insert|split|fold|move|sync|restack|submit|status|land|import|help]"
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
6. Write git config via `stack.ts`:
   - `branch.<name>.stack-name = <stack-name>`
   - `branch.<name>.stack-parent = main`
   - `stack.<stack-name>.merge-strategy = <strategy>`
   - `stack.<stack-name>.base-branch = main`
7. Report stack created

### `import`

Discover and register an existing chain of branches/PRs as a stack.

1. **Guard:** check if current branch already has stack metadata
   (`git config branch.<name>.stack-name`). If it does, report "Branch is
   already part of stack '<name>'" and suggest `status` instead
2. Run `import-discover.ts [--branch=<name>] [--owner=<owner> --repo=<repo>]`
3. **Guard:** if `branches` array is empty, report "No branch chain found
   between this branch and main" and stop
4. If there are `warnings` (e.g., PR base mismatches), present them to the user
   for awareness
5. Present discovered tree for confirmation
6. Ask for stack name and merge strategy
7. **Present plan** (all config writes + optional nav updates) and **confirm**
8. Write git config for all branches via `config.ts`:
   - For each branch:
     `config.ts set-branch --branch=<name> --stack=<stack> --parent=<parent>`
   - `config.ts set-strategy --stack=<stack> --strategy=<strategy>`
9. Offer to run `submit` to add nav comments to existing PRs

### `create`

Create a new child branch off the current branch.

1. Verify current branch is in a stack
2. Ask for new branch name
3. **Present plan** (branch creation, config writes) and **confirm**
4. `git checkout -b <new-branch>` from current branch
5. Write git config via `stack.ts`:
   - `branch.<new-branch>.stack-name = <stack-name>`
   - `branch.<new-branch>.stack-parent = <current-branch>`
6. If staged changes exist, offer to commit them

### `insert`

Insert a new branch between a branch and its parent.

1. Run `status.ts --json` to read the stack tree
2. Display the tree, ask which branch to insert before (the new branch will
   become a child of that branch's current parent, and the selected branch gets
   reparented to the new branch) and ask for the new branch name
3. **Present plan:**
   - New branch created from the parent of the selected branch
   - Selected branch gets reparented to the new branch
4. **Wait for confirmation**
5. `git checkout -b <new-branch> <parent-of-selected>`
6. Run
   `config.ts insert-branch --stack=<name> --branch=<new-branch>
   --child=<selected-branch> --parent=<parent-of-selected>`
7. If staged changes exist, offer to commit them
8. Suggest `sync --upstack-from=<new-branch>` after committing work to align git
   history

### `split`

Split a branch's content into two branches.

#### `--by-commit`

Original branch keeps earlier commits; new branch above gets later commits.

1. Run `status.ts --json`, identify current branch
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
11. Run `config.ts insert-branch` to register above original
12. Suggest `sync --upstack-from=<new-branch>` if there are children

#### `--by-file`

Extract files matching a pathspec into a new branch inserted **below** the
original. Note: this is inherently lossy with commit history. Ask user for new
commit messages.

1. Run `status.ts --json`, identify current branch
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
13. Run `config.ts insert-branch` to register below original
14. Suggest `sync --upstack-from=<original-branch>` if needed

### `fold`

Merge a branch into its parent. Inverse of split.

1. Run `status.ts --json`, identify current branch
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
9. Run `config.ts fold-branch --stack=<name> --branch=<folded-branch>`
10. `git branch -d <folded-branch>`
11. Suggest `sync --upstack-from=<parent-branch>` if there were children

### `move`

Detach a branch and reattach it as a child of a different parent.

1. Run `status.ts --json`, display the tree
2. Ask which branch to move and which branch to use as the new parent
3. **No-op check:** if the branch's current parent already equals the target
   parent, report "Branch is already a child of <target-parent>" and stop
4. **Present plan:**
   - Branch detaches (its children reparent to its former parent)
   - Branch reattaches as a child of the new parent
5. **Wait for confirmation**
6. Run `config.ts move-branch --stack=<name> --branch=<X> --new-parent=<Y>`
7. `git rebase --onto <new-parent> <old-parent> <moved-branch>`
8. Suggest `sync --upstack-from=<moved-branch>` for descendants

### `sync`

Fetch main, rebase the stack tree, then push to remote.

**Flags:** `--upstack-from=<branch>`, `--downstack-from=<branch>`,
`--only=<branch>` (default: full stack)

1. `git fetch origin main:main` (read-only, no gate needed)
2. **No-op check:** if all branches are already up-to-date (run
   `restack.ts --json` to check), report "Stack is already fully synced with
   main" and stop
3. **Present plan:**
   - Branches to rebase (shown as tree)
   - Branches to force-push
4. **Wait for confirmation**
5. Run `restack.ts --stack-name=<name> [flags]`
   - If conflicts: pause, help resolve, run `restack.ts --resume`
6. `git push --force-with-lease origin <all-affected-branches>`
7. Report result

### `restack`

Rebase the stack tree without fetching or pushing. Useful for local
reorganization before reviewing the diff.

**Flags:** `--upstack-from=<branch>`, `--downstack-from=<branch>`,
`--only=<branch>` (default: full stack)

1. Read the stack via `status.ts --json`
2. **No-op check:** run `restack.ts --json` to check sync status. If all
   branches are up-to-date, report "Stack is already fully synced" and stop
3. **Present plan:**
   - Branches to rebase (shown as tree)
   - No push step
4. **Wait for confirmation**
5. Run `restack.ts --stack-name=<name> [flags]`
   - If conflicts: pause, help resolve, run `restack.ts --resume`
6. Report result

### `submit`

Create or update PRs for all branches, add/update stack navigation comments.

**Draft policy:** A PR's draft state is a function of its position in the stack.
PRs whose parent is the stack's base branch (e.g. `main`) are submitted as ready
for review. All other PRs in the stack are kept as drafts so they cannot be
merged out of order. The submit plan reconciles drift on every run via the
`desiredDraft` and `draftAction` fields per branch.

1. Determine repo owner/name from `gh repo view --json owner,name`
2. Run `submit-plan.ts --stack-name=<name> --owner=<owner> --repo=<repo>`
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
8. Execute nav plan via `nav.ts`
9. Report all PR URLs

### `status`

Show current stack state. **No confirmation needed** (read-only).

1. Run `status.ts --stack-name=<name>` to get tree output
2. Display formatted (tree shape with box-drawing characters):
   ```
   Stack: auth-rework (squash merge)

     feature/auth              PR #101 (open)      up-to-date
     ├── feature/auth-api      PR #103 (open)      up-to-date
     └── feature/auth-tests    PR #102 (draft)     behind-parent  <- you are here
         └── feature/auth-ui   (no PR)             up-to-date
   ```

#### Interactive view

Run `deno run ... cli.ts status -i` (or `--interactive`) to launch a read-only
TUI. The TUI renders every configured stack as a horizontal left-to-right tree
with per-stack colors, shows PR state and sync status per branch, and provides
arrow-key navigation plus a live commit detail pane for the focused branch. The
TUI never writes to the repo or GitHub, so it does not require confirmation
gates.

Key bindings: `?` shows the full list.

### `land`

Handle cleanup after a PR merges. Auto-splits the stack if landing creates
multiple roots.

1. Read the stack via `status.ts --json`
2. Identify merged branch (bottom of stack, or ask if ambiguous)
3. **No-op check:** if no branch has a merged PR (all PRs are open/draft or
   missing), report "No merged PRs found, nothing to land" and stop
4. `git fetch origin`
5. Determine repo owner/name from `gh repo view --json owner,name`
6. Run `nav.ts --dry-run` to preview comment changes
7. **Present full cleanup plan:**
   - Git: rebase strategy (merge vs squash --onto), branches to force-push
   - Git: branch to delete locally
   - GitHub: PR base retargets
   - Comments: nav comment updates (show new content)
   - Stack split: if landing creates multiple roots, show new stacks
8. **Wait for confirmation**
9. Reparent children of the merged branch to the merged branch's parent
10. Execute rebase:
    - Merge strategy: `git rebase origin/main --update-refs` from topmost
    - Squash strategy:
      `git rebase --onto origin/main <merged-branch> <next-branch> --update-refs`
11. Run `config.ts land-cleanup --stack=<name> --merged=<branch>`
    - If this creates multiple roots, `land-cleanup` calls `split-stack`
      automatically. Report each new stack with tree output.
12. `git push --force-with-lease origin <remaining-branches>`
13. `gh pr edit <next-pr> --base main` then `gh pr ready <next-pr>` (the next PR
    now targets the base branch and must leave draft state per the submit draft
    policy)
14. Execute nav plan via `nav.ts`
15. `git branch -d <merged-branch>`

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
- `deno run ... cli.ts restack --json`

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
  [--json]
```

Performs segment-based rebase of the tree. Decomposes the tree into linear
segments, sorts them topologically, and rebases each with `--update-refs`.
Independent sibling segments continue even when one fails. Pass `--resume` after
resolving conflicts to continue from where it left off. Pass `--json` for
structured output (used by `sync` and `restack` sub-commands).

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

### Config operations

Config operations (set-branch, remove-branch, set-strategy, get, validate,
land-cleanup, insert-branch, fold-branch, move-branch, split-stack) are library
functions in `src/commands/config.ts`, not CLI subcommands. They are called
internally by the other subcommands and are not invoked directly.

## References

- [Git commands reference](references/git-commands.md) for rebase, --onto,
  conflict resolution, and edge cases
