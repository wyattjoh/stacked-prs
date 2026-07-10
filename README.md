<p align="center">
  <img src="assets/icon.png" alt="stacked-prs icon" width="160">
</p>

# stacked-prs

A tool for managing stacked branches and pull requests. Available as a
standalone CLI (via Homebrew or JSR) and as a Claude Code plugin that works
_through_ Claude: you issue natural language requests or
`/stacked-prs <subcommand>`, and Claude orchestrates git, gh, and Deno helper
scripts on your behalf.

## Installation

### Homebrew (standalone CLI)

Install the `stacked-prs` binary for direct terminal use (no Deno required):

```
brew tap wyattjoh/stable
brew install stacked-prs
```

After install, `stacked-prs` is in your PATH. Run the interactive TUI with:

```
stacked-prs status --interactive
```

### JSR (standalone CLI)

Install the Deno-based CLI from JSR:

```
# macOS
deno install --global --allow-run=git,gh,pbcopy,open --allow-env --allow-read --allow-net -n stacked-prs jsr:@wyattjoh/stacked-prs

# Linux
deno install --global --allow-run=git,gh,xclip,wl-copy,xdg-open --allow-env --allow-read --allow-net -n stacked-prs jsr:@wyattjoh/stacked-prs
```

This installs the same command name:

```
stacked-prs status --interactive
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
branch.<name>.description         = Markdown description
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
| `gh pr comment`, `gh api PATCH` | `cli.ts nav --dry-run`, `cli.ts serve`     |

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

When run from the repo's default branch (e.g. `main`), `create` auto-inits a new
stack so you do not need to run `init` first.

Pass `--create-worktree <dir>` to eject the new branch into a git worktree at
the given directory, keeping your current working tree clean.

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

Bring **every non-archived stack** in the repo back in line with origin. Mirrors
`gt sync`. Archived stacks are skipped (pass `--archived` to include them). In
one pass `sync`:

1. Fetches every base branch (for example, `main`).
2. Fast-forwards each local base branch when safe, warning and skipping any that
   have diverged.
3. Detects merged PRs across every stack, deletes those branches locally,
   reparents their children, retargets the children's PR bases on GitHub, and
   refreshes navigation comments.
4. Restacks the surviving branches and force-pushes with `--force-with-lease`.

```
/stacked-prs sync --dry-run       # preview plan across all stacks
/stacked-prs sync                 # prompts [y/N] before executing
/stacked-prs sync --force         # execute without prompting
/stacked-prs sync --archived      # also sync archived stacks
/stacked-prs sync --json          # structured output
```

The CLI stops at the first conflict or push failure and reports which stack
failed so the remaining stacks stay untouched. For a single-stack or
branch-scoped rebase without fetching or pushing, use `/stacked-prs restack`.

### `/stacked-prs restack`

Same as `sync` but without fetching main or pushing to remote. Useful when you
want to rebase locally before reviewing the diff. Accepts the same
`--upstack-from`, `--downstack-from`, `--only` flags. Has three modes:

```
/stacked-prs restack --dry-run     # preview plan
/stacked-prs restack               # prompts [y/N] before executing
/stacked-prs restack --force       # execute without prompting
```

On successful completion HEAD is restored to the branch you were on when you
started so the DFS walk does not strand you on the last-rebased leaf. On
conflict HEAD stays on the conflicted branch so you can resolve in place.
`--resume` continues after a conflict without re-prompting.

### `/stacked-prs submit`

Push every stack branch and create or update PRs. Mirrors `gt submit`. Has three
modes:

```
/stacked-prs submit --dry-run     # preview plan
/stacked-prs submit               # prompts [y/N] before executing
/stacked-prs submit --force       # execute without prompting
```

On each run the CLI:

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

Part of a [stacked-prs](https://github.com/wyattjoh/stacked-prs) chain. Do not
merge manually.

<!-- stack-nav:end -->
```

### `/stacked-prs status`

Show current stack state (read-only):

