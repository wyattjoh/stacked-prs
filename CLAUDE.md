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
├── lib/
│   ├── stack.ts                # Core library: types, git config read/write, tree traversal
│   ├── gh.ts                   # GitHub CLI wrapper with test fixture support (GH_MOCK_DIR)
│   └── testdata/helpers.ts     # Test utilities (createTestRepo, addBranch, commitFile)
└── commands/
    ├── config.ts               # Metadata mutations (library, not a CLI subcommand)
    ├── status.ts               # Stack state + PR info
    ├── restack.ts              # Segment-based tree rebase
    ├── nav.ts                  # PR navigation comment management
    ├── verify-refs.ts          # Post-rebase branch ancestry verification
    ├── import-discover.ts      # Chain detection: walks git graph to find branch trees
    └── submit-plan.ts          # Computes full submit plan
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

# Type check, lint, fmt check
deno task check

# Invoke a CLI subcommand directly
deno run --allow-run=git,gh --allow-env --allow-read src/cli.ts status --json
```

Subcommands: `status`, `restack`, `nav`, `verify-refs`, `import-discover`,
`submit-plan`. `commands/config.ts` is a library; import its functions, do not
try to invoke it via `cli.ts`.

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

Tree traversal uses DFS (depth-first, pre-order). `restack.ts` rebases by
decomposing the tree into linear segments (fork point or root to leaf), then
rebasing each segment in topological order with `git rebase --update-refs`.
Independent sibling segments continue even when one hits a conflict.

### Script roles

| File                              | Role                                     | Invoked as                              |
| --------------------------------- | ---------------------------------------- | --------------------------------------- |
| `src/lib/stack.ts`                | Library only, not a CLI                  | Imported by all other scripts           |
| `src/lib/gh.ts`                   | Library only, not a CLI                  | Imported by scripts needing GitHub data |
| `src/commands/config.ts`          | Library functions for metadata mutations | Imported by other commands              |
| `src/commands/status.ts`          | Read stack state + PR info               | `cli.ts status [--json]`                |
| `src/commands/restack.ts`         | Segment-based tree rebase                | `cli.ts restack [--json]`               |
| `src/commands/nav.ts`             | Navigation comments                      | `cli.ts nav [--dry-run]`                |
| `src/commands/verify-refs.ts`     | Post-rebase verification                 | `cli.ts verify-refs`                    |
| `src/commands/import-discover.ts` | Branch tree detection                    | `cli.ts import-discover`                |
| `src/commands/submit-plan.ts`     | Submit planning                          | `cli.ts submit-plan`                    |

### Git config schema

```
branch.<name>.stack-name           # Which stack this branch belongs to
branch.<name>.stack-parent         # Parent branch name (or the base branch, e.g. "main")
stack.<stack-name>.merge-strategy  # "merge" or "squash"
stack.<stack-name>.base-branch     # Base branch name, e.g. "main" or "master"
```

`stack-order` is not used in the tree model; topology is derived entirely from
`stack-parent` relationships. `getStackTree` auto-migrates old configs by
removing `stack-order` keys after validating the tree.

### Testing

Tests use real git repos in temp directories (`testdata/helpers.ts` provides
`createTestRepo`). GitHub CLI calls are mocked via `gh.ts`'s fixture system: set
`GH_MOCK_DIR` or call `setMockDir()`, and `gh()` reads
`<mockDir>/<fixtureKey>.json` instead of shelling out.

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
- `lib/stack.ts` and `lib/gh.ts` are libraries. Do not add CLI entry points to
  them.
- `cli.ts` is the only CLI entry point. Do not add `import.meta.main` blocks to
  command files.
- Command functions must be pure: no `Deno.args`, no `console.log`, no
  `Deno.exit`. They receive typed options and return structured results. The CLI
  layer (`cli.ts`) owns all I/O: parsing, printing, exit codes.
- `commands/config.ts` is a library of metadata mutation functions, not a CLI
  with sub-commands. Import its functions directly.
- `commands/restack.ts` owns all rebase logic. Claude calls it via
  `cli.ts restack` rather than constructing rebase commands manually.
- When adding a new command, register it in the "Scripts" section of `SKILL.md`
  with its full `cli.ts` invocation.

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
