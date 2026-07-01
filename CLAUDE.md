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
│   ├── graph.ts                # layoutLanes: shared fork/lane placement (CLI status ladder + serve graph)
│   ├── markdown.ts             # Markdown subset parser + ANSI/Ink-span renderers
│   └── testdata/helpers.ts     # Test utilities (createTestRepo, addBranch, commitFile)
├── commands/                   # One file per `cli.ts <name>` subcommand
│   ├── clean.ts                # Stale config detection and removal
│   ├── create.ts               # Branch creation: child / auto-init / auto-init + worktree
│   ├── status.ts               # Stack state + PR info
│   ├── serve.ts                # Hono server for explicit multi-repo stack visualization
│   ├── serve.css               # serve UI styles; read at runtime by serve.ts
│   ├── serve.client.js         # serve UI browser client; read at runtime by serve.ts
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
└── tui/                        # Ink-based interactive view (status --interactive)
    ├── app.tsx
    ├── components/
    ├── state/
    └── lib/
skills/stacked-prs/
├── SKILL.md                    # Runbook Claude follows for each sub-command
├── scripts/
│   └── stacked-prs             # POSIX sh wrapper: lazy-compiles CLI to CLAUDE_PLUGIN_DATA/bin/stacked-prs, rebuilds on version bump
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
deno run --allow-run=git,gh,open --allow-env --allow-read --allow-net \
  src/cli.ts status --json

# Launch the interactive TUI from this repo
deno task tui

# Install a global `stacked-prs` binary into ~/.deno/bin (or mise's deno bin
# dir) so the TUI can be run from any other git repo. Uses absolute paths so
# the installed wrapper always reads the live source and deno.json.
deno task install

# Compile a standalone binary (no Deno runtime needed at target)
deno task compile:macos   # macOS (pbcopy clipboard support)
deno task compile:linux   # Linux (xclip/wl-copy clipboard support)

