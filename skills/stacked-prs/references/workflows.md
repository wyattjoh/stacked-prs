# stacked-prs: workflows and usage guide

This reference answers "how do I use the stacked-prs skill?" with worked,
copy-pastable recipes. It covers two modes of interaction:

- **CLI mode**: you type `stacked-prs <subcommand>` directly (or
  `deno run ... cli.ts <subcommand>` when running from source). The CLI owns its
  own confirmation prompts for destructive ops and is the fastest path for users
  who know what they want.
- **Agent mode**: you ask Claude (e.g. via `/stacked-prs <sub>`). Claude follows
  the SKILL runbook, which gates every destructive op behind an explicit plan
  and a confirmation. Best when you want a second pair of eyes, help drawing
  branch boundaries, or need orchestration across multiple skill steps.

Both modes share the same CLI and git config schema; switching between them
mid-workflow is safe.

## Mental model in one paragraph

A stack is a tree of branches rooted at a base branch (usually `main`). Each
branch has exactly one parent, recorded in git config
(`branch.<name>.stack-parent`). Everything else, including the stack name, merge
strategy, and landed history, also lives in git config. The CLI and the TUI read
this config to render the stack; restack, submit, and land mutate it. No files
are added to your worktree.

## Core vocabulary

- **Root**: a branch whose parent is the base branch (e.g. parent is `main`).
- **Child / upstack**: a branch stacked on top of another stack branch.
- **Parent / downstack**: the branch you are stacked on.
- **Restack**: rebase every branch in the stack onto its (possibly updated)
  parent, preserving the tree shape.
- **Submit**: push branches and create or update their GitHub PRs so bases,
  draft state, and stack-nav comments all match the current tree.
- **Land**: after a PR merges, delete the landed branch locally and rebase
  remaining branches onto the base.

## Everyday CLI workflow

This is the loop most users run dozens of times a day.

```bash
# 1. Start a new stack from main.
git checkout main
git pull
stacked-prs create feat/login-api      # auto-inits a new stack from main
# ... edit files, commit normally ...

# 2. Add a dependent branch on top.
stacked-prs create feat/login-ui       # child of feat/login-api
# ... edit files, commit normally ...

# 3. See what you've built.
stacked-prs status                     # tree view with PR + sync status
stacked-prs status -i                  # interactive TUI across every stack

# 4. Push and open PRs with correct bases, drafts, and nav comments.
stacked-prs submit --dry-run           # preview
stacked-prs submit                     # prints plan, prompts [y/N], executes

# 5. Open the current branch's PR in the browser.
stacked-prs pr

# 6. Keep everything up to date as main advances.
stacked-prs sync --dry-run             # preview across ALL stacks
stacked-prs sync                       # fetch + restack + push across all stacks
stacked-prs sync --filter='!di*'       # skip stacks whose name matches di*
stacked-prs sync --filter='feat-*'     # only sync stacks named feat-*

# 7. After the bottom PR merges on GitHub.
stacked-prs land
```

## Agent-driven workflow (Claude)

The same loop via Claude. Claude will pull CLI plans, present them, and wait for
your `yes` before running anything destructive.

```text
you> /stacked-prs create feat/login-ui
claude> Here is the plan for creating feat/login-ui as a child of feat/login-api
        [plan]
        Proceed? (y/N)
you> y
claude> [runs cli.ts create --force]

you> /stacked-prs submit
claude> [runs submit --dry-run, shows push list, PR create/update, draft transitions,
         nav comments]
        Proceed? (y/N)
you> y
claude> [runs cli.ts submit --force, reports PR URLs]

you> /stacked-prs sync
claude> [runs sync --dry-run --json, shows per-stack plan across every stack]
        Proceed? (y/N)
you> y
claude> [runs cli.ts sync --force, reports per-stack results]
```

You can also ask open-ended questions. Claude will use `cli.ts status --json`,
`verify-refs`, and `import-discover` read-only to answer, then propose an action
if one is warranted.

