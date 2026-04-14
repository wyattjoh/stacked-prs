# `stacked-prs create` CLI Command

## Summary

Add `cli.ts create <branch>` as a native CLI subcommand that replaces the
SKILL.md `create` runbook's mechanical work: create a new branch in a stack
off the current branch, writing the required git-config metadata and
optionally committing staged changes.

Rename the existing `cli.ts clean --confirm` flag to `--force` so destructive
CLI commands share one "skip TTY prompt" idiom; `create` adopts the same
flag.

The independent-branch judgment (when a proposed branch would leave its
parent in a CI-failing state) remains prose in SKILL.md's "Building
Review-Ready Stacks" section. It is not enforced by the CLI.

## Motivation

The SKILL.md `create` runbook currently orchestrates `git checkout -b` plus
three-to-four `git config` writes. It works, but it forces every stack
creation through an agent turn. A native CLI:

- Matches Graphite's ergonomics (`gt create <branch>` is a single command).
- Makes scripting possible (non-interactive use in shell aliases, tests,
  other tooling).
- Removes a source of drift: the agent's manual sequence vs. the
  `commands/config.ts` library vs. future callers (e.g. the TUI).

The new `--create-worktree` flag supports the user's daily driver flow
(multiple Conductor worktrees per repo) without requiring a separate
`git worktree add` step.

## CLI Surface

```
stacked-prs create <branch> [flags]

Positional
  <branch>              Branch name for the new branch. May contain slashes
                        (e.g. wyattjoh/feat/colors). Validated with
                        git check-ref-format --branch.

Flags
  -m, --message <msg>   Commit staged changes onto the new branch with
                        this message. If omitted, staged changes remain
                        staged (same as plain git checkout -b).

  --create-worktree <dir>
                        Place the new branch in a worktree at
                        <dir>/<branch>. Requires the current branch to be
                        the repo's base branch (auto-init case). Rejected
                        when creating a child off an existing stack
                        branch. On success, the current repo stays on the
                        base branch; the new branch's checkout lives in
                        the worktree.

  --stack-name <name>   Used only when auto-initing from the base branch.
                        Defaults to <branch>. Rejected when the current
                        branch is already in a stack.

  --merge-strategy <s>  "merge" (default) or "squash". Used only when
                        auto-initing. Rejected when the current branch
                        is already in a stack.

  --force               Skip the TTY confirmation prompt.

  --dry-run             Print the resolved plan; no git or config
                        mutations. Succeeds even if the plan would fail
                        at execution time for reasons only discoverable
                        during the mutation (e.g. -m with empty index).

  --json                Structured output. In dry-run mode, emits the
                        plan. On success/failure, emits the result.
```

## Behavior

The command resolves one of three cases from the current branch's state,
then runs that case's step list.

### Case 1 - Child in existing stack

Precondition: `git config branch.<current>.stack-name` is set.

Reject if `--create-worktree`, `--stack-name`, or `--merge-strategy` is
passed (flag misuse).

1. Validate `<branch>` with `git check-ref-format --branch <branch>`.
2. Check for collision with `git rev-parse --verify --quiet
   refs/heads/<branch>`.
3. Read the current branch's `stack-name` and the stack's `base-branch`.
4. If stdin is a TTY and `--force` is not set, print the plan and prompt
   `Proceed? [y/N]`. Abort on anything other than `y` / `Y`.
5. `git checkout -b <branch>` (staged + unstaged carry over).
6. If `-m <msg>`: `git commit -m <msg>`.
7. Write config via `configSetBranch`:
   - `branch.<branch>.stack-name = <stack-name>`
   - `branch.<branch>.stack-parent = <current>`

### Case 2 - Auto-init from base, in-repo

Precondition: current branch equals the repo's detected default branch and
is not in any stack. `--create-worktree` is not set.

1. Validate `<branch>` + collision check as in case 1.
2. Resolve stack name (flag or default to `<branch>`).
3. Resolve merge strategy (flag or `merge`).
4. Reject if `stack.<stack-name>.base-branch` already exists in config
   (error `stack-exists`).
5. Confirmation prompt (as in case 1).
6. `git checkout -b <branch>`.
7. If `-m <msg>`: `git commit -m <msg>`.
8. Write config:
   - `branch.<branch>.stack-name = <stack-name>`
   - `branch.<branch>.stack-parent = <base-branch>`
   - `stack.<stack-name>.base-branch = <base-branch>`
   - `stack.<stack-name>.merge-strategy = <strategy>`

### Case 3 - Auto-init + worktree

Precondition: current branch is the detected default branch and
`--create-worktree <dir>` is set.

1. Validate `<branch>` + collision check.
2. Validate that `<dir>/<branch>` does not exist.
3. Resolve stack name, merge strategy, and check `stack-exists` as in
   case 2.
4. Confirmation prompt (as in case 1).
5. If `-m <msg>` (commit-in-place then eject):
   - `git checkout -b <branch>`
   - `git commit -m <msg>`
   - `git checkout -` (return to base)
   - `git worktree add <dir>/<branch> <branch>`
