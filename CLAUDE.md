# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Repository purpose

This repo is a Claude Code **plugin** that ships a single user-invocable skill:
`stacked-prs`. The skill manages tree-shaped stacks of git branches and their
pull requests using git config as the source of truth, Deno helper scripts for
data queries and metadata mutations, and `gh` for GitHub operations.

## Layout

```
.claude-plugin/plugin.json      # Plugin manifest (skills/ is auto-discovered)
.github/workflows/
├── ci.yml                      # Deno check/lint/test + plugin validate on PRs
└── release.yml                 # release-please + marketplace update on push to main
README.md                       # User-facing docs (install + /stacked-prs commands)
CLAUDE.md                       # This file: development guide
deno.json                       # Deno config: tasks, imports, fmt rules
deno.lock
release-please-config.json
.release-please-manifest.json
src/
├── cli.ts                      # Unified CLI entry point (@cliffy/command router)
├── lib/                        # Shared libraries (no direct CLI mapping)
│   ├── stack.ts                # Core: types, git config read/write, tree traversal
│   ├── gh.ts                   # GitHub CLI wrapper with test fixture support (GH_MOCK_DIR)
│   ├── worktrees.ts            # Pre-flight worktree safety reader (git worktree list + status)
│   ├── cleanup.ts              # Shared cleanup primitives: snapshot capture, merged-branch preview, config reparent/tombstone
│   ├── config.ts               # Metadata mutation helpers (insert/fold/move/split/land cleanup)
│   ├── submit-plan.ts          # Computes the full submit plan (consumed by submit.ts)
│   ├── colors.ts               # Per-stack color assignment (shared by TUI and clean output)
│   ├── ansi.ts                 # ANSI escape code helpers
│   └── testdata/helpers.ts     # Test utilities (createTestRepo, addBranch, commitFile)
├── commands/                   # One file per `cli.ts <name>` subcommand
│   ├── clean.ts                # Stale config detection and removal
│   ├── create.ts               # Branch creation: child / auto-init / auto-init + worktree
│   ├── status.ts               # Stack state + PR info
│   ├── restack.ts              # Per-branch topological rebase
│   ├── nav.ts                  # PR navigation comment management
│   ├── verify-refs.ts          # Post-rebase branch ancestry verification
│   ├── import-discover.ts      # Chain detection: walks git graph to find branch trees
│   ├── submit.ts               # Executes submit plan: push + PR create/edit/ready + nav
│   ├── sync.ts                 # Cross-stack fetch + restack + push
│   ├── pr.ts                   # Branch-to-PR lookup
│   ├── land.ts                 # Land planning and execution (pure planLand + impure executeLand)
│   ├── init.ts                 # Register the current branch as a new stack (config writes)
│   ├── import.ts               # Wrap import-discover with a one-shot config-write step
│   ├── insert.ts               # Insert a new branch between a branch and its parent
│   ├── fold.ts                 # Merge a branch into its parent and remove it from the stack
│   ├── move.ts                 # Reparent a branch under a different parent + rebase --onto
│   └── split.ts                # Split a branch --by-commit or --by-file into two branches
└── tui/                        # Ink-based interactive view (status -i)
    ├── app.tsx
    ├── components/
    ├── state/
    └── lib/
skills/stacked-prs/
├── SKILL.md                    # Runbook Claude follows for each sub-command
└── references/
    └── git-commands.md         # Git reference for rebase, --onto, conflict resolution
```

`skills/` at the plugin root is auto-discovered by Claude Code, so `plugin.json`
does not need a `skills` field.

## Commands

All Deno commands run from the repo root:

```bash
# Full test suite (real git repos in tmp dirs + gh fixture mocks)
deno task test

# Single test file
deno test --allow-run=git,gh --allow-env --allow-read --allow-write \
  src/commands/restack.test.ts

# Single TUI component test (same allow flags; Ink + ink-testing-library
# don't need anything beyond what the task test flags already grant)
deno test --allow-env --allow-read src/tui/components/stack-band.test.tsx

# Type check, lint, fmt check
deno task check

# Invoke a CLI subcommand directly
deno run --allow-run=git,gh --allow-env --allow-read src/cli.ts status --json

# Launch the interactive TUI from this repo
deno task tui

# Install a global `stacked-prs` binary into ~/.deno/bin (or mise's deno bin
# dir) so the TUI can be run from any other git repo. Uses absolute paths so
# the installed wrapper always reads the live source and deno.json.
deno task install

# Compile a standalone binary (no Deno runtime needed at target)
deno task compile:macos   # macOS (pbcopy clipboard support)
deno task compile:linux   # Linux (xclip/wl-copy clipboard support)
```

Subcommands: `status` (add `-i`/`--interactive` to launch the TUI), `create`,
`restack`, `nav`, `verify-refs`, `import-discover`, `init`, `import`, `insert`,
`fold`, `move`, `split`, `submit`, `sync`, `pr`, `land`, `clean`.
`lib/config.ts` and `lib/submit-plan.ts` are libraries shared across commands;
import their functions directly.

`submit` wraps `computeSubmitPlan` with an execution path: force-push, then
`gh pr create|edit|ready` per branch, then apply nav comments. `sync` iterates
every stack returned by `getAllStackTrees`: it fetches every base once,
fast-forwards local base branches when safe (warning on divergence), prunes
branches whose PRs merged on GitHub (reparenting children and retargeting their
PR bases), then composes `restack` + force-push per stack. It stops at the first
failure. `pr` is a thin lookup over `gh pr list` that delegates browser-opening
to `gh pr view --web`. Both `submit` and `sync` share a tri-modal CLI shape:
`--dry-run` prints the plan only, default (no flags) prompts `[y/N]`, and
`--force` executes without prompting. This matches the SKILL.md
confirmation-gate philosophy: Claude uses `--dry-run` to inspect, then `--force`
after approval.

## Architecture

### Execution model

`SKILL.md` is a runbook Claude follows step-by-step. Deno scripts handle **data
queries** and **metadata mutations**, while Claude itself executes the
destructive git/gh commands (rebase, push, PR create/edit, comments) after
presenting a plan to the user.

- Scripts return JSON (`--json` flag) that Claude parses to make decisions.
- Claude presents plans before any write operation and waits for confirmation.
- **Git config is the source of truth** for stack metadata. No files are added
  to the working tree.

### Tree model

The stack is a **tree** (parent-only DAG), not a linear chain. Each branch has
exactly one parent (another stack branch or the base branch). Multiple branches
can share the same parent, creating a fork. Sibling order is alphabetical by
branch name, determined at read time.

Tree traversal uses DFS (depth-first, pre-order). `restack.ts` rebases per
branch: it walks the filtered tree in DFS topological order, snapshots each
node's parent SHA before any mutation, then runs
`git rebase --onto <new-target> <old-parent-sha> <branch>` for each branch in
turn. Root branches target `origin/<base>` so local `main` is never touched. The
walk stops at the first conflict and leaves the working tree mid-rebase for
resolution; `--resume` continues the walk after `git rebase --continue`. Resume
state is persisted under `stack.<stack-name>.resume-state` so a conflicted run
can be continued across process invocations.

### Script roles