## When to use CLI vs agent

| Situation                                                 | Prefer |
| --------------------------------------------------------- | ------ |
| You know exactly what you want                            | CLI    |
| You want Claude to design branch boundaries               | Agent  |
| A restack hit a conflict and you want pair-programming    | Agent  |
| Scripting in CI or a pre-commit hook                      | CLI    |
| Importing a pre-existing chain of branches                | Agent  |
| Status checks and browsing                                | Either |
| "How should I split this change?" before writing any code | Agent  |

## Recipes

### Start a new stack from a clean main

```bash
git checkout main && git pull
stacked-prs create feat/part-1        # creates the branch and registers the stack
# work and commit
stacked-prs create feat/part-2        # child branch
```

Or ask Claude: "help me start a stack for the login rewrite; first branch is an
API refactor." Claude will propose the split, the stack name, and the commands.

### Iterate on an existing stack

1. Check out any branch in the stack (or use the TUI to pick one).
2. Make commits.
3. When you're done for the day: `stacked-prs submit`.
4. When `main` moves: `stacked-prs sync`.

### Resolve a rebase conflict mid-sync

`sync` stops at the first conflicted stack. The CLI prints the failed stack name
and the recovery commands.

```bash
# Resolve files in the failed stack:
git add <resolved-files>
git rebase --continue

# Continue the stack's restack walk:
stacked-prs restack --stack-name=<failed> --resume

# Re-run sync for remaining stacks:
stacked-prs sync
```

Claude will walk you through this interactively if you run `/stacked-prs
sync`
and it hits a conflict.

### Land a merged PR

```bash
# After the bottom PR merges on GitHub:
stacked-prs land --dry-run    # shows what will be rebased/deleted
stacked-prs land              # executes
```

In the TUI, press `L` on any branch in an eligible stack (root PR merged, or all
merged). The modal plans and executes in one step with a rollback path on
failure.

### Import an existing chain of branches

If you have branches that are stacked conceptually but have no stack metadata:

```bash
# From the top branch of the chain:
stacked-prs import-discover         # JSON: shows the detected tree
# Then ask Claude to register it, or manually call the config setters.
```

Claude is the preferred path here: `/stacked-prs import`. It handles the tree
confirmation, stack name, merge strategy, and nav-comment refresh.

### Inspect a specific branch's PR

```bash
stacked-prs pr                       # opens current branch's PR
stacked-prs pr --branch feat/foo     # opens feat/foo's PR
stacked-prs pr --print               # just prints the URL
```

### Clean up after force-pushing or deleting branches outside the tool

```bash
stacked-prs clean --json       # report-only
stacked-prs clean              # prompts before applying
stacked-prs clean --force      # non-interactive apply
```

Claude can also run `/stacked-prs clean` and read the report before applying.

## Flags you will use most

- `--dry-run`: every mutating command supports this. Always safe; never prompts.
- `--force`: skip the interactive `[y/N]` prompt. Use in scripts and when you
  have already seen and approved the plan.
- `--json`: structured output for scripting or for Claude to parse.
- `--stack-name <n>`: override the stack auto-detected from the current branch.

## Safety properties to rely on

- Every write path has an inspectable dry-run mode.
- `sync` and `submit` default to interactive confirmation.
- `restack` walks per-branch and persists resume state so a conflict survives
  process death; re-invoke with `--resume`.
- `land` captures a snapshot and rolls back on failure.
- Git config is the only source of truth. No in-tree metadata files.

## When something looks wrong

1. `stacked-prs status` (or `status -i`) for a live view.
2. `stacked-prs verify-refs` to check ancestry after manual surgery.
3. `stacked-prs clean --json` to find stale config.
4. Ask Claude: describe the symptom and run `/stacked-prs status` first, and
   Claude will cross-reference verify-refs, git log, and the config to identify
   the divergence.
