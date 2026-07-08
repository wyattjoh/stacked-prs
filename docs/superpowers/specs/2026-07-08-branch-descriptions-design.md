# Branch descriptions — design

Date: 2026-07-08

## Summary

Render an optional per-branch description on the stack-viewing surfaces
(`status`, the interactive TUI, and `serve`). The description states what the
branch is supposed to accomplish. It is stored in git's **native**
`branch.<name>.description` config key, written only with stock git tooling
(`git branch --edit-description` or `git config branch.<name>.description`),
and rendered only when present. Absent key means nothing renders anywhere.

Descriptions are authored as **markdown** and rendered as markdown on every
surface (ANSI styling in the terminal, HTML in the serve UI); see the
Markdown treatment section.

This is a **read-side** feature: no write helpers, no new subcommand. The
stacked-prs tooling never writes the key. The only new CLI surface is a
`--description` flag on `status` that prints descriptions in full.

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

## Markdown treatment

Descriptions are markdown source. Rendering supports a deliberately small
subset; anything outside it falls back to plain text, never an error:

- Inline: **bold**, *italic*, `inline code`, links.
- Block: paragraphs and flat bullet lists.
- Not supported (rendered literally): headings, tables, images, nested lists,
  fenced code blocks.

One parser lives in a new `src/lib/markdown.ts` (library, no CLI mapping),
producing a minimal block/inline AST, with three renderers:

- **ANSI** (for `status`): bold/italic/dim/underline escape codes via
  `@std/fmt/colors`, links as `text (url)`.
- **Ink** (for the TUI): the same AST mapped to nested `<Text>` spans.
- **HTML** (for `serve`): rendered **server-side** into a
  `descriptionHtml` payload field, with all text nodes HTML-escaped, so the
  browser client stays parser-free and XSS-safe. The client injects it via
  `innerHTML` only from this server-rendered field.

The "first line" shown on compact surfaces is the first line of the raw
source with inline markdown applied (ANSI) or stripped to plain text (serve
collapsed row).

## Rendering

All surfaces render **only when the description is set**.

### Non-interactive `status`

`BranchStatus` (in `src/commands/status.ts`) gains `description?: string`
(the raw markdown source, so `--json` consumers get everything). The ladder
today renders one line per branch (`◉ branch  #PR  sync`). A described branch
gains one **dimmed continuation line** directly beneath it, showing the first
line of the description (inline markdown styled), indented to the
branch-label column. The line's graph prefix draws a `│` rail in the branch's
lane (in the stack's color) so the ladder stays visually continuous; branches
without a description render exactly as today.

```
◯     feat/api-cache    #14 (open)   up-to-date
│       reduce upstream calls with a read-through cache
◉     feat/api-client   #13 (draft)  up-to-date
│       typed wrapper around the REST endpoints
◯   main
```

A new `--description` flag prints descriptions **in full** instead of
first-line-only: the continuation block renders the whole markdown body
(ANSI renderer), one rail-prefixed line per rendered row:

```
◯     feat/api-cache    #14 (open)   up-to-date
│       reduce upstream calls with a read-through cache
│       so the dashboard summary endpoint stays fast:
│       • cache GET /summary for 60s
│       • invalidate on submit
◉     feat/api-client   #13 (draft)  up-to-date
│       typed wrapper around the REST endpoints
◯   main
```

(Description lines are `dim` with inline styles on top; rails keep their
stack color. A branch with no description, like `main` here, contributes no
extra line. `--description` without any set descriptions changes nothing.)

### Interactive TUI

The focused branch's description renders in the detail pane
(`src/tui/components/detail-pane.tsx`), sourced from the `StackNode` the pane
already reaches via the trees in state, markdown-rendered via the Ink
renderer. It joins the pane's **scrollable body**: the body becomes
description rows + blank separator + commit rows, all scrolled together by
the existing `detailScroll` viewport, so long descriptions are reachable
instead of capped. The pane keeps its fixed `PANE_HEIGHT` and overflow
markers (`↑ N more` / `↓ N more`) now account for description rows too.

When the detail pane is focused (via `tab`), `j` / `k` become aliases for
down / up scrolling, matching the land modal's keys (arrows keep working;
`←`/`→` still scroll horizontally). `STATUS_BAR_ITEMS` / help overlay gain
the hint for the detail-focused context.

```
┌──────────────────────────────────────────────────┐
│feat/api-cache  #14 ● open  up-to-date            │
│worktree  (none)                                  │
│reduce upstream calls with a read-through cache   │
│so the dashboard summary endpoint stays fast:     │
│  • cache GET /summary for 60s                    │
│                                                  │
│a1b2c3d Add cache layer with TTL eviction         │
│↓ 4 more                                          │
└──────────────────────────────────────────────────┘
```

