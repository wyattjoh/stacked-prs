# Serve: per-stack latest-commit relative time

## Goal

In the `serve` browser view, show how long ago the most recent commit on a stack
was made, rendered in a muted color next to the stack's name. Example: `2 days
ago`.

## Decisions (confirmed)

- **Format:** `"<n> <unit> ago"` (e.g. `2 days ago`, `3 hours ago`, `5 minutes
  ago`), with `just now` for very recent commits. Singular/plural handled
  (`1 day ago`).
- **Scope:** both serve views.
  - All-stacks overview: on the stack-name row.
  - Single-stack lane view: on each repo's header row (the closest analog; that
    view has no dedicated stack-name row).
- **Definition of "most recent commit on the stack":** the maximum committer
  date across the stack's branches, including landed branches where their refs
  still exist. Because `land` deletes branches, a fully-landed branch usually
  contributes no ref and no date; this degrades gracefully (the ref is skipped).
  The base branch is excluded (only the stack's own branches count).

## Key structural insight

Both views render **per-repo-per-stack** rows:

- The all-stacks overview groups by repo, so each stack appears once per repo
  section, keyed on `g.repo` (`g.repo.branches`).
- The single-stack view renders one section per repo.

The server already builds one `StackStatus` per stack per repo. So neither row
needs a cross-repo "max" computation: each row maps to exactly one repo's copy
of the stack, and reads that copy's latest-commit timestamp directly.

## Implementation

### 1. Server: compute `latestCommitAt` per stack

File: `src/commands/status.ts`.

- Add `latestCommitAt: string | null` (ISO 8601, e.g. `2026-06-25T14:03:11Z`) to
  the `StackStatus` interface.
- In `buildStackStatus`, after `getAllNodes(tree)` (which includes landed/
  tombstone nodes), collect the branch names and run a single
  `git for-each-ref --format='%(committerdate:unix)' refs/heads/<b1>
  refs/heads/<b2> ...` over those refs. Parse the unix timestamps, take the max,
  convert to an ISO string. Refs that do not exist (deleted landed branches)
  produce no line and are skipped.
- Empty branch list, or all refs missing → `latestCommitAt: null`.
- Prefer a small helper (e.g. `getLatestCommitDate(dir, branches)`) in
  `src/lib/stack.ts` returning `string | null`, so the git call lives next to the
  other git helpers and is unit-testable. `buildStackStatus` calls it.

This field flows into `ServeStackStatus` and the serve JSON payload automatically
via the existing object spread in `stripStatusAnsi` (`src/commands/serve.ts`).

### 2. Client: carry the timestamp onto each repo entry

File: `src/commands/serve.client.js`, `buildModel` (~line 182).

- Add `latestCommitAt: stack.latestCommitAt` to the per-repo object pushed into
  each stack group's `repos` array.

### 3. Client: relative-time helper

File: `src/commands/serve.client.js`.

- Add `formatRelativeTime(iso)`:
  - `null`/empty → `""`.
  - `< 45s` → `just now`.
  - else pick the largest fitting unit (minute, hour, day, week, month, year)
    and render `"<n> <unit> ago"`, with singular/plural.
- Computed against the browser's current time at render, so it stays roughly
  current and refreshes on every live-watch re-render. No separate ticking timer.

### 4. All-stacks view

File: `src/commands/serve.client.js` (stack-name row, ~lines 697-708).

- Insert a muted `<span>` between the stack-name span and the flex divider line.
  Row reads: `[name]  [2 days ago]  ────  [N branches]`.
- Style matches existing muted text: `font:500 10px ${MONO};color:#586069;`.
- Skip the span (or render nothing) when `latestCommitAt` is `null`.

### 5. Single-stack view

File: `src/commands/serve.client.js` (repo header, ~lines 600-603).

- Append a muted `<span>` after the `"owner/repo · N stacked"` span. Reads:
  `repo-name   owner/repo · 3 stacked · 2 days ago`.
- Skip when `latestCommitAt` is `null`.

## Testing

- Server-side test (`src/commands/status.test.ts` or `src/lib/stack.test.ts`):
  - A stack with commits → `latestCommitAt` is populated and equals the max
    committer date across its branches.
  - A stack whose branches have no live refs → `latestCommitAt` is `null`.
- The relative-time formatter lives in the vanilla browser `serve.client.js`,
  which is not unit-tested by repo convention (read at runtime, no Deno import).

## Docs to update

- `CLAUDE.md`: serve paragraph (mention per-stack latest-commit time and the
  `latestCommitAt` field).
- `README.md`: serve section, if it describes the row contents.
- `skills/stacked-prs/SKILL.md`: serve entry, if it describes the rendered rows.

## Out of scope

- No ticking/auto-refreshing timer (relies on live-watch re-renders).
- No cross-repo aggregation in the switcher or summary.
- No new overall stack-name header in the single-stack view.
