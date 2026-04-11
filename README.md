# stacked-prs

A Claude Code plugin for managing stacked branches and pull requests. Instead of
a standalone CLI, this plugin works _through_ Claude: you issue natural language
requests or `/stacked-prs <subcommand>`, and Claude orchestrates git, gh, and
Deno helper scripts on your behalf.

## Installation

### Homebrew (standalone CLI)

Install the `stacked-prs` binary for direct terminal use (no Deno required):

```
brew tap wyattjoh/stable
brew install stacked-prs
```

After install, `stacked-prs` is in your PATH. Run the interactive TUI with:

```
stacked-prs status -i
```

> The Homebrew binary gives you direct CLI access. For the AI-orchestrated
> workflow (Claude plans and confirms every write operation), use the Claude
> Code plugin path below.

### Claude Code plugin

This is a Claude Code plugin distributed through the
[wyattjoh/claude-code-marketplace](https://github.com/wyattjoh/claude-code-marketplace).
From inside Claude Code, add the marketplace and then install the plugin:

```
/plugin marketplace add wyattjoh/claude-code-marketplace
/plugin install wyattjoh/stacked-prs
```

After install, the `stacked-prs` skill auto-loads on relevant prompts and is
also user-invocable as `/stacked-prs <subcommand>`.

## Prerequisites

- **git 2.38+** (required for `--update-refs` during rebase)
- **gh CLI** (authenticated, for PR operations)
- **Deno** (runs the helper scripts bundled with the skill)

## How it works

### Storage model

Stack metadata lives entirely in **local git config**:

```
branch.<name>.stack-name          = my-stack
branch.<name>.stack-parent        = main
stack.<stack-name>.merge-strategy = squash
stack.<stack-name>.base-branch    = main
```

No files are added to the working tree. Metadata is per-repo and survives branch
switches, stashes, and worktree changes.

### Tree model

Stacks are **tree-shaped**, not strictly linear. Multiple branches can share the
same parent, creating a fork:

```
main
└── feature/auth
    ├── feature/auth-api
    │   └── feature/auth-api-v2
    └── feature/auth-tests
        └── feature/auth-ui
```

You can start a second branch off any point in the stack without disrupting
existing branches. When the bottom PR lands, if the remaining branches have
different parents (the stack forks), they are automatically split into separate
stacks. Sibling order is alphabetical by branch name; topology is derived from
`stack-parent` relationships, no ordering metadata is stored.

### Execution model

Claude reads the SKILL.md runbook and acts as the orchestrator:

1. **Reads state** by running Deno scripts (`cli.ts status`,
   `cli.ts restack --json`, etc.)
2. **Presents a plan** describing every write operation (rebase, push, PR
   create)
3. **Waits for your confirmation** before executing anything destructive
4. **Executes** git and gh commands, then reports results

If a rebase hits conflicts mid-execution, Claude pauses and re-presents the
remaining plan before continuing.

### Safety guarantees

All write operations require explicit confirmation:

| Always requires confirmation    | Always allowed (read-only)                 |
| ------------------------------- | ------------------------------------------ |
| `git push`, `git rebase`        | `git status`, `git log`, `git fetch`       |
| `git branch -d`                 | `gh pr list`, `gh pr view`, `gh repo view` |
| `gh pr create`, `gh pr edit`    | `cli.ts status`, `cli.ts verify-refs`      |
| `gh pr comment`, `gh api PATCH` | `cli.ts nav --dry-run`                     |

## Commands

### `/stacked-prs init`

Register the current branch as a new stack. Prompts for a stack name and merge
strategy (merge or squash), then writes git config metadata. The current branch
becomes the root with `main` as its parent.

### `/stacked-prs import`

Discover and register an existing tree of branches as a stack. Walks the git
graph between your current branch and main, detects PR base mismatches, and
warns you. After confirmation, writes config for all discovered branches at
once.

### `/stacked-prs create`

Add a new child branch off the current branch. The new branch becomes a child of
the current branch in the stack tree. If you have staged changes, Claude offers
to commit them.

### `/stacked-prs insert`

Insert a new branch between a branch and its parent. Shows the tree and asks
which branch to insert before. Suggests running `sync --upstack-from` to align
git history afterward.

### `/stacked-prs split`

Split a branch's content into two branches. Two modes:

- **`--by-commit`**: Split after a specific commit. Original branch keeps
  earlier commits, new branch above gets later commits.
- **`--by-file`**: Extract files matching a pathspec into a new branch _below_
  the original. Note: this is lossy with commit history.

### `/stacked-prs fold`

Merge a branch into its parent (inverse of split). Appends commits to the parent
(fast-forward or squash), reparents children, removes the branch from the stack,
and deletes the git branch.

### `/stacked-prs move`

Move a branch to be a child of a different parent. Detaches the branch
(reparenting its children to the old parent), then reattaches it as a child of
the specified new parent.

### `/stacked-prs sync`

Fetch main, rebase the stack tree, and push to remote.

```
/stacked-prs sync                              # full stack
/stacked-prs sync --upstack-from=<branch>      # branch and all descendants
/stacked-prs sync --downstack-from=<branch>    # branch and all ancestors
/stacked-prs sync --only=<branch>              # just the current branch
```

Fetches main, calls the segment-based tree rebase, runs ancestry verification,
and force-pushes with `--force-with-lease`.

### `/stacked-prs restack`

Same as `sync` but without fetching main or pushing to remote. Useful when you
want to rebase locally before reviewing the diff. Accepts the same
`--upstack-from`, `--downstack-from`, `--only` flags.

### `/stacked-prs submit`

Create or update PRs for all branches in the stack:

- **Creates PRs** for branches without one (targeting the correct parent; marked
  draft when the parent is not the stack's base branch)
- **Updates PR bases** when the parent branch has changed
- **Reconciles draft state** so PRs whose parent is the base branch are ready
  for review and all other PRs in the stack remain drafts. This prevents merging
  stacked PRs out of order.
- **Adds/updates navigation comments** on each PR so reviewers can navigate the
  stack

Navigation comments are rendered as a nested markdown list of bare `#N` PR
references so GitHub auto-links each entry and shows the PR title on hover:

```markdown
<!-- stack-nav:start -->

**Stack: auth-rework**

- #101
  - #103
  - **#102 👈 this PR**

_Part of a stacked PR chain. Do not merge manually._

<!-- stack-nav:end -->
```

### `/stacked-prs status`

Show current stack state (read-only):

```
Stack: auth-rework (squash merge)

  feature/auth              PR #101 (open)      up-to-date
  ├── feature/auth-api      PR #103 (open)      up-to-date
  └── feature/auth-tests    PR #102 (draft)     behind-parent  <- you are here
      └── feature/auth-ui   (no PR)             up-to-date
```

### Interactive view

```
deno run --allow-run=git,gh,pbcopy,wl-copy,clip.exe --allow-env --allow-read \
  src/cli.ts status -i
```

Launches a terminal UI that shows every stack in the repo as a horizontal tree,
with per-stack colors, PR state glyphs, sync-status connectors, and a live
commit detail pane. Mostly read-only: the only write operation is the `L`
binding, which lands a stack whose root PR has been merged.

Key bindings:

- `↑`/`↓`/`←`/`→`: navigate branches (up/down in row order, left to parent, right to first child)
- `tab` / `shift-tab`: cycle focus between header, stack map, and detail pane
- `g` / `G`: first / last branch in the current stack
- `pgup` / `pgdn`: previous / next stack
- `r`: refresh all
- `p`: open focused PR in browser
- `b`: copy branch name to clipboard
- `L`: land the focused stack (root merged, or every branch merged). Opens a
  modal with the full plan (rebases, pushes, PR retargets, deletions), waits for
  `y` to confirm, streams progress, and rolls back local branches + attempts
  remote restore on failure. Use `↑`/`↓` to scroll the modal.
- `?`: toggle full key help
- `q` / `esc` / `ctrl-c`: quit

### `/stacked-prs land`

Clean up after a PR merges. Auto-splits the stack when landing creates multiple
roots:

1. Reparents children of the merged branch to the merged branch's parent
2. Rebases remaining branches (uses `--onto` for squash merges)
3. If landing creates multiple roots, auto-splits into separate stacks. Names
   are derived from each root branch by stripping common prefixes.
4. Retargets the next PR's base to main and flips it out of draft
5. Updates navigation comments
6. Deletes the merged branch locally

### `/stacked-prs help`

Show available commands with ASCII diagrams. Pass a command name for detailed
help: `/stacked-prs help create`.

## Typical workflow

```
# Start a feature, init as a stack
git checkout -b feature/auth
# ... make commits ...
/stacked-prs init

# Add more layers
/stacked-prs create          # creates feature/auth-tests
# ... make commits ...
/stacked-prs create          # creates feature/auth-ui
# ... make commits ...

# Fork: add a parallel branch off feature/auth
git checkout feature/auth
/stacked-prs create          # creates feature/auth-api
# ... make commits ...

# Create all PRs at once
/stacked-prs submit

# After review, sync with latest main
/stacked-prs sync

# Bottom PR gets merged, stack auto-splits
/stacked-prs land
```

## Helper scripts

The skill ships Deno scripts in `src/` that Claude runs for data queries and
metadata mutations. You generally do not need to run them directly, but they can
be useful for debugging. All commands go through a single entry point:

```bash
deno run --allow-run=git,gh --allow-env --allow-read \
  src/cli.ts <subcommand> [flags]
```

| Subcommand                                    | Purpose                                                               |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `cli.ts status [--json]`                      | Tree output (or JSON) with PR info and sync status                    |
| `cli.ts restack [--json]`                     | Segment-based tree rebase; handles conflicts across segments          |
| `cli.ts nav [--dry-run]`                      | Builds and executes navigation comment plans                          |
| `cli.ts verify-refs`                          | Checks branch ancestry after rebase, outputs repair commands          |
| `cli.ts import-discover`                      | Discovers branch trees between a branch and main                      |
| `cli.ts submit-plan`                          | Computes the full submit plan (PRs to create/update, nav changes)     |
| `cli.ts land [--dry-run] [--json] [--resume]` | Land a merged PR; plan only with `--dry-run`, resume after conflicts  |

`--stack-name` auto-detects from the current branch's git config when omitted.
`--owner` and `--repo` auto-detect from `gh repo view` when omitted.

## Merge strategies

When initializing a stack, you choose a merge strategy:

- **merge** (recommended for stacks): After landing, a standard
  `git rebase origin/main --update-refs` realigns the stack because merge
  commits preserve ancestry.
- **squash**: After landing, requires
  `git rebase --onto origin/main <merged-branch> <next-branch>` because
  squashing breaks the ancestry chain.

The skill tracks this in `stack.<name>.merge-strategy` and uses the correct
rebase strategy automatically during `land`.

## Tree-shaped stacks

### Forking

You can branch off any point in the stack. For example, with
`auth -> auth-tests -> auth-ui`, adding `auth-api` as a sibling of `auth-tests`:

```
git checkout feature/auth
/stacked-prs create
```

The tree becomes:

```
feature/auth
├── feature/auth-api      (new)
└── feature/auth-tests
    └── feature/auth-ui
```

### Auto-split on land

When the bottom PR of a forked stack merges, the remaining branches may have
different parents. After removing the merged branch, these become independent
trees. `land` detects this and splits the stack: each root branch becomes the
root of a new stack, with names derived by stripping common prefixes.

### Rebase segments

`sync` and `restack` use segment-based rebasing. A segment is a linear path from
a fork point (or root) to a leaf. Each segment is rebased with a single
`git rebase --update-refs` call. Independent sibling segments continue even if
one has a conflict, so a conflict in one branch does not block unrelated
branches.

## Troubleshooting

### "Branch is already part of stack"

The branch has existing stack metadata. Run `/stacked-prs status` to see its
current stack. To manually clear metadata:

```bash
git config --unset branch.<name>.stack-name
git config --unset branch.<name>.stack-parent
```

### Stale branches after rebase

If `--update-refs` misses a branch (e.g., it was in another worktree),
`verify-refs` detects it and outputs repair commands like:

```
git rebase --onto <parent> <merge-base> <branch>
```

Claude will present these for confirmation before running them.

### PR base mismatches

During `import` or `submit`, if a PR's base branch does not match the expected
parent in the stack, you will see a warning. Use `submit` to automatically
correct PR bases.

### Conflicts during restack

If `restack` hits a conflict, it pauses and shows which files need resolution.
After resolving:

```bash
git add <conflicted-files>
git rebase --continue
```

Then ask Claude to resume: `/stacked-prs restack` (it will use `--resume` to
pick up from where it left off). Independent sibling segments unaffected by the
conflict are already complete.

### Stack looks wrong after migration from old format

Old stacks used `branch.<name>.stack-order` for ordering. The skill
auto-migrates when it detects this key: it validates the tree from
`stack-parent` relationships, writes `stack.<name>.base-branch`, then removes
all `stack-order` keys. If you see unexpected behavior after migration, run
`/stacked-prs status` to verify the tree looks correct.

## Development

See [CLAUDE.md](CLAUDE.md) for the development guide (architecture, script
roles, test commands, and the rules around the `cli.ts` entry point).