6. If no `-m`:
   - `git worktree add <dir>/<branch> -b <branch>`
   - Current repo never switches away from the base.
7. Write stack + branch config (same keys as case 2).

### End-of-command state

| Case | Current repo on | New branch checkout |
|---|---|---|
| 1 (child) | new branch | current repo |
| 2 (auto-init) | new branch | current repo |
| 3 (auto-init worktree) | base branch | `<dir>/<branch>` |

## Default Branch Detection

A new helper (`detectDefaultBranch(dir)`) resolves the repo's default
branch:

1. `git symbolic-ref --short refs/remotes/origin/HEAD` - strip `origin/`
   prefix.
2. If that fails, check for local refs `refs/heads/main` then
   `refs/heads/master`; use the first one found.
3. If neither exists, return an error; the command surfaces
   `not-on-stack`.

The detection is only consulted when the current branch has no
`stack-name` config. If the current branch name matches the detected
default branch, case 2/3 applies; otherwise case 1 does not apply either,
and the command errors.

## Error Cases

All errors exit non-zero. In `--json` mode, the command emits
`{ ok: false, error: "<code>", message: "<text>" }`.

| Code | Condition | Message gist |
|---|---|---|
| `invalid-branch-name` | `git check-ref-format` rejects `<branch>` | git's stderr passed through |
| `branch-exists` | `refs/heads/<branch>` already resolves | suggest `move` or delete first |
| `not-on-stack` | Current branch neither in a stack nor equal to the detected default branch | suggest `init` or switch branch |
| `worktree-requires-base` | `--create-worktree` with current in an existing stack | explain worktree mode only applies when starting a new stack from the base branch |
| `worktree-exists` | `<dir>/<branch>` already exists | show the path |
| `flag-misuse` | Auto-init flags passed when current is in a stack | name the offending flag |
| `stack-exists` | `stack.<stack-name>.base-branch` already set | suggest a different `--stack-name` |
| `nothing-staged` | `-m` passed but `git commit` reports empty index | tell the user to stage changes |
| `git-failed` | Any other underlying `git` failure | include git's stderr |

On any error in cases 1 and 2, the pre-mutation checks prevent partial
state. Case 3 with `-m` has a multi-step sequence; if `git worktree add`
fails after the commit and `checkout -`, the command reports the error
and leaves the new branch in place. A follow-up refinement can add
rollback, but is out of scope for the initial implementation.

## Result Shape (--json)

Success:

```json
{
  "ok": true,
  "case": "child" | "auto-init" | "auto-init-worktree",
  "stackName": "<name>",
  "branch": "<new-branch>",
  "parent": "<parent-branch>",
  "baseBranch": "<base>",
  "mergeStrategy": "merge" | "squash",
  "committed": true,
  "worktree": "/abs/path/to/dir/branch"
}
```

`worktree` is present only in case 3. `mergeStrategy` is present for
auto-init cases; for case 1 it reflects the existing stack's strategy.

Dry-run:

```json
{
  "ok": true,
  "dryRun": true,
  "plan": {
    "case": "...",
    "branch": "...",
    "parent": "...",
    "baseBranch": "...",
    "stackName": "...",
    "mergeStrategy": "...",
    "willCommit": true,
    "worktreePath": "/abs/path"
  }
}
```

Failure:

```json
{
  "ok": false,
  "error": "<code>",
  "message": "<text>"
}
```

## Architecture

### New file: `src/commands/create.ts`

Exports:

```ts
export interface CreateBranchOptions {
  branch: string;
  message?: string;
  createWorktree?: string;
  stackName?: string;
  mergeStrategy?: "merge" | "squash";
  force?: boolean;
  dryRun?: boolean;
}

export type CreateCase = "child" | "auto-init" | "auto-init-worktree";

export interface CreatePlan {
  case: CreateCase;
  branch: string;
  parent: string;
  baseBranch: string;
  stackName: string;
  mergeStrategy: "merge" | "squash";
  willCommit: boolean;
  worktreePath?: string;
}

export type CreateError =
  | "invalid-branch-name"
  | "branch-exists"
  | "not-on-stack"
  | "worktree-requires-base"
  | "worktree-exists"
  | "flag-misuse"
  | "stack-exists"
  | "nothing-staged"
  | "git-failed";

export interface CreateResult {
  ok: boolean;
  plan?: CreatePlan;
  error?: CreateError;
  message?: string;
}

export function planCreate(dir: string, opts: CreateBranchOptions): Promise<CreateResult>;
export function executeCreate(dir: string, opts: CreateBranchOptions): Promise<CreateResult>;
export function create(dir: string, opts: CreateBranchOptions): Promise<CreateResult>;
```

`planCreate` is pure (reads only). `executeCreate` delegates to
`planCreate` first, then performs the side effects. `create` is the
canonical entry and routes to `planCreate` when `dryRun` is set.

