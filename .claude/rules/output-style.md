---
description: CLI output conventions for human-readable (non-JSON) plan, confirmation, result, and error output
paths:
  - "src/cli.ts"
  - "src/commands/**"
alwaysApply: false
---

All human-readable output from `cli.ts` subcommands follows the style first
established by `sync`. When adding or modifying a subcommand, match these
conventions. `--json` output is not covered here; it must remain a structured
dump of the underlying result type.

The Ink-based TUI (`status -i`) is exempt: it owns stdout directly and has its
own rendering model.

## Layout primitives

- Indent level 0: section headers. Stack-scoped sections use
  `Stack: <name> (base: <base>)`. Cross-stack sections use a plain label ending
  in a colon, e.g. `Base branches:`.
- Indent level 1 (2 spaces): bulleted rows under a section.
- Indent level 2 (4 spaces): sub-rows under a bullet.
- Blank line between sibling sections. No blank line between a header and its
  first row.

## Bullet glyphs

Every level-1 row starts with a single glyph followed by a space. Pick the glyph
by state, not by command.

- `→` planned or executed action (push, rebase, retarget, create).
- `·` no-op, skip, already up to date.
- `⚠` warning (divergence, skipped base ff, stale config).
- `✓` successfully applied mutation in a result summary.
- `✗` failed step.
- `-` plain itemized action where state isn't meaningful yet (e.g. `Delete X`,
  `Retarget PR #N`).

Level-2 rows use a right-arrow-with-hook (↳) followed by a space to show a
consequence of the parent row, e.g. child reparents under a delete step or field
details under a plan row.

## Section grouping

Group like operations under a plain label followed by indented rows. The group
label sits at indent level 1 and its rows at indent level 2 (no bullet on the
rows). Only use a group when there are two or more rows; a single row belongs
inline with a bullet.

Examples of group labels currently in use: `Push (--force-with-lease):`,
`Create PRs:`, `Update PR base:`, `Flip draft state:`, `Nav comments:`,
`Commands:`, `Merged:`, `Rebase:`, `Delete:`.

## No-op messaging

A command with nothing to do prints a single declarative sentence. Use
`Nothing to do.` at the end of the sentence unless a tighter phrasing already
conveys it. Do not print an empty plan, a blank "no changes" header, or an
exit-0 with no output.

Current canonical forms (do not change; they are asserted in tests):

- `All PRs are up to date. Nothing to do.`
- `All stacks are already synced with origin. Nothing to do.`

## Result summaries

After execution, print a lead sentence that names the verb and the counts,
followed by per-item indented details when they exist. Example:

- `Fetched main. Synced 2 stack(s).`
  - `✓ stack-a: pushed feat/a, feat/b`
  - `✓ stack-b: pushed feat/c`

If a no-op path still performed hidden side effects (e.g. `sync` fetching origin
refs even when there's nothing to rebase), the no-op sentence from the plan is
sufficient on its own.

## Failure and conflict output

Failures go to stderr. Conflict-recovery blocks use the identical shape across
`restack`, `land`, and `sync` so the user's muscle memory transfers:

```
Conflict during rebase of <branch>

To resolve:
  <resolve command>
  Then: <resume command>
  Or abort: <abort command>
```

## Confirmation prompts

The shared `confirmOrExit` helper in `cli.ts` owns this path. Callers pass a
`render` function that prints the plan; the helper then prompts `Proceed? [y/N]`
and prints `Aborted.` on rejection. Do not print custom prompts from command
actions. Route them through `confirmOrExit`.

## What not to do

- Don't mix status messages with JSON output. If `--json` is set, the only
  stdout is the JSON blob.
- Don't use colons inside a single row to separate state fields. Use the glyph
  plus a double-space separator, e.g. `→ foo  onto main`.
- Don't emit emoji or multi-codepoint glyphs. The list above is the whole
  alphabet.
