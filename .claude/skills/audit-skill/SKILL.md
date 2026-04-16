---
name: audit-skill
description: >-
  Audits skills/stacked-prs/SKILL.md and its references/ files against the
  actual stacked-prs CLI and library code. Use when verifying documentation is
  in sync before a release, after renaming or adding subcommands or flags,
  after changing git-config keys, or when the user asks to "audit the skill",
  "check SKILL.md for drift", or "verify the runbook matches the code".
user-invocable: true
disable-model-invocation: true
context: fork
agent: Explore
effort: high
---

# Audit stacked-prs SKILL.md

Read-only drift check between the runbook (`skills/stacked-prs/SKILL.md` +
`skills/stacked-prs/references/`) and the real CLI in `src/`. Produce a single
structured report. Do not edit files.

## Ground truth sources (in priority order)

1. `src/cli.ts` — authoritative command + flag surface.
2. `src/commands/<name>.ts` — per-subcommand options, exit codes, behavioral
   guarantees (resume semantics, confirmation gates, dry-run vs force).
3. `src/lib/stack.ts`, `src/lib/config.ts` — authoritative git-config keys
   (reads and writes).
4. `CLAUDE.md` — schema documentation reference only, not ground truth.

If SKILL.md and CLAUDE.md disagree with code, code wins.

## Workflow

1. **Enumerate the CLI surface.** Run
   `deno run --allow-run=git,gh --allow-env
   --allow-read src/cli.ts --help`,
   then `--help` on every subcommand listed. Cross-check against
   `@cliffy/command` definitions in `src/commands/*.ts` (look for `.option(`,
   `.arguments(`, `.command(`). Record: subcommand name, every flag, each flag's
   argument shape, and whether it's required.

2. **Extract the documented surface from SKILL.md.** Find every occurrence of
   `cli.ts <cmd>`, `/stacked-prs <cmd>`, and bare command names in code fences
   or inline code. Record the same shape: subcommand, flags, argument shape.

3. **Diff (1) vs (2).** Report:
   - **Missing in docs**: commands/flags that exist in code but aren't
     documented in SKILL.md.
   - **Stale in docs**: commands/flags mentioned in SKILL.md that no longer
     exist or were renamed.
   - **Shape drift**: flag exists but argument shape differs (e.g., SKILL.md
     says `--by-commit <sha>` but code takes `--by-commit=<sha>` with a
     different value type).

4. **Behavioral-claim audit.** Scan SKILL.md for narrative claims and spot-
   check each against its command source. Non-exhaustive list of claim patterns
   to check:
   - "refuses to run without `--resume`" → `src/commands/restack.ts` resume
     state check.
   - Confirmation-gate list (push/rebase/pr create|edit|ready|comment, api
     --method PATCH) → matches the operations those commands actually invoke.
   - Tri-modal flag shape (`--dry-run` / default prompt / `--force`) for
     submit/sync → verify both commands still implement all three.
   - `sync` behavior: fetch, ff base, prune merged PRs, reparent, restack, push,
     stop at first failure → verify in `src/commands/sync.ts`.
   - `land` split into pure `planLand` + impure `executeLand` → verify in
     `src/commands/land.ts`.
   - Any "auto-migrates", "snapshot", "rollback", "resume" language → verify the
     referenced mechanism exists.

   For each claim, report **Verified**, **Drift** (with the code location that
   contradicts it), or **Unverifiable** (claim too vague to check).

5. **Git-config schema audit.**
   - Extract documented keys from SKILL.md + `CLAUDE.md` "Git config schema"
     section.
   - Grep `src/lib/**/*.ts` and `src/commands/**/*.ts` for every `git config`
     shellout and every `getConfig`/`setConfig`/`unsetConfig` call. Collect the
     set of keys actually read or written.
   - Report: keys in code but not in docs, keys in docs but not in code, and any
     key whose documented semantics (multi-value, transient, etc.) don't match
     usage.

6. **Direct-git-config smell check.** All git-config mutation must go through
   the CLI (`init`, `import`, `insert`, `move`, `fold`, `split`, `clean`,
   `land`, `restack`). Grep SKILL.md and every file under
   `skills/stacked-prs/references/` for `git config` invocations. Every hit is a
   finding: recommend replacing with the equivalent `cli.ts` subcommand.
   (Reading config via `git config` inside a troubleshooting snippet is
   acceptable if clearly marked read-only; err on the side of flagging and let
   the reviewer decide.)

7. **references/ audit.** For each file under `skills/stacked-prs/references/`,
   check every command example and behavioral claim against current code the
   same way as steps 1, 3, and 4. Flag stale flag names, removed subcommands,
   and any workflow that has been superseded by a newer CLI command.

## Report format

Emit one markdown document with these sections, in order. Omit any section whose
findings list is empty except the header "No findings." Use `path:line` anchors
for every finding.

```
# stacked-prs skill audit — <ISO date>

## 1. CLI surface drift
### Missing in docs
- `cli.ts <cmd> --flag` — introduced in src/commands/<cmd>.ts:<line>, not
  referenced in SKILL.md.

### Stale in docs
- SKILL.md:<line> references `--old-flag` which no longer exists in
  src/commands/<cmd>.ts.

### Shape drift
- ...

## 2. Behavioral claims
| Claim (SKILL.md:line) | Status | Evidence |
| --- | --- | --- |
| "refuses without --resume" (SKILL.md:123) | Verified | src/commands/restack.ts:45 |

## 3. Git-config schema
### Keys in code but not documented
- `stack.<name>.foo` — src/lib/config.ts:88

### Keys documented but not used in code
- `stack.<name>.stack-order` — SKILL.md:210

### Semantic drift
- ...

## 4. Direct git-config smells (should use CLI)
- skills/stacked-prs/SKILL.md:<line> — `git config branch.X.stack-parent Y`
  → recommend: `cli.ts move --new-parent Y`

## 5. references/ drift
- skills/stacked-prs/references/git-commands.md:<line> — ...

## Summary
- Total findings: <n>
- Highest-severity category: <name>
- Suggested next actions: <short list>
```

## Red flags

- You started editing SKILL.md during the audit. **Stop.** This skill is
  read-only. Produce a report; let the user decide what to change.
- You skipped a subcommand because "it looked fine." Audit every subcommand
  listed by `cli.ts --help`, without exception.
- You trusted `CLAUDE.md` when it disagreed with `src/`. Code is ground truth.
- The report has no `path:line` anchors. Every finding must cite a source
  location so the reviewer can jump straight to it.