(Rows 3-5 are the markdown-rendered description; `↓ 4 more` covers the
remaining body rows, scrollable with `j`/`k`. Without a description the pane
is unchanged from today.)

### `serve` web UI

The raw `description` flows into the `/api/status` payload via the existing
`stripStatusAnsi` spread of `BranchStatus`, and the server adds
`descriptionHtml` (see Markdown treatment). The client (`serve.client.js`)
renders a second, smaller muted line inside the branch row container (so it
inherits the row's zebra tint and hover behavior), indented to the
branch-label column:

- **Collapsed** (default): plain-text first line, truncated with CSS
  ellipsis.
- **Clicking the description line toggles expansion**: the row grows to full
  height and the line is replaced by the markdown-rendered `descriptionHtml`
  block. Clicking again collapses. Expansion state is per-row, client-only,
  and not persisted. The click handler sits on the description element, not
  the whole row, so PR-badge links keep working.

```
│                                        collapsed
●   feat/api-cache        ⟨#14 open⟩  diverged
      reduce upstream calls with a read-through cache…
│
●   feat/api-client       ⟨#13 draft⟩     ✓ checked out
      typed wrapper around the REST endpoints
│
●   main
```

```
│                                         expanded
●   feat/api-cache        ⟨#14 open⟩  diverged
      reduce upstream calls with a read-through cache
      so the dashboard summary endpoint stays fast:
        • cache GET /summary for 60s
        • invalidate on submit
│
●   feat/api-client       ⟨#13 draft⟩     ✓ checked out
      typed wrapper around the REST endpoints
│
●   main
```

(Each `●` block is one `.branch-row`; the description sits under the branch
name, left-aligned with it, and never pushes the badges around. Rows without
a description stay single-line. The lane rails stretch with the expanded row
height, which the rail rendering already supports via row-relative
half-segments.)

### `--json`

The raw markdown source rides on each branch entry, absent when unset; no
rendered variants in `status --json`. The serve payload additionally carries
`descriptionHtml` as described above.

```json
{
  "branch": "feat/api-cache",
  "syncStatus": "up-to-date",
  "description": "reduce upstream calls with a read-through cache\nso the dashboard summary endpoint stays fast:\n\n- cache GET /summary for 60s\n- invalidate on submit",
  "pr": { "number": 14, "state": "OPEN" }
}
```

## Documentation

- **`SKILL.md`:** short note in the relevant sections that branch descriptions
  are markdown read from native `branch.<name>.description`, and that Claude
  sets them with `git config branch.<name>.description "..."` when the user
  asks. (Config writes are metadata mutations, not confirmation-gated
  destructive ops, matching existing config-write behavior.) The `status`
  invocation gains the `--description` flag.
- **`README.md`:** user-facing blurb: descriptions are markdown, set with
  `git branch --edit-description`; they show up in `status` (full text with
  `--description`), the TUI detail pane, and `serve` (click to expand).
- **`CLAUDE.md`:** git-config schema section notes the native key is consumed
  (read-only), `gitConfigGetRegexp` is NUL-separated, and `src/lib/markdown.ts`
  joins the shared-library list.

## Testing

- **`stack.ts`:** `gitConfigGetRegexp` round-trips a multi-line value via
  `-z` parsing; `readAllBranchStackConfig` captures `description`;
  `getStackTree` populates `StackNode.description`; a description on a
  non-stack branch creates no phantom membership.
- **`markdown.ts`:** parser covers the subset (bold/italic/code/links,
  paragraphs, bullet lists) and falls back to plain text outside it; ANSI and
  HTML renderers snapshot-tested; HTML renderer escapes text nodes
  (XSS-shaped input stays inert).
- **`status.ts`:** ladder shows the dimmed first line when set and nothing
  when absent; `--description` renders the full block with rail prefixes;
  `--json` carries the raw source.
- **TUI:** detail pane renders the markdown description in the scrollable
  body; `j`/`k` scroll when the pane is focused; overflow markers count
  description rows (`ink-testing-library`, destructure and call `unmount`;
  reducer/key tests stay Ink-free where possible).
- **`serve`:** `/api/status` payload includes `description` and escaped
  `descriptionHtml` on branch entries; expand/collapse is client logic
  exercised at least via the payload contract.

Commit type: touches `skills/**` (SKILL.md), so `feat:`.