```
│ ◯      feature/auth-ui     up-to-date
│ ◉      feature/auth-tests  behind-parent
◯─┘      feature/auth-api    up-to-date
◯─┘      feature/auth        up-to-date
```

Pass `--pr` / `-p` to load PR data from GitHub and include PR metadata in the
output.

When run from the repo's default branch (for example, `main`), `status` defaults
to the all-stacks view. On any other branch, it defaults to that branch's stack
only.

Pass `--all` / `-a` to render every configured stack grouped by base branch:

```
│ ◯      feature/auth-api  up-to-date
◯─┘      feature/auth      up-to-date
◯        feature/payments  behind-parent
```

Archived stacks (see [`/stacked-prs archive`](#stacked-prs-archive)) are hidden
from the all-stacks view by default. Pass `--archived` to include them; `--json`
always lists every stack with an `archived` flag.

Root branches compare against `origin/<base>` when that remote-tracking ref
exists, falling back to the local base branch for repositories without an
origin. Pass `--fetch` to refresh the remote-tracking ref before computing sync
status. Fetch failures print a warning and use the last-fetched ref.

### `/stacked-prs checkout`

Open a status-style branch picker and check out the selected stack branch:

```
stacked-prs checkout
stacked-prs checkout --all
stacked-prs checkout --archived
```

Use up/down to move the cursor, Page Up/Page Down to jump between stacks, and
Home/End to jump to the top or bottom of the list. Type to fuzzy-filter the
branch list; Backspace edits the query and Ctrl-U clears it. Press Enter to run
`git checkout <branch>`, or press Esc/Ctrl-C to abort without changing branches.
The current branch starts selected when it is visible, including the base
branch, and the selected row overrides status colors with white text. Split
escape and UTF-8 input sequences are buffered; unsupported escape sequences are
ignored. The picker accepts the status scoping and PR-loading flags:
`--stack-name`, `--all` / `-a`, `--archived`, and `--pr` / `-p` (with optional
`--owner` and `--repo`), plus `--fetch` and `--description`. It renders inline
in the current terminal scrollback, leaving the final picker frame visible with
checkout or abort output below it. When the ladder is taller than the terminal,
the picker keeps a viewport-sized window around the selected row and counts
physical rows created by wrapped ladder and prompt lines. Terminal dimensions
are re-read on every redraw, so a resize is reflected after the next handled
keypress. The picker includes the base branch shown at the bottom of the ladder.

### Branch descriptions

Give any stack branch an optional markdown description of what it is supposed to
accomplish:

```bash
git branch --edit-description feat/api-cache
```

When set, `status` shows the dimmed first line under the branch (`--description`
prints it in full), and the TUI detail pane renders it for the focused branch.
Scroll the focused detail pane with `j` and `k`. The `serve` browser view
renders the full markdown description below each branch label. Descriptions are
stored in git's native `branch.<name>.description` config key, are local to the
repository, and are cleaned up automatically when the branch is deleted.

Descriptions are also the source of truth for PR bodies. `submit` creates a
described branch's PR with the description as the body (title from the oldest
commit's subject) and overwrites the open PR's body whenever it drifts from the
description, so keep the description current instead of editing the PR on
GitHub. Branches without a description keep gh's `--fill` behavior and their PR
bodies are never touched.

### `/stacked-prs archive`

Mark a stack as archived when you are done with it but want to keep its
metadata:

```
stacked-prs archive                 # archive the current branch's stack
stacked-prs archive my-stack        # archive a named stack
stacked-prs archive --unarchive     # restore the current branch's stack
```

An archived stack keeps all of its configuration but is hidden by default from
`status`, the interactive TUI, and `serve`, and is skipped by `sync`. Reveal
archived stacks on demand with `status --archived`, `sync --archived`, the `a`
key in the TUI, or the **Show archived** switch in the browser view. Explicit
single-stack commands still work on archived stacks.

### Browser view

```
stacked-prs serve [folders...]
```

Starts a local web server and opens your browser for the repositories you pass
as folder arguments. If no folders are provided, `serve` uses the current
working directory as the only repository. Repository folders can be nested
paths. The page opens on a stack switcher: pick **All stacks** for an overview
where each repository is rooted at its base branch and every stack descends off
a shared trunk, or pick a single stack to see each repository's branches drawn
as a vertical lane. Every branch row shows its sync status, a PR badge that
links to the pull request when available, and a marker for the currently
checked-out branch. Branch descriptions render as muted markdown blocks below
their branch labels. Each stack's branch rows are tinted in that stack's color
(alternating subtly row to row) so you can tell at a glance where one stack's
branches end and the next begins; the checked-out row gets a stronger tint.
Hovering a branch row brightens it and highlights its graph dot, making it easy
to see which node lines up with the row. Requested repositories with no
stacked-prs metadata are omitted from the browser view. Next to each stack's
name (and in the single-stack view, on each repository header) a muted label
shows how long ago the most recent commit on that stack was made, for example
`2 days ago`.

Stacks are grouped by name across repositories, so a stack that exists in more
than one repository appears once in the switcher and renders every contributing
repository together. Stacks are ordered with the most recently committed stack
first, in both the overview and the switcher dropdown (each switcher entry also
shows that relative commit time).

When you serve more than one repository, an **All repositories** dropdown
appears at the left of the header. It lists every served repository with a
checkbox (plus a master "All repositories" toggle); unchecking a repository
removes it from the view, narrowing the stacks shown to those that live in the
repositories you keep selected. Deselecting every repository shows a prompt to
pick one.

Your selections (the active stack and the repository filter) are remembered per
browser tab for the life of that tab, so reloading restores the view. They are
not stored in the URL: separate `serve` windows keep independent selections, and
closing the tab clears them.

Archived stacks are hidden by default. When any archived stack exists, a **Show
archived** switch appears in the header to reveal them (dimmed, with an
`(archived)` badge); the choice is remembered across reloads.

`serve` is read-only. It loads stack metadata from each provided repo folder and
uses GitHub PR metadata when the repository's `origin` remote is on GitHub and
`gh` can read PRs. While loading, the page shows a per-repository progress
screen (each repository moves `queued -> loading -> done`, or `error` with a
reason) before swapping to the stack view once every repository settles.
Repositories are loaded a few at a time (a concurrency cap) so large repo sets
do not fire dozens of GitHub calls at once.

The view updates live by default. `serve` watches each repository's `.git` for
local changes (commits, branches, rebases, stack-metadata edits) and polls
GitHub for PR changes, then re-renders just the repository that changed and
shows a brief toast, so you do not need to reload the page. Pass `--no-watch` to
turn this off, or `--poll-interval <seconds>` to change how often PRs are polled
(default 60, `0` disables PR polling while keeping the file watch). Pass
`--debug` to print why each live repository refresh ran, including the relevant
Git file category (`refs`, `config`, `HEAD`, `ORIG_HEAD`, or `packed-refs`) or
the PR poll interval.

```
stacked-prs serve
stacked-prs serve ../repo-a nested/path/repo-b
stacked-prs serve --port 8787
stacked-prs serve --host 0.0.0.0 --no-open
stacked-prs serve --no-watch
stacked-prs serve --poll-interval 30
stacked-prs serve --debug
```

### Interactive view

```
deno run --allow-run=git,gh,pbcopy,open --allow-env --allow-read --allow-net \
  src/cli.ts status --interactive
```

Launches a terminal UI that shows every stack in the repo as a horizontal tree,
with per-stack colors, PR state glyphs, sync-status connectors, and a live
commit detail pane. `--interactive` / `-i` opens the current stack by default,
except on the default branch where it starts on the all-stacks view; add `--all`
to force that view explicitly. Mostly read-only: the two write operations are
the `L` binding, which lands a stack whose root PR has been merged, and the `A`
binding, which archives or unarchives the focused stack.

Key bindings:

- `↑`/`↓`/`←`/`→`: navigate branches (up/down in row order, left to parent,
  right to first child)
- `tab` / `shift-tab`: cycle focus between header, stack map, and detail pane
- `j` / `k`: scroll the detail pane when it is focused
- `g` / `G`: first / last branch in the current stack
- `pgup` / `pgdn`: previous / next stack
- `r`: refresh all
- `a`: toggle whether archived stacks are shown
- `A`: archive / unarchive the focused stack (applies immediately, with a status
  notice; if archived stacks are hidden, the stack drops out of view)
- `p`: open focused PR in browser
- `b`: copy branch name to clipboard
- `L`: land the focused stack (root merged, or every branch merged). Opens a
  modal with the full plan (rebases, pushes, PR retargets, deletions), waits for
  `y` to confirm, streams progress, and rolls back local branches + attempts
  remote restore on failure. Use `↑`/`↓` to scroll the modal.
- `?`: toggle full key help
- `q` / `esc` / `ctrl-c`: quit

### `/stacked-prs pr`

Open the current (or specified) branch's PR in the browser. Mirrors `gt pr`.

```
/stacked-prs pr                     # open current branch's PR
/stacked-prs pr --branch=<name>     # open the PR for a specific branch
/stacked-prs pr --print             # print the URL instead of opening
```

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

### `/stacked-prs clean`

Detect and remove stale stack/branch config entries (orphaned branches, missing
parents, empty stacks, stale resume-state). Presents findings and waits for
confirmation before removing any config keys.

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
deno run --allow-run=git,gh,open --allow-env --allow-read --allow-net \
  src/cli.ts <subcommand> [flags]
```

| Subcommand                                                          | Purpose                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `cli.ts status [--json] [--all] [--fetch] [--description]`          | Ladder output (or JSON) with PR info, sync status, and descriptions    |
| `cli.ts checkout [--all] [--fetch] [--description]`                 | Interactive status-style branch picker that runs `git checkout`        |
| `cli.ts serve [folders...] [--port] [--host] [--no-open] [--debug]` | Local browser view for visualizing provided repository folders         |
| `cli.ts create <branch> [--create-worktree]`                        | Create a child branch; auto-inits stack when on default branch         |
| `cli.ts restack [--json]`                                           | Segment-based tree rebase; handles conflicts across segments           |
| `cli.ts nav [--dry-run]`                                            | Builds and executes navigation comment plans                           |
| `cli.ts verify-refs`                                                | Checks branch ancestry after rebase, outputs repair commands           |
| `cli.ts import-discover`                                            | Discovers branch trees between a branch and main                       |
| `cli.ts submit [--dry-run] [--force]`                               | Plan (with `--dry-run`) or run submit: push + PR create/edit + nav     |
| `cli.ts sync [--dry-run] [--force]`                                 | Fetch + ff bases + prune merged PRs + restack + push across all stacks |
| `cli.ts pr [--branch=<name>] [--print]`                             | Open the branch's PR in the browser via `gh pr view --web`             |
| `cli.ts land [--dry-run] [--json] [--resume]`                       | Land a merged PR; plan only with `--dry-run`, resume after conflicts   |

`--stack-name` auto-detects from the current branch's git config when omitted.
`--owner` and `--repo` auto-detect from `gh repo view` when omitted.

## Merge strategies

When initializing a stack, you choose a merge strategy:

- **squash** (default): After landing, requires
  `git rebase --onto origin/main <merged-branch> <next-branch>` because
  squashing breaks the ancestry chain.
- **merge**: After landing, a standard `git rebase origin/main --update-refs`
  realigns the stack because merge commits preserve ancestry.

The skill tracks this in `stack.<name>.merge-strategy` and uses the correct
rebase strategy automatically during `land`.

### Changing the default

`init`, `import`, and auto-init `create` default to `squash`. To change the
default without passing `--merge-strategy` on every invocation, set
`stack.default-merge-strategy` in git config:

```bash
# Per-repo override:
git config stack.default-merge-strategy merge

# Global override (applies to every repo):
git config --global stack.default-merge-strategy merge
```

An explicit `--merge-strategy` flag always wins over the config value.

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
