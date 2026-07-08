# Branch descriptions — design

Date: 2026-07-08

## Summary

Render an optional per-branch description on the stack-viewing surfaces
(`status`, the interactive TUI, and `serve`). The description states what the
branch is supposed to accomplish. It is stored in git's **native**
`branch.<name>.description` config key, written only with stock git tooling
(`git branch --edit-description` or `git config branch.<name>.description`),
and rendered only when present. Absent key means nothing renders anywhere.

This is a **read-only** feature in this codebase: no new CLI flags, no new
subcommand, no write helpers. The stacked-prs tooling never writes the key.

## Storage

Git's native key, not a `stack-` prefixed one:

```
branch.<name>.description   # optional, possibly multi-line; owned by git
```

Consequences of using the native key:

- Users (and Claude, per the SKILL.md note below) set and edit it with
  `git branch --edit-description <branch>` or
  `git config branch.<name>.description "..."`.
- Git deletes the whole `branch.<name>.*` config section when the branch is
  deleted, so land/clean/tombstone flows need **no changes**; descriptions
  clean themselves up. (This is the same behavior the `landed-parent`
  tombstone design already documents and works around.)
- Like all stack metadata, it is repo-local: never pushed, invisible to other
  clones. Accepted trade-off; no PR-body propagation in this design.

## Read path

### `gitConfigGetRegexp` becomes NUL-safe

Descriptions written via `--edit-description` are frequently multi-line, and
the current parser in `src/lib/stack.ts` splits `--get-regexp` output on
newlines, which corrupts multi-line values. Switch the helper to
`git config -z --get-regexp <pattern>`:

- Records are NUL-separated; within a record, the key ends at the **first
  newline** and the remainder is the (possibly multi-line) value.
- The raw stdout must not be newline-trimmed before parsing; the helper reads
  the subprocess output directly rather than a pre-trimmed string if the
  current plumbing trims.
- This is a strict upgrade for the existing `stack-*` keys (which are all
  single-line today) and keeps a single parsing path for all callers.

### Scanner and types

`readAllBranchStackConfig` (`src/lib/stack.ts`) widens its single-subprocess
scan from `^branch\..*\.stack-` to also capture the native key, e.g.
`^branch\..*\.(stack-|description)`. The per-key match regex gains a
`description` arm.

- `BranchStackEntry` gains `description?: string`.
- `StackNode` gains `description?: string`, populated in `getStackTree` for
  live branches. Tombstoned (landed) branches do not carry descriptions;
  their live config is already gone.
- A branch that has a `description` but **no** `stack-name` is not part of
  any stack; the scanner must not let such entries create phantom stack
  membership. Entries lacking `stackName` are ignored by tree construction
  exactly as today.

Every consumer (status, TUI loader, serve) inherits the field through
`getStackTree` / `getAllStackTrees`. No new git subprocesses anywhere.

## Rendering

All surfaces render **only when the description is set**. Multi-line rule:
the ladder and serve rows show the first line only; the TUI detail pane wraps
the text but caps it at 2 rows (the serve tooltip and `--json` carry the full
text).

### Non-interactive `status`

`BranchStatus` (in `src/commands/status.ts`) gains `description?: string`
(carrying the full text so `--json` consumers get everything). The ladder
today renders one line per branch (`◉ branch  #PR  sync`). A described branch
gains one **dimmed continuation line** directly beneath it, showing the first
line of the description, indented to the branch-label column. The line's
graph prefix draws a `│` rail in the branch's lane (in the stack's color) so
the ladder stays visually continuous; branches without a description render
exactly as today.

```
◯     feat/api-cache    #14 (open)   up-to-date
│       reduce upstream calls with a read-through cache
◉     feat/api-client   #13 (draft)  up-to-date
│       typed wrapper around the REST endpoints
◯   main
```

(The description lines are `dim`; rails keep their stack color. A branch with
no description, like `main` here, contributes no extra line.)

### Interactive TUI

The focused branch's description renders in the detail pane
(`src/tui/components/detail-pane.tsx`), sourced from the `StackNode` the pane
already reaches via the trees in state. It renders as dimmed row(s) after the
worktree row and before the blank separator, wrapped and **capped at 2 rows**
(ellipsis on overflow). The pane keeps its fixed `PANE_HEIGHT`; the commits
`BODY_BUDGET` shrinks by the description rows actually used, and
`CHROME_HEIGHT_BASE` in `app.tsx` stays in sync per the existing comment
contract.

```
┌──────────────────────────────────────────────────┐
│feat/api-cache  #14 ● open  up-to-date            │
│worktree  (none)                                  │
│reduce upstream calls with a read-through cache   │
│so the dashboard summary endpoint stays fast      │
│                                                  │
│a1b2c3d Add cache layer with TTL eviction         │
│d4e5f6a Wire cache into the API client            │
│↓ 3 more                                          │
└──────────────────────────────────────────────────┘
```

(Rows 3-4 are the description, dimmed. Without a description the pane is
unchanged from today.)

### `serve` web UI

`description` flows into the `/api/status` payload automatically via the
existing `stripStatusAnsi` spread of `BranchStatus`. The client
(`serve.client.js`) renders the first line as a second, smaller muted line
inside the branch row container (so it inherits the row's zebra tint and
hover behavior), indented to the branch-label column, truncated with CSS
ellipsis. The full text goes in the row's `title` attribute as a hover
tooltip. No server-side changes beyond the payload field riding along.

```
│
●   feat/api-cache        ⟨#14 open⟩  diverged
      reduce upstream calls with a read-through cache…
│
●   feat/api-client       ⟨#13 draft⟩            ✓ checked out
      typed wrapper around the REST endpoints
│
●   main
```

(Each `●`-plus-two-lines block is one `.branch-row`; the muted description
line sits under the branch name, left-aligned with it, and never pushes the
badges around. Rows without a description stay single-line.)

### `--json`

No mockup surprises: the full (possibly multi-line) text rides on each branch
entry, absent when unset.

```json
{
  "branch": "feat/api-cache",
  "syncStatus": "up-to-date",
  "description": "reduce upstream calls with a read-through cache\nso the dashboard summary endpoint stays fast",
  "pr": { "number": 14, "state": "OPEN" }
}
```

## Documentation

- **`SKILL.md`:** short note in the relevant sections that branch descriptions
  are read from native `branch.<name>.description`, and that Claude sets them
  with `git config branch.<name>.description "..."` when the user asks.
  (Config writes are metadata mutations, not confirmation-gated destructive
  ops, matching existing config-write behavior.)
- **`README.md`:** user-facing blurb: set a description with
  `git branch --edit-description`; it shows up in `status`, the TUI, and
  `serve`.
- **`CLAUDE.md`:** git-config schema section notes the native key is consumed
  (read-only) and that `gitConfigGetRegexp` is NUL-separated.

## Testing

- **`stack.ts`:** `gitConfigGetRegexp` round-trips a multi-line value via
  `-z` parsing; `readAllBranchStackConfig` captures `description`;
  `getStackTree` populates `StackNode.description`; a description on a
  non-stack branch creates no phantom membership.
- **`status.ts`:** ladder shows the dimmed first line when set and nothing
  when absent; `--json` carries the full text.
- **TUI:** detail pane renders the description for the focused branch, caps it
  at 2 rows with ellipsis, and shrinks the commits budget accordingly
  (`ink-testing-library`, destructure and call `unmount`).
- **`serve`:** `/api/status` payload includes `description` on branch entries.

Commit type: touches `skills/**` (SKILL.md), so `feat:`.