# Validate the JSR package without publishing
deno publish --dry-run --allow-dirty
```

Subcommands: `status` (add `--interactive`/`-i` to launch the TUI), `checkout`,
`serve`, `create`, `restack`, `nav`, `verify-refs`, `import-discover`, `init`,
`import`, `insert`, `fold`, `move`, `split`, `submit`, `sync`, `pr`, `land`,
`clean`, `archive`. `lib/config.ts` and `lib/submit-plan.ts` are libraries
shared across commands; import their functions directly.

Branch descriptions come from the native `branch.<name>.description` key via
`readAllBranchStackConfig`; that helper uses NUL-separated `--get-regexp`
parsing so multi-line values survive. `status` renders the first line by default
and the full markdown body with `--description`. The TUI renders the full
description in its detail pane. Descriptions are also the source of truth for PR
bodies: `computeSubmitPlan` plans `bodyAction: "set"` (create with the
description as `--body` and the oldest commit subject as `--title`) or
`"update"` (overwrite an open PR's drifted body; comparison is
CRLF/trim-normalized, and the live body is fetched lazily via `getPrBody`, not
the PR index). Branches without a description keep `--fill` and are never
body-edited; titles are never updated after creation. `submit` wraps
`computeSubmitPlan` with an execution path: force-push, then
`gh pr create|edit|ready` per branch (base retarget and body sync share one
`gh pr edit`), then apply nav comments. `sync` iterates every stack returned by
`getAllStackTrees`: it fetches every base once, fast-forwards local base
branches when safe (warning on divergence), prunes branches whose PRs merged on
GitHub (reparenting children and retargeting their PR bases), then composes
`restack` + force-push per stack. It stops at the first failure. `sync` skips
stacks marked archived (`stack.<name>.archived`), listing them under
`archivedSkipped` in the plan, unless `--archived` is passed. `archive` toggles
that flag (a single config write, no confirmation gate); defaults to the current
branch's stack when no name is given. `pr` is a thin lookup over `gh pr list`
that delegates browser-opening to `gh pr view --web`. Both `submit` and `sync`
share a tri-modal CLI shape: `--dry-run` prints the plan only, default (no
flags) prompts `[y/N]`, and `--force` executes without prompting. This matches
the SKILL.md confirmation-gate philosophy: Claude uses `--dry-run` to inspect,
then `--force` after approval. `serve` is a read-only local browser view: it binds a
Hono HTTP server (`createServeApp`, served via `Deno.serve(app.fetch)`), opens
the platform browser, resolves the provided repository folder arguments
(defaulting to the current working directory), and renders status metadata by
reusing `getAllStackStatuses`. The browser loads via a Server-Sent Events route
(`/api/status/stream`): `createServeApp` emits an `init` event (the full repo
list), then `repo-start`/`repo-done`/`repo-error` events as a concurrency-capped
worker pool (`loadRepositoryStatuses`, cap `LOAD_CONCURRENCY`) loads each
repository, then a final `complete` event carrying the same payload
`/api/status` returns. The client shows a per-repository
`queued -> loading -> done | error` progress screen and swaps to the full stack
view on `complete`. `/api/status` remains for the buffered (non-streaming)
payload and shares the same pool via `finalizeServeStatus`. When live watch is
enabled (the default; disable with `--no-watch`), `createServeApp` also serves a
long-lived `/api/watch` SSE route. After the initial load the client opens it as
a second `EventSource`; the server emits a `ready` event, then a `repo-updated`
event (one repo's fresh `ServeRepositoryStatus`) whenever that repo changes. Two
triggers feed a coalescing per-repo reload scheduler (`createReloadScheduler`):
a `Deno.watchFs` watcher per repo (`watchRepoFs`, scoped to the git dirs from
`resolveGitWatchPaths`, filtered by `isRelevantGitChange`, debounced) and a PR
poll timer (`--poll-interval`, default 60s, 0 disables) that re-triggers
GitHub-backed repos. When `serve
--debug` is enabled, the server prints one
stderr line before each live refresh, including the repository, trigger source,
and relevant Git file category. Each connection closes its watchers and timer on
disconnect. The client upserts the changed repo into its model and shows a
transient toast. The browser client is authored as `serve.client.js` (and
`serve.css`); `serve.ts` reads both at runtime (relative to `import.meta.url`)
and inlines them into the Hono-rendered document. It is a dark "Stack View" page
(darker page, full-width header, lighter content card): a stack-switcher
dropdown toggles between an "All stacks" overview (each repo rooted at its base
branch with every stack descending off a shared trunk) and a single-stack view
(each repo's branches drawn as a vertical lane). Each branch row shows its sync
status (`diverged`/`behind`/`landed`), a PR badge linking to the PR, and a
checked-out marker for the current branch. Each stack-name row (in the
all-stacks overview) and each repo header (in the single-stack view) carries a
muted relative time of the stack's most recent commit (for example
`2 days ago`), formatted client-side by `formatRelativeTime` from a per-stack
`StackStatus.latestCommitAt` ISO timestamp; `latestCommitAt` is the max
committer date across the stack's branch refs (computed once via
`getLatestCommitDate` in `src/lib/stack.ts`, `null` when no ref resolves) and
flows into the serve payload through the `stripStatusAnsi` spread. Branch rows
are zebra-tinted in their stack's own color at alternating opacity (a faint
`hexToRgba(stackColor, ~0.05/0.02)` background) so each stack reads as one color
band and neighboring rows stay separable; the checked-out row uses a stronger
fill (~0.13, no accent bar) to stand out above the zebra. Tints full-bleed to
the card's inner edges via negative margins (offset by equal padding so the
lane/label content stays aligned with the untinted `main` and stack-name rows);
`CARD_PAD_X` in `serve.client.js` must match the `.app-content` horizontal
padding in `serve.css`. The base/`main` and stack-name rows stay untinted. Each
row passes its tint, a brighter hover variant, and a node-ring color as inline
CSS variables (`--row-tint`/`--row-tint-hover`/ `--node-ring`); `serve.css`
`.branch-row:hover` brightens the row and grows the `.branch-node` dot with a
ring in the stack color so it is easy to see which dot the hovered row lines up
with (the `.branch-node` centering transform lives in CSS so the hover rule can
override it without `!important`). The client groups stacks by name entirely
from the `/api/status` payload's `repositories`, so a stack name shared across
repos collapses into one switcher entry; the server still computes `graph` and
`sharedStacks` for the payload but the current client derives its own grouping.
Stacks are ordered most-recent-commit first (by each stack's `latestCommitAt`
max across its visible repos, ties broken alphabetically, undated stacks last)
in both the all-stacks overview and the switcher dropdown; the ordering is
applied in `visibleStacks` (after the archived + repo filters) so colors stay
stable (`stackColors` is still keyed by stack id and assigned in `buildModel`'s
alphabetical pass). Each switcher menu item appends that relative commit time to
its `N repos · M branches` summary. The per-stack `graph` lane/fork placement is
shared with the CLI status ladder via `layoutLanes` in `src/lib/graph.ts` (first
child continues its parent's lane, each additional child branches one lane to
the right). `buildServeGraph` runs it parent-first (the CLI runs it leaf-first)
and then emits, per row, explicit `rails` (per-lane `up`/`down` half segments
with dashed flags) plus `forkTargets`. The client draws those rails verbatim
instead of inferring connectivity from adjacency, so two separate same-lane
segments never fuse and forks never cross. The lane-gutter width that precedes
each branch label is sized once to the widest `maxLane` across every visible
stack and repo (via `maxLaneAcross`), not per stack, so all branch labels share
one left edge down the whole page regardless of fork depth. Within that shared
gutter each stack's lanes are right-aligned by a per-stack `laneOffset`
(`globalMaxLane - graph.maxLane`), so a shallow stack's node sits in the same
column just left of the labels as a deep stack's rightmost node instead of
hugging the far-left trunk; the main-trunk elbow lands on that offset lane-0
column. The gutter width (`laneAreaWidth`) leaves a fixed 21px gap past the
rightmost node column, and the all-stacks view drives both the `main` base-label
column and each stack-name section header off that same `laneAreaW`, so `main`,
the stack names, and every branch name line up on one vertical column.
Repositories with no configured stacks are omitted from the browser payload;
archived stacks are still sent (each carries an `archived` flag) but the client
hides them by default behind a "Show archived" header switch whose state
persists in `localStorage`. The header also carries a repository-filter dropdown
(left of the stack switcher, styled like it via `renderRepoFilter`), shown only
when more than one repository is served. It lists every served repository with a
checkbox plus an "All repositories" master toggle; deselecting a repository
removes it from the all-stacks view, the single-stack view, the stack-switcher
list, the summary, and the count tags (a stack stays visible while it lives in
at least one selected repository). Filtering is pure client work over the
existing `/api/status` payload: `visibleStacks()` clones each stack with its
`repos` narrowed to the selected paths (identified by the unique `repo.path`,
never the basename `name`) and drops stacks left with no selected repo;
per-stack colors are unaffected because `stackColors` is keyed by stack id and
assigned once in `buildModel`. Repositories render alphabetically by name
(tie-broken on `path`) in the filter menu, the all-stacks repo sections, and
each stack's lanes. View state lives in per-tab `sessionStorage`, not the URL:
the selected stack (key `stacked-prs:selected-stack`) and the repository filter
(key `stacked-prs:selected-repos`, a JSON array of paths) both survive reloads,
never bleed across separate `serve` windows, and are cleared when the tab
closes. Both are reconciled on load against the stacks/repos actually present
(an unknown selected stack resets to the all-stacks overview; a stored repo set
that is empty or fully stale falls back to all-selected so the page never loads
blank). Deselecting every repository renders a "No repositories selected" empty
state. The server serves the SPA shell only at `/` (see `createServeApp`); there
is no `/stack/*` route, so stale deep-links 404.

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

### Plugin CLI entry

`skills/stacked-prs/SKILL.md` invokes the CLI via
`${CLAUDE_PLUGIN_ROOT}/skills/stacked-prs/scripts/stacked-prs <subcommand>`. The
wrapper reads the expected version from `.claude-plugin/plugin.json`, compares
it to a cached marker at `${CLAUDE_PLUGIN_DATA}/bin/.version`, and runs
`deno compile` into `${CLAUDE_PLUGIN_DATA}/bin/stacked-prs` the first time it
runs after each plugin version bump. Subsequent invocations exec the cached
binary directly, with no Deno runtime dependency.

Single-slot cache: the new binary writes over the old one on upgrade. If
`CLAUDE_PLUGIN_DATA` is unset, the fallback is `$HOME/.cache/stacked-prs/bin`.

This is orthogonal to `deno task install`, which produces a global `stacked-prs`
binary at `~/.deno/bin/stacked-prs` for use as a daily-driver CLI from any git
repo. That path is unaffected by the wrapper.

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

| File                              | Role                                                                  | Invoked as                                                                                         |
| --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/lib/stack.ts`                | Library only, not a CLI                                               | Imported by all other scripts                                                                      |
| `src/lib/gh.ts`                   | Library only, not a CLI                                               | Imported by scripts needing GitHub data                                                            |
| `src/lib/config.ts`               | Library: metadata mutations (insert/fold/move/split/land cleanup)     | Imported by commands that mutate stack metadata                                                    |
| `src/lib/submit-plan.ts`          | Library: submit planning (consumed by `submit.ts`)                    | Imported by `commands/submit.ts` and tests                                                         |
| `src/lib/markdown.ts`             | Markdown subset parser + ANSI/Ink-span renderers                      | Imported by status and TUI description renderers                                                   |
| `src/commands/clean.ts`           | Stale config detection and removal                                    | `cli.ts clean [--force] [--json]`                                                                  |
| `src/commands/archive.ts`         | Toggle a stack's archived flag (`stack.<name>.archived`)              | `cli.ts archive [<stack>] [--unarchive] [--json]`                                                  |
| `src/commands/create.ts`          | Branch creation with optional worktree                                | `cli.ts create <branch> [flags]`                                                                   |
| `src/commands/checkout.ts`        | Pure checkout picker helpers and `git checkout <branch>` wrapper      | `cli.ts checkout [--all] [--description]`                                                          |
| `src/commands/status.ts`          | Read stack state + PR info                                            | `cli.ts status [--description] [--json]`                                                           |
| `src/commands/serve.ts`           | Local HTTP server + static browser UI for explicit repo folders       | `cli.ts serve [folders...] [--port] [--host] [--no-open] [--no-watch] [--poll-interval] [--debug]` |
| `src/commands/restack.ts`         | Per-branch topological rebase                                         | `cli.ts restack [--dry-run] [--json] [--resume]`                                                   |
| `src/commands/nav.ts`             | Navigation comments                                                   | `cli.ts nav [--dry-run]`                                                                           |
| `src/commands/verify-refs.ts`     | Post-rebase verification                                              | `cli.ts verify-refs`                                                                               |
| `src/commands/import-discover.ts` | Branch tree detection                                                 | `cli.ts import-discover`                                                                           |
| `src/commands/submit.ts`          | Plan (with `--dry-run`) and execute submit                            | `cli.ts submit [--only <branch>] [--dry-run] [--force] [--json]`                                   |
| `src/commands/sync.ts`            | Fetch + ff base + prune merged PRs + restack + push across all stacks | `cli.ts sync [--dry-run] [--force] [--json]`                                                       |
| `src/commands/pr.ts`              | Branch-to-PR lookup                                                   | `cli.ts pr [--branch=<name>] [--print] [--json]`                                                   |
| `src/commands/land.ts`            | Land planning and execution (pure planLand + impure executeLand)      | `cli.ts land [--dry-run] [--json] [--resume]`; also imported by the TUI                            |
| `src/commands/init.ts`            | Register current branch as a new stack                                | `cli.ts init [flags]`                                                                              |
| `src/commands/import.ts`          | Wrap import-discover with a config-write step                         | `cli.ts import [flags]`                                                                            |
| `src/commands/insert.ts`          | Insert a new branch between a branch and its parent                   | `cli.ts insert <branch> [flags]`                                                                   |
| `src/commands/fold.ts`            | Merge a branch into its parent and remove it from the stack           | `cli.ts fold [flags]`                                                                              |
| `src/commands/move.ts`            | Reparent a branch + `git rebase --onto`                               | `cli.ts move --new-parent <name> [flags]`                                                          |
| `src/commands/split.ts`           | Split a branch (--by-commit / --by-file) into two                     | `cli.ts split --new-branch <name> [flags]`                                                         |
| `src/tui/app.tsx`                 | Root Ink component, owns reducer + effects                            | Launched by `cli.ts status --interactive`                                                          |

### Git config schema

```
branch.<name>.stack-name           # Which stack this branch belongs to
branch.<name>.stack-parent         # Parent branch name (or the base branch, e.g. "main")
branch.<name>.description          # (Optional, native git key) markdown description; rendered by status, TUI, and serve; used by submit as the PR body
stack.<stack-name>.merge-strategy  # "merge" or "squash"
stack.<stack-name>.base-branch     # Base branch name, e.g. "main" or "master"
stack.<stack-name>.resume-state    # Transient JSON for in-progress restack recovery
stack.<stack-name>.landed-branches # Multi-value: branch names landed from this stack
stack.<stack-name>.landed-pr       # Multi-value: "<branch>:<pr-number>" per landed branch, written at land time so nav comments can keep rendering merged PRs after the branch is deleted
stack.<stack-name>.landed-parent   # Multi-value: "<branch>:<parent-branch>" per landed branch, written at land time so the tombstone keeps its structural position in the tree after `git branch -D` wipes its live branch-level config
stack.<stack-name>.color           # (Optional) hex color override for TUI and clean output
stack.<stack-name>.archived        # (Optional) "true" when archived; hidden by default from status/TUI/serve and skipped by sync. Key absent = not archived. Read via getStackArchived(), written via setStackArchived().
stack.default-merge-strategy       # (Optional) default for init/import/auto-init create; "merge" or "squash". Falls back to "squash" when unset. Read via getDefaultMergeStrategy(). Respects --local/--global/--system precedence.
```

`stack-order` is not used in the tree model; topology is derived entirely from
`stack-parent` relationships. `getStackTree` auto-migrates old configs by
removing `stack-order` keys after validating the tree. `resume-state` is
transient: written before a restack walk begins, updated after each successful
branch rebase, and cleared on successful completion. If it exists,
`cli.ts restack` refuses to run without `--resume`.

### TUI layer (`src/tui/`)

The TUI is an Ink + React app launched by `cli.ts status --interactive`. It
reads the same data sources as non-interactive `status` (`getAllStackTrees`,
`git merge-base`, `gh pr list`), and owns two write paths: the `L` key (land)
and the `A` key (archive/unarchive the focused stack). The code is split along a
strict purity boundary so most of it is testable without Ink:

- Pure (`lib/layout.ts`, `lib/scroll.ts`, `state/reducer.ts`,
  `state/navigation.ts`) — unit tested with synthetic inputs, no Ink, no git.
  Per-stack color assignment lives in the shared `src/lib/colors.ts` (used by
  both the TUI and the `clean` CLI output).
- Impure (`state/loader.ts`, `lib/clipboard.ts`, `components/*.tsx`, `app.tsx`)
  — loader uses the existing `gh.ts` fixture system, components are tested with
  `ink-testing-library`, and `app.tsx` gets an integration test that spins up a
  real temp repo.

`cli.ts` dynamically imports Ink/React/App only when `--interactive` / `-i` is
set so the non-interactive `status` path doesn't pay the Ink load cost. It also
forces `process.stdout.isTTY = true` before calling `render()` because Deno's
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
- `j` / `k`: scroll the detail pane when it is focused.
- `?`: toggle help overlay (rendered inline inside the main Box rather than as a
  separate root, so Ink's log-update tracking stays correct after close).
- `p`: open focused PR in browser.
- `b`: copy branch name to clipboard.
- `L`: land stack; `r`: refresh all.
- `a`: toggle archived-stack visibility; `A`: archive/unarchive the focused
  stack (immediate, dispatches `STACK_ARCHIVED_SET` after the config write).
- In the land modal: `↑`/`↓` (or `k`/`j`) scroll content; `y`/`n`
  confirm/cancel.

The status bar at the bottom is built dynamically from `STATUS_BAR_ITEMS` in
`help-overlay.tsx`: `buildStatusBar(termSize.cols)` greedily includes shortcuts
until the next one would overflow the terminal width.

The TUI owns two write operations. The `L` key lands a stack whose root PR has
been merged (or every PR in the stack is merged). The logic lives in
`src/commands/land.ts` (pure `planLand` plus impure `executeLand` with a
snapshot-based rollback path); the TUI is a launcher that shows a plan modal,
streams progress events, and displays a rollback report on failure. Confirmation
gates move into the Ink modal (`[y]`/`[n]`) for this path; the `SKILL.md` `land`
runbook remains the Claude-orchestrated alternative. The `A` key archives or
unarchives the focused stack: `app.tsx` calls `setStackArchived(dir, ...)`
directly and, on success, dispatches `STACK_ARCHIVED_SET` (which updates
`allTrees` and recomputes the visible subset / grid / cursor via the reducer's
`applyVisibility` helper) plus a status notice. It is unconfirmed, matching the
non-gated `archive` CLI command, because it is a single reversible config write.

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
`cli.ts restack --json`) run without confirmation. `cli.ts checkout` is a local
interactive branch switch: the inline terminal picker is the confirmation
surface, keeps tall ladders clipped to the terminal viewport around the selected
row, counts wrapped ladder and prompt lines in the physical-row budget, and
re-reads terminal dimensions on every redraw. It starts on the current branch,
including the base, buffers split escape and UTF-8 sequences, ignores
unsupported escape sequences, overrides status colors on the selected row with
white text, supports Up/Down, Page Up/Page Down, Home/End navigation, and
type-to-filter fuzzy search, and then runs one `git checkout <branch>`. Preserve
this distinction when editing the runbook.

## Development rules

- All scripts must be **Deno TypeScript**. No bash scripts.
- Scripts must use **explicit Deno permissions** (`--allow-run=git`, etc.).
- `src/lib/` holds shared libraries with no CLI mapping (e.g. `stack.ts`,
  `gh.ts`, `cleanup.ts`, `config.ts`, `submit-plan.ts`, `worktrees.ts`,
  `colors.ts`, `ansi.ts`, `markdown.ts`). Do not add CLI entry points to them.
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
- Browser UI for `serve`: the server is a Hono app in `src/commands/serve.ts`
  (`createServeApp` serves `/` via `hono/html` templating and `/api/status` as
  JSON; `startServeServer` runs it with `Deno.serve(app.fetch)`).
  `createServeApp` also serves `/api/status/stream` (SSE via `streamSSE` from
  `hono/streaming`) for progressive per-repository loading; both routes load
  through `loadRepositoryStatuses` (capped at `LOAD_CONCURRENCY`) and finalize
  via `finalizeServeStatus`. `createServeApp` also serves `/api/watch` (a
  long-lived SSE route) when watch is enabled, emitting `ready` then
  `repo-updated` events driven by a `Deno.watchFs` watcher per repo plus a PR
  poll timer; `serve` has `--no-watch`, `--poll-interval`, and `--debug` flags,
  and the rendered document inlines `window.__STACKED_PRS__ = { watch }` so the
  client knows whether to open the channel. The page is authored as two real
  source files, `serve.css` and `serve.client.js` (the vanilla browser client /
  SPA). `renderServeDocument` reads both at runtime via
  `Deno.readTextFile(new URL("./serve.css", import.meta.url))` (and the client),
  so there is no build step or generated file: edit a source file and the next
  page load reflects it. When run from source (e.g. the `deno task install`
  linked binary) these are the live files; `deno compile` binaries embed them
  via `--include src/commands/serve.css --include src/commands/serve.client.js`,
  which is wired into `compile:macos`/`compile:linux`, the skill wrapper
  (`skills/stacked-prs/scripts/stacked-prs`), and `release.yml`. If you add or
  rename a serve asset file, update all three compile sites and
  `publish.include` in `deno.json`. Keep the UI read-only, use positional folder
  arguments as the repository list, and reuse `getAllStackStatuses` for stack
  metadata. The client renders the "Stack View" page: a darker page with a
  full-width header and a lighter content card, a stack-switcher toggling an
  all-stacks overview (repos rooted at their base branch) and a single-stack
  lane view, with stacks grouped by name across repositories. Omit repositories
  that have no configured stacks from the rendered status payload. Archived
  stacks stay in the payload (each carries `archived`); the client hides them by
  default behind a "Show archived" header switch (state persisted in
  `localStorage`) and renders revealed ones dimmed with an `(archived)` badge. A
  repository-filter dropdown (shown only when more than one repository is
  served) narrows every view to the selected repositories; it is pure client
  work over the existing payload, keyed by the unique `repo.path`. View state
  (selected stack and repository filter) lives in per-tab `sessionStorage`, not
  the URL, so `createServeApp` serves the SPA shell only at `/` (no `/stack/*`
  route).
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
  updates the listing in `wyattjoh/claude-code-marketplace`, `deno publish`
  publishes `@wyattjoh/stacked-prs` to JSR with GitHub OIDC, and the Homebrew
  jobs build/upload release binaries.
- Release versions are tracked in both `deno.json` (JSR package metadata) and
  `.claude-plugin/plugin.json` (plugin metadata). release-please bumps both via
  `extra-files` rules in `release-please-config.json`.
- The JSR package exports `src/cli.ts` for `deno install`. Keep the CLI guarded
  by `import.meta.main` so importing the package does not parse process args.

## Keeping docs in sync

When making changes, update:

1. **`skills/stacked-prs/SKILL.md`** if you change sub-command behavior,
   add/remove scripts, or modify CLI flags.
2. **`README.md`** (root) if you change user-facing behavior, add commands, or
   modify the workflow.
3. **This file** if you change the architecture, add scripts, or modify the git
   config schema.

## Commit types for skill changes

The `skills/` tree ships as part of the published plugin, so its contents are
user-facing artifacts, not repo documentation. Commits that add, remove, or
change `skills/**` files must use `feat:` (new behavior, new trigger phrases,
new referenced runbooks) or `fix:` (corrections to incorrect instructions,
broken flag syntax, removed-but-still-documented commands) so release-please
produces a version bump. Reserve `docs:` for files that are not shipped, such as
`README.md`, this `CLAUDE.md`, or in-repo developer notes.