The confirmation prompt is NOT inside `executeCreate`. That function
stays a pure-side-effect executor that trusts its caller. The prompt is
owned by the CLI layer in `cli.ts`, which calls `planCreate` first,
renders the plan, prompts, then calls `executeCreate` on confirmation.
This keeps the command pure-function contract intact (no I/O beyond git)
and matches how `cli.ts clean` currently handles TTY prompts.

### Helper in `src/lib/stack.ts`

```ts
export async function detectDefaultBranch(dir: string): Promise<string>;
```

Implementation described in "Default Branch Detection" above.

### CLI wiring in `src/cli.ts`

New `.command("create", ...)` registered after `status`. Handles:

- Positional `<branch>` via cliffy's `.arguments("<branch:string>")`.
- All flags listed in "CLI Surface".
- Dry-run path: call `planCreate`, print plan (text or JSON), return.
- Execute path: call `planCreate`, render plan, prompt if TTY and
  `!options.force`, call `executeCreate` on confirmation.
- Exit non-zero on `result.ok === false`.

### `--confirm` -> `--force` rename

Changes:

1. `src/cli.ts` `clean` subcommand: rename flag declaration and all
   `options.confirm` references to `options.force` (lines near 369, 378,
   451, 454 in current HEAD).
2. `skills/stacked-prs/SKILL.md` `clean` section and Scripts block:
   replace `--confirm` with `--force` (lines near 486, 489, 498, 628,
   745, 752).
3. Historical docs in `docs/superpowers/specs|plans/` referencing
   `--confirm` are frozen as history; not rewritten.

This is a breaking CLI flag change. Users who scripted
`cli.ts clean --confirm` must update to `--force`. Documented in the
release-please changelog entry.

## Testing

New test file: `src/commands/create.test.ts`. Uses `testdata/helpers.ts`
(`createTestRepo`, `addBranch`, `commitFile`) following the same pattern
as `restack.test.ts` and `land.test.ts`.

Coverage:

**Case 1 (child in existing stack)**
- Creates child off a stack branch, writes correct config.
- With `-m`, commits staged changes on the new branch.
- Without `-m`, staged changes carry over uncommitted.

**Case 2 (auto-init in-repo)**
- From `main`, creates new stack with default stack-name = branch name.
- Explicit `--stack-name` + `--merge-strategy` honored.
- Writes all four config keys (branch-level x2, stack-level x2).

**Case 3 (auto-init worktree)**
- Without `-m`: new worktree at `<dir>/<branch>`, current repo still on
  `main`, no commit on new branch beyond `main`'s tip.
- With `-m`: commit lands on new branch, current repo returns to `main`
  with unstaged changes preserved, worktree exists with new branch
  checked out.
- Branch name with slashes: worktree path `<dir>/ns/sub/branch` created.

**Errors**
- `invalid-branch-name`: e.g. `create "foo bar"`.
- `branch-exists`: pre-create the branch.
- `not-on-stack`: checkout an untracked non-base branch.
- `worktree-requires-base`: on a stack branch with `--create-worktree`.
- `flag-misuse`: `--stack-name` on a stack branch.
- `worktree-exists`: pre-create the target dir.
- `stack-exists`: pre-register a stack with the chosen name.
- `nothing-staged`: `-m` with clean index.

**Dry-run**
- No refs created, no config written, plan matches eventual execution.

**`detectDefaultBranch`**
- With `origin/HEAD` set: returns stripped name.
- Without `origin/HEAD`, `main` exists: returns `main`.
- Without either, `master` exists: returns `master`.
- Neither: throws / surfaces error.

**`--confirm` -> `--force` rename**
- `clean` tests that pass `--confirm` updated to `--force`.

## Documentation

Update `skills/stacked-prs/SKILL.md`:

- Replace the step-by-step `create` runbook with a pointer to
  `cli.ts create <branch>` and its flags. Keep the pre-create
  independent-branch reminder paragraph (it is the judgment call the
  CLI does not make).
- Add `create` to the Scripts section with full CLI invocation.
- Apply the `--confirm` -> `--force` rename for `clean`.

Update `CLAUDE.md`:

- Add `commands/create.ts` to the file layout list.
- Note the new `create` subcommand in the subcommand list.
- Update confirmation-gate summary to show `--force` instead of
  `--confirm` for `clean`.

Update `README.md`:

- `create` is visible in user-facing sub-command list. Update it and the
  `clean` mention if they reference the old `--confirm` flag.

## Out of Scope

- `--parent <branch>` flag. Use `move` to reparent after `create`.
- A `--no-checkout` flag for cases 1 and 2. Case 3 is the only workflow
  where the current repo should not switch to the new branch.
- A rollback step if a case-3 `-m` flow fails partway. Future refinement
  if the failure surfaces in practice.
- Extending `--create-worktree` to cases 1 and 2. The scoping decision
  was explicit: worktree mode only applies when starting a new stack
  from the base branch.
- Migrating `land --confirm` or any other flag. The rename is scoped to
  `clean` (the only other `--confirm` consumer).
