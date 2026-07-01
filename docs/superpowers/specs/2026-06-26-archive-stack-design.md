# Archive a stack — design

Date: 2026-06-26

## Summary

Add the ability to mark a stack as **archived**. An archived stack retains all
of its git-config metadata but is hidden by default from the stack-viewing
surfaces (`status`, the interactive TUI, and `serve`) and is skipped by the
bulk `sync` operation. Each surface offers a way to reveal archived stacks:
`--archived` on the CLI, an `a` toggle key in the TUI, and a "Show archived"
switch in the serve web UI.

Archiving means "stop sweeping this up in bulk." It never changes what an
explicit, single-stack operation does.

## Storage

A new stack-level git-config key, mirroring the existing
`stack.<name>.merge-strategy` / `base-branch` / `color` keys:

```
stack.<stack-name>.archived   # "true" when archived; key absent otherwise
```

- Archiving sets the key to `"true"`.
- Unarchiving **unsets** the key (absent = not archived) to keep config clean.

New helpers in `src/lib/stack.ts`:

- `getStackArchived(dir, stackName): Promise<boolean>` — reads the key, returns
  `true` only when the value is exactly `"true"`.
- `setStackArchived(dir, stackName, archived): Promise<void>` — sets the key to
  `"true"` when `archived`, unsets it otherwise.

`StackTree` gains an `archived: boolean` field, populated inside `getStackTree`
(alongside `mergeStrategy` / `baseBranch`). Every consumer
(`getAllStackTrees`, `getAllStackStatuses`, status, serve, TUI) inherits the
flag from this single source.

`clearStackConfig` (full stack teardown) must also remove the `archived` key so
no orphan config is left behind.

## The `archive` command

New file `src/commands/archive.ts`, following the command contract: a pure
function taking typed options and returning a structured result. No `Deno.args`,
no `console.log`, no `Deno.exit`. `cli.ts` owns parsing, printing, and exit
codes.

```
cli.ts archive [<stack>] [--unarchive] [--json]
```

- **No `<stack>` arg:** resolve the current branch's stack the same way
  `getStackTree` does (current branch → `branch.<name>.stack-name`). Error if
  the current branch is not part of a stack.
- **`<stack>` arg:** archive that named stack. Error if the name is not a known
  stack (validate against `listAllStacks`).
- **`--unarchive`:** clear the flag instead of setting it.
- **Idempotent:** archiving an already-archived stack (or unarchiving a
  non-archived one) is a no-op success.

Result type carries at least: `stackName`, `archived` (the new state), and
`changed` (whether a write occurred).

CLI output follows `.claude/rules/output-style.md`:

- `✓ Archived stack <name>.`
- `✓ Unarchived stack <name>.`
- `· Stack <name> is already archived.` (no-op)
- `· Stack <name> is not archived.` (no-op unarchive)

This is a config read plus a single config write. It is **not** a
confirmation-gated destructive operation (no `git push`, `rebase`,
`branch -d`, or `gh` mutation), so it runs without a `[y/N]` gate.

Registered in `cli.ts` and documented in `SKILL.md`'s Scripts section.

## Behavior boundary

**Archiving only affects stack enumeration and display. It never changes what
an explicit, single-stack operation does.**

- **`sync`** (iterates `getAllStackTrees`): skips archived stacks. The skip is
  visible in the plan output, e.g. `· <name>: skipped (archived)`, rather than
  silently dropped. A `--archived` flag on `sync` force-includes archived
  stacks for symmetry with `status`.
- **`status` / TUI / `serve`:** hide archived by default, reveal on demand (see
  next section).
- **Everything else is unchanged:** `submit`, `restack`, `land`, `nav`,
  `move`, `fold`, `split`, `insert`, `create`, `pr` operate on an explicitly
  named or current-branch stack and work regardless of archive state.
- **`clean`** still processes archived stacks; stale-config cleanup is
  maintenance that should apply regardless of archive state.

## Viewing surfaces

### Non-interactive `status`

- Add a `--archived` flag. Default hides archived stacks; `--archived` shows
  all. Filtering happens in the `cli.ts` / command presentation layer (the data
  layer continues to load everything).
- `--json` **always** includes all stacks; each `StackStatus` carries
  `archived: boolean` so JSON consumers filter themselves.
- When archived stacks are shown, the header gets an `(archived)` marker:
  `Stack: <name> (base: main) (archived)`.

### Interactive TUI (`status -i`)

- Hides archived stacks by default. `status -i --archived` starts with them
  shown.
- New `a` key toggles archived visibility live. Added to `STATUS_BAR_ITEMS` and
  the help overlay.
- The toggle flows through the pure reducer as a new action plus a
  `showArchived` boolean in state, keeping it unit-testable without Ink. Layout
  filters stacks on that flag.
- When shown, archived stacks render dimmed with an `(archived)` tag.

### `serve` web UI

- The server **always** includes archived stacks in the `/api/status` payload,
  each marked `archived: true`, so toggling needs no refetch.
- The client hides archived stacks by default and adds a header
  checkbox/switch labeled "Show archived".
- Archived stacks appear dimmed with an `(archived)` badge in the stack
  switcher and the lanes.
- Toggle state is client-side and persisted in `localStorage` so reloads keep
  the preference. It is kept out of the URL, which already encodes stack
  selection.

## Testing

- **`stack.ts`:** `getStackArchived` / `setStackArchived` round-trip;
  `getStackTree` populates `archived` (real temp repo). `clearStackConfig`
  removes the key.
- **`archive.ts`:** archive/unarchive by name and by current branch; idempotent
  no-op paths; unknown-stack error.
- **`sync.ts`:** archived stacks skipped in the plan; `--archived` re-includes
  them.
- **`status.ts`:** archived hidden by default; shown with `--archived` with the
  `(archived)` marker; `--json` always includes them carrying the flag.
- **TUI reducer:** `a` toggles `showArchived`; layout filters accordingly (pure
  tests, no Ink).
- **`serve`:** `/api/status` marks archived stacks; client filtering covered by
  existing serve test patterns where feasible.

## Documentation

- **`SKILL.md`:** new `archive` command, `--archived` on `status` and `sync`.
- **`README.md`:** user-facing archive workflow.
- **`CLAUDE.md`:** git-config schema gains `stack.<name>.archived`; command
  table entry for `archive`; serve / sync / status behavior notes.

Commit type: changes touch `skills/**`, so `feat:`.