| File                              | Role                                                                  | Invoked as                                                              |
| --------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/lib/stack.ts`                | Library only, not a CLI                                               | Imported by all other scripts                                           |
| `src/lib/gh.ts`                   | Library only, not a CLI                                               | Imported by scripts needing GitHub data                                 |
| `src/lib/config.ts`               | Library: metadata mutations (insert/fold/move/split/land cleanup)     | Imported by commands that mutate stack metadata                         |
| `src/lib/submit-plan.ts`          | Library: submit planning (consumed by `submit.ts`)                    | Imported by `commands/submit.ts` and tests                              |
| `src/commands/clean.ts`           | Stale config detection and removal                                    | `cli.ts clean [--force] [--json]`                                       |
| `src/commands/create.ts`          | Branch creation with optional worktree                                | `cli.ts create <branch> [flags]`                                        |
| `src/commands/status.ts`          | Read stack state + PR info                                            | `cli.ts status [--json]`                                                |
| `src/commands/restack.ts`         | Per-branch topological rebase                                         | `cli.ts restack [--dry-run] [--json] [--resume]`                        |
| `src/commands/nav.ts`             | Navigation comments                                                   | `cli.ts nav [--dry-run]`                                                |
| `src/commands/verify-refs.ts`     | Post-rebase verification                                              | `cli.ts verify-refs`                                                    |
| `src/commands/import-discover.ts` | Branch tree detection                                                 | `cli.ts import-discover`                                                |
| `src/commands/submit.ts`          | Plan (with `--dry-run`) and execute submit                            | `cli.ts submit [--dry-run] [--force] [--json]`                          |
| `src/commands/sync.ts`            | Fetch + ff base + prune merged PRs + restack + push across all stacks | `cli.ts sync [--dry-run] [--force] [--json]`                            |
| `src/commands/pr.ts`              | Branch-to-PR lookup                                                   | `cli.ts pr [--branch=<name>] [--print] [--json]`                        |
| `src/commands/land.ts`            | Land planning and execution (pure planLand + impure executeLand)      | `cli.ts land [--dry-run] [--json] [--resume]`; also imported by the TUI |
| `src/commands/init.ts`            | Register current branch as a new stack                                | `cli.ts init [flags]`                                                   |
| `src/commands/import.ts`          | Wrap import-discover with a config-write step                         | `cli.ts import [flags]`                                                 |
| `src/commands/insert.ts`          | Insert a new branch between a branch and its parent                   | `cli.ts insert <branch> [flags]`                                        |
| `src/commands/fold.ts`            | Merge a branch into its parent and remove it from the stack           | `cli.ts fold [flags]`                                                   |
| `src/commands/move.ts`            | Reparent a branch + `git rebase --onto`                               | `cli.ts move --new-parent <name> [flags]`                               |
| `src/commands/split.ts`           | Split a branch (--by-commit / --by-file) into two                     | `cli.ts split --new-branch <name> [flags]`                              |
| `src/tui/app.tsx`                 | Root Ink component, owns reducer + effects                            | Launched by `cli.ts status -i`                                          |

### Git config schema

```
branch.<name>.stack-name           # Which stack this branch belongs to
branch.<name>.stack-parent         # Parent branch name (or the base branch, e.g. "main")
stack.<stack-name>.merge-strategy  # "merge" or "squash"
stack.<stack-name>.base-branch     # Base branch name, e.g. "main" or "master"
stack.<stack-name>.resume-state    # Transient JSON for in-progress restack recovery
stack.<stack-name>.landed-branches # Multi-value: branch names landed from this stack
stack.<stack-name>.landed-pr       # Multi-value: "<branch>:<pr-number>" per landed branch, written at land time so nav comments can keep rendering merged PRs after the branch is deleted
```

`stack-order` is not used in the tree model; topology is derived entirely from
`stack-parent` relationships. `getStackTree` auto-migrates old configs by
removing `stack-order` keys after validating the tree. `resume-state` is
transient: written before a restack walk begins, updated after each successful
branch rebase, and cleared on successful completion. If it exists,
`cli.ts restack` refuses to run without `--resume`.

### TUI layer (`src/tui/`)

The TUI is an Ink + React app launched by `cli.ts status -i`. It reads the same
data sources as non-interactive `status` (`getAllStackTrees`, `git merge-base`,
`gh pr list`), and owns one write path: the `L` key (land). The code is split
along a strict purity boundary so most of it is testable without Ink:

- Pure (`lib/layout.ts`, `lib/scroll.ts`, `state/reducer.ts`,
  `state/navigation.ts`) — unit tested with synthetic inputs, no Ink, no git.
  Per-stack color assignment lives in the shared `src/lib/colors.ts` (used by
  both the TUI and the `clean` CLI output).
- Impure (`state/loader.ts`, `lib/clipboard.ts`, `components/*.tsx`, `app.tsx`)
  — loader uses the existing `gh.ts` fixture system, components are tested with
  `ink-testing-library`, and `app.tsx` gets an integration test that spins up a
  real temp repo.

`cli.ts` dynamically imports Ink/React/App only when `-i` is set so the
non-interactive `status` path doesn't pay the Ink load cost. It also forces
`process.stdout.isTTY = true` before calling `render()` because Deno's
`node:process` compat layer doesn't always set it correctly, which otherwise
makes Ink fall back to append-mode rendering.

#### Rendering model

The TUI renders each stack as a vertical ladder: every branch gets its own row
(2 lines: branch name + PR info), with `├─`/`└─` corners between parent and
child and inter-row `│` rails keeping the tree visually continuous.
`lib/layout.ts` walks the tree DFS and assigns each cell a `depth`,
`isLastSibling`, `hasChildren`, and `ancestorRails[]` that `stack-band.tsx`
turns into prefix strings.

Multiple stacks connect back to a shared `main` label at the top through a
per-stack trunk column. Stack N-1 (the last in render order) sits at col 0 with
no trunk bars to its left; each earlier stack is indented one col-group (3
chars) further right so the later stacks' bars can run up past it to `main`
without crossings. Every stack's content is aligned to the same column (the
most-indented stack's content col), achieved by extending each stack's `└─`
corner horizontally to reach that column. Each bar uses the root branch's sync
glyph (`│`/`╎`/`║` and `─`/`╌`/`═`) so diverged/behind roots are visible at a
glance. Gap rows between stacks keep the trunk continuous while still reading as
separate blocks.

`stack-map.tsx` owns all trunk rendering and passes per-stack header/content
prefix segments into `stack-band.tsx`, which only handles the internal ladder
and cells. The trunk helpers (`headerTrunkSegments`, `contentTrunkSegments`,
`initialTrunkSegments`) produce `TrunkSegment[]` (text + color) and must stay in
sync with the cursor-Y math in `app.tsx` used for scroll tracking.

`app.tsx` maintains `scrollX`/`scrollY` state and a cursor-follow effect that
walks the visible stacks to compute the cursor's row index. Scrolling up snaps
to `max(0, headerY - 2)` so the stack header and two rows of context above it
(including the `main` label for the first stack) stay visible; scrolling down
moves minimally to keep the cursor in view. If a stack is taller than the
viewport, the scroll falls back to cursor-only visibility (header may scroll off
the top).

Keyboard navigation:

- `↑`/`↓`: walk branches in row order (crosses stack boundaries).
- `←`/`→`: parent / first child in the tree.
- `g`/`G`: first / last branch in the current stack.
- `pgup`/`pgdn`: previous / next stack.
- `tab` / `shift-tab`: cycle focus (header / body / detail pane).
- `?`: toggle help overlay (rendered inline inside the main Box rather than as a
  separate root, so Ink's log-update tracking stays correct after close).
- `p`: open focused PR in browser.
- `b`: copy branch name to clipboard.
- `L`: land stack; `r`: refresh all.
- In the land modal: `↑`/`↓` (or `k`/`j`) scroll content; `y`/`n`
  confirm/cancel.

The status bar at the bottom is built dynamically from `STATUS_BAR_ITEMS` in
`help-overlay.tsx`: `buildStatusBar(termSize.cols)` greedily includes shortcuts
until the next one would overflow the terminal width.

The TUI now owns one write operation: the `L` key lands a stack whose root PR
has been merged (or every PR in the stack is merged). The logic lives in
`src/commands/land.ts` (pure `planLand` plus impure `executeLand` with a
snapshot-based rollback path); the TUI is a launcher that shows a plan modal,
streams progress events, and displays a rollback report on failure. Confirmation
gates move into the Ink modal (`[y]`/`[n]`) for this path; the `SKILL.md` `land`
runbook remains the Claude-orchestrated alternative.

### Testing

Tests use real git repos in temp directories (`testdata/helpers.ts` provides
`createTestRepo`). GitHub CLI calls are mocked via `gh.ts`'s fixture system: set
`GH_MOCK_DIR` or call `setMockDir()`, and `gh()` reads
`<mockDir>/<fixtureKey>.json` instead of shelling out.

**Ink + Deno gotcha:** every `ink-testing-library` test must destructure
`unmount` and call it before the test returns, otherwise Deno's leak detector
flags signal-handler leaks from Ink and fails the suite. Also, Ink's `Text` and
any custom Ink component reject a `key` prop in TypeScript; mapped JSX needs
`<Box key={...}>` wrappers around the mapped element.

## Confirmation gates

`SKILL.md` defines a strict list of operations that must never run without
showing a plan and waiting for user confirmation: any `git push`, `git rebase`,
`git branch -d`, `gh pr create|edit|ready|comment`, and `gh api --method PATCH`.
Read-only operations (`git status`, `git log`, `git fetch`, `gh pr list|view`,
`gh repo view`, `cli.ts status`, `cli.ts verify-refs`, `cli.ts nav --dry-run`,
`cli.ts restack --json`) run without confirmation. Preserve this distinction
when editing the runbook.

## Development rules

- All scripts must be **Deno TypeScript**. No bash scripts.
- Scripts must use **explicit Deno permissions** (`--allow-run=git`, etc.).
- `src/lib/` holds shared libraries with no CLI mapping (e.g. `stack.ts`,
  `gh.ts`, `cleanup.ts`, `config.ts`, `submit-plan.ts`, `worktrees.ts`,
  `colors.ts`, `ansi.ts`). Do not add CLI entry points to them.
- `src/commands/` holds one file per `cli.ts <name>` subcommand. If a helper is
  shared by more than one command, it belongs in `src/lib/`, not
  `src/commands/`.
- `cli.ts` is the only CLI entry point. Do not add `import.meta.main` blocks to
  command files.
- Command functions must be pure: no `Deno.args`, no `console.log`, no
  `Deno.exit`. They receive typed options and return structured results. The CLI
  layer (`cli.ts`) owns all I/O: parsing, printing, exit codes.
- `commands/restack.ts` owns all rebase logic. Claude calls it via
  `cli.ts restack` rather than constructing rebase commands manually.
- When adding a new command, register it in the "Scripts" section of `SKILL.md`
  with its full `cli.ts` invocation.
- Ink/TUI code lives under `src/tui/`, not `src/commands/`. The pure-function
  rule for commands is preserved; the TUI is a view layer that owns stdout and
  runs an event loop, which can't fit the command contract. State is managed via
  a pure reducer (`state/reducer.ts`) so most logic remains unit-testable
  without Ink.

## CI and releases

- **CI** (`.github/workflows/ci.yml`) runs on PRs to `main`: `deno fmt --check`,
  `deno lint`, `deno check src/cli.ts`, `deno test ...`, plus
  `claude plugin
  validate .` in a second job.
- **Release** (`.github/workflows/release.yml`) runs on push to `main`:
  release-please opens release PRs and tags new versions as
  `stacked-prs-v<version>`. On release, `wyattjoh/claude-code-marketplace@v1`
  updates the listing in `wyattjoh/claude-code-marketplace`.
- The only version source of truth is `.claude-plugin/plugin.json`. release-
  please bumps it via the `extra-files` rule in `release-please-config.json`.
- No JSR publishing. The skill always runs its source from
  `${CLAUDE_PLUGIN_ROOT}/src/cli.ts`, so there is no library consumer.

## Keeping docs in sync

When making changes, update:

1. **`skills/stacked-prs/SKILL.md`** if you change sub-command behavior,
   add/remove scripts, or modify CLI flags.
2. **`README.md`** (root) if you change user-facing behavior, add commands, or
   modify the workflow.
3. **This file** if you change the architecture, add scripts, or modify the git
   config schema.
