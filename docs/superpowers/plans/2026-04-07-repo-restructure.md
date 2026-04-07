# Repo restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoist `src/` and `deno.json` to the repo root, wire up release-please-driven CI / release automation, and bootstrap the plugin in `wyattjoh/claude-code-marketplace` — without changing any skill behavior.

**Architecture:** Physical relocation of the Deno project out of `skills/stacked-prs/scripts/` into top-level `src/`, followed by addition of `.github/workflows/{ci,release}.yml`, release-please config, and a marketplace listing PR against a sibling repo. `SKILL.md` CLI invocations are rewritten to address `${CLAUDE_PLUGIN_ROOT}/src/cli.ts`. JSR publishing is intentionally not part of this work.

**Tech Stack:** Deno 2.x, `@cliffy/command`, `googleapis/release-please-action@v4`, `wyattjoh/claude-code-marketplace@v1`, GitHub Actions.

**Reference spec:** [2026-04-07-repo-restructure-design.md](../specs/2026-04-07-repo-restructure-design.md)

**Working directory:** All commands run from the repo root
`/Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs` unless otherwise
noted.

**Conventional commits:** Use the types `chore`, `feat`, `ci`, `docs`, `refactor`, `build` appropriately. No `feat!` / breaking changes.

---

## File structure after this plan

```
stacked-prs/
├── .claude-plugin/plugin.json           (unchanged)
├── .github/workflows/
│   ├── ci.yml                           (new)
│   └── release.yml                      (new)
├── .release-please-manifest.json        (new)
├── release-please-config.json           (new)
├── CLAUDE.md                            (modified)
├── README.md                            (modified)
├── deno.json                            (moved + rewritten)
├── deno.lock                            (moved, unchanged)
├── src/                                 (new dir, content moved from skills/stacked-prs/scripts/)
│   ├── cli.ts
│   ├── lib/
│   │   ├── stack.ts, stack.test.ts
│   │   ├── gh.ts, gh.test.ts
│   │   └── testdata/helpers.ts
│   └── commands/
│       ├── config.ts, config.test.ts
│       ├── status.ts, status.test.ts
│       ├── restack.ts, restack.test.ts
│       ├── nav.ts, nav.test.ts
│       ├── verify-refs.ts, verify-refs.test.ts
│       ├── import-discover.ts, import-discover.test.ts
│       └── submit-plan.ts, submit-plan.test.ts
└── skills/stacked-prs/
    ├── SKILL.md                         (modified: CLI paths use ${CLAUDE_PLUGIN_ROOT})
    └── references/git-commands.md       (unchanged)
```

Internal relative imports inside the moved tree (`./lib/...`, `../lib/...`) stay valid because the entire directory is moved as a unit.

---

## Task 1: Relocate the Deno project to `src/`

**Files:**
- Move: `skills/stacked-prs/scripts/**` → `src/**`
- Move: `skills/stacked-prs/deno.json` → `deno.json` (will be rewritten in Task 2)
- Move: `skills/stacked-prs/deno.lock` → `deno.lock`

- [ ] **Step 1: Verify current layout matches expectations**

```bash
ls skills/stacked-prs/scripts/
ls skills/stacked-prs/scripts/lib/
ls skills/stacked-prs/scripts/commands/
ls skills/stacked-prs/scripts/lib/testdata/
```

Expected contents:
- `scripts/`: `cli.ts`, `commands/`, `lib/`
- `scripts/lib/`: `gh.ts`, `gh.test.ts`, `stack.ts`, `stack.test.ts`, `testdata/`
- `scripts/commands/`: `config.ts`, `config.test.ts`, `import-discover.ts`, `import-discover.test.ts`, `nav.ts`, `nav.test.ts`, `restack.ts`, `restack.test.ts`, `status.ts`, `status.test.ts`, `submit-plan.ts`, `submit-plan.test.ts`, `verify-refs.ts`, `verify-refs.test.ts`
- `scripts/lib/testdata/`: `helpers.ts`

- [ ] **Step 2: Move the directory tree with git mv**

```bash
git mv skills/stacked-prs/scripts src
git mv skills/stacked-prs/deno.json deno.json
git mv skills/stacked-prs/deno.lock deno.lock
```

This preserves history. Do NOT use a plain `mv`.

- [ ] **Step 3: Verify the move**

```bash
ls src/ src/lib/ src/commands/ src/lib/testdata/
test ! -d skills/stacked-prs/scripts && echo "old dir gone"
test -f deno.json && echo "deno.json at root"
test -f deno.lock && echo "deno.lock at root"
```

Expected: all three echoes print; `src/` has the same contents as the old `scripts/` directory.

- [ ] **Step 4: Confirm internal imports still resolve**

```bash
grep -rn 'from "\.' src/ | head -20
```

Expected: all imports start with `./` or `../` targeting files that still exist under `src/`. No import should reference `scripts/` or paths that no longer exist.

- [ ] **Step 5: Commit the move (without tests yet; deno.json still has old shape but is runnable)**

```bash
git add -A
git commit -m "refactor: move Deno project from skills/stacked-prs/scripts to src"
```

---

## Task 2: Rewrite root `deno.json`

**Files:**
- Modify: `deno.json`

- [ ] **Step 1: Replace contents of `deno.json`**

Overwrite `deno.json` with exactly this content:

```json
{
  "tasks": {
    "check": "deno fmt --check && deno lint && deno check src/cli.ts",
    "test": "deno test --allow-run=git,gh --allow-env --allow-read --allow-write"
  },
  "imports": {
    "@cliffy/command": "jsr:@cliffy/command@^1",
    "@std/testing": "jsr:@std/testing@^1",
    "@std/expect": "jsr:@std/expect@^1"
  },
  "fmt": {
    "exclude": ["CHANGELOG.md"]
  }
}
```

Removed from the original file: `name` (`@wyattjoh/skill-stacked-prs`), `version`, `exports`.

- [ ] **Step 2: Run the test task from the repo root**

```bash
deno task test
```

Expected: all tests pass. If you see "Module not found" errors it means the directory move in Task 1 was not clean — fix Task 1 before continuing.

- [ ] **Step 3: Run the check task**

```bash
deno task check
```

Expected: fmt, lint, and check all pass. If `deno fmt --check` fails, run `deno fmt` and re-run the check.

- [ ] **Step 4: Commit**

```bash
git add deno.json
git commit -m "build: rewrite deno.json for root layout, drop JSR fields"
```

---

## Task 3: Rewrite `SKILL.md` CLI invocations

**Files:**
- Modify: `skills/stacked-prs/SKILL.md`

The runbook currently references the CLI as `$SKILL_DIR/scripts/cli.ts` (Scripts section) and `cli.ts` (inside narrative steps). Both need updating. The new invocation form is:

```
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts <subcommand> [flags]
```

- [ ] **Step 1: Update every `$SKILL_DIR/scripts/cli.ts` reference**

In `skills/stacked-prs/SKILL.md`, replace all occurrences of
`$SKILL_DIR/scripts/cli.ts` with `${CLAUDE_PLUGIN_ROOT}/src/cli.ts`, and add
`--allow-read` to the permission list wherever `--allow-run=git,gh --allow-env`
appears in a `deno run` command. There are six such `deno run` blocks in the
Scripts section (status, restack, nav, verify-refs, import-discover,
submit-plan).

Example (status):

Before:
```
deno run --allow-run=git,gh --allow-env $SKILL_DIR/scripts/cli.ts status \
  [--stack-name=<name>] [--owner=<owner> --repo=<repo>] [--json]
```

After:
```
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts status \
  [--stack-name=<name>] [--owner=<owner> --repo=<repo>] [--json]
```

Apply the same transformation to the five other blocks.

- [ ] **Step 2: Update the intro line in the Scripts section**

Replace:
```
deno run --allow-run=git,gh --allow-env $SKILL_DIR/scripts/cli.ts <subcommand> [flags]
```

With:
```
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts <subcommand> [flags]
```

- [ ] **Step 3: Update the config operations paragraph**

In the Scripts section there is a line describing where config operations live:

> Config operations (set-branch, remove-branch, set-strategy, get, validate, land-cleanup, insert-branch, fold-branch, move-branch, split-stack) are library functions in `scripts/commands/config.ts`, not CLI subcommands.

Change `scripts/commands/config.ts` to `src/commands/config.ts`.

- [ ] **Step 4: Verify no stale path references remain**

```bash
grep -n "scripts/cli" skills/stacked-prs/SKILL.md
grep -n "\$SKILL_DIR" skills/stacked-prs/SKILL.md
grep -n "scripts/commands" skills/stacked-prs/SKILL.md
grep -n "scripts/lib" skills/stacked-prs/SKILL.md
```

Expected: all four commands return zero matches.

- [ ] **Step 5: Commit**

```bash
git add skills/stacked-prs/SKILL.md
git commit -m "docs(skill): update CLI paths to use \${CLAUDE_PLUGIN_ROOT}/src"
```

---

## Task 4: Update `CLAUDE.md` for the new layout

**Files:**
- Modify: `CLAUDE.md`

The file has three sections that reference the old layout: Layout, Commands, and the Script roles table.

- [ ] **Step 1: Replace the Layout block**

Find the fenced block that starts with `.claude-plugin/plugin.json` and ends with `references/git-commands.md`. Replace it with:

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

- [ ] **Step 2: Replace the Commands section**

Find the section that starts with `## Commands` and ends just before `## Architecture`. Replace the body (leaving the `## Commands` heading) with:

````markdown
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
````

- [ ] **Step 3: Update the Script roles table**

Find the table whose first column header is `File`. Change the `File` column entries so they reference `src/` paths:

- `lib/stack.ts` → `src/lib/stack.ts`
- `lib/gh.ts` → `src/lib/gh.ts`
- `commands/config.ts` → `src/commands/config.ts`
- `commands/status.ts` → `src/commands/status.ts`
- `commands/restack.ts` → `src/commands/restack.ts`
- `commands/nav.ts` → `src/commands/nav.ts`
- `commands/verify-refs.ts` → `src/commands/verify-refs.ts`
- `commands/import-discover.ts` → `src/commands/import-discover.ts`
- `commands/submit-plan.ts` → `src/commands/submit-plan.ts`

- [ ] **Step 4: Add a CI/Release section**

After the existing `## Development rules` section and before `## Keeping docs in sync`, insert a new section:

```markdown
## CI and releases

- **CI** (`.github/workflows/ci.yml`) runs on PRs to `main`: `deno fmt --check`,
  `deno lint`, `deno check src/cli.ts`, `deno test ...`, plus `claude plugin
  validate .` in a second job.
- **Release** (`.github/workflows/release.yml`) runs on push to `main`:
  release-please opens release PRs and tags new versions as
  `stacked-prs-v<version>`. On release, `wyattjoh/claude-code-marketplace@v1`
  updates the listing in `wyattjoh/claude-code-marketplace`.
- The only version source of truth is `.claude-plugin/plugin.json`. release-
  please bumps it via the `extra-files` rule in `release-please-config.json`.
- No JSR publishing. The skill always runs its source from
  `${CLAUDE_PLUGIN_ROOT}/src/cli.ts`, so there is no library consumer.
```

- [ ] **Step 5: Verify no stale references remain in CLAUDE.md**

```bash
grep -n "skills/stacked-prs/scripts" CLAUDE.md
grep -n "scripts/cli" CLAUDE.md
grep -n "cd skills/stacked-prs" CLAUDE.md
```

Expected: all three return zero matches.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for root src layout and new workflows"
```

---

## Task 5: Update `README.md` for the new layout

**Files:**
- Modify: `README.md`

Two blocks need updating: the "Safety guarantees" table references `cli.ts` without a path (fine as-is), and the "Helper scripts" section explicitly references `skills/stacked-prs/scripts/`.

- [ ] **Step 1: Replace the Helper scripts paragraph**

Find the paragraph under `## Helper scripts` that begins "The skill ships Deno scripts in `skills/stacked-prs/scripts/`". Replace the paragraph and the fenced `deno run` block that follows it with:

````markdown
The skill ships Deno scripts in `src/` that Claude runs for data queries and
metadata mutations. You generally do not need to run them directly, but they
can be useful for debugging. All commands go through a single entry point:

```bash
deno run --allow-run=git,gh --allow-env --allow-read \
  src/cli.ts <subcommand> [flags]
```
````

The subcommand table that follows stays unchanged.

- [ ] **Step 2: Verify no other stale references**

```bash
grep -n "skills/stacked-prs/scripts" README.md
grep -n "scripts/cli" README.md
```

Expected: zero matches.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for root src layout"
```

---

## Task 6: Add the CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/` if it does not exist and add `ci.yml`**

```bash
mkdir -p .github/workflows
```

Then write `.github/workflows/ci.yml` with exactly this content:

```yaml
name: CI

on:
  pull_request:
    branches:
      - main

jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Check formatting
        run: deno fmt --check

      - name: Lint code
        run: deno lint

      - name: Type check
        run: deno check src/cli.ts

      - name: Run tests
        run: deno test --allow-run=git,gh --allow-env --allow-read --allow-write

  validate-plugin:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6

      - name: Install Claude Code CLI
        run: npm install -g @anthropic-ai/claude-code

      - name: Validate plugin manifest
        run: claude plugin validate .
```

- [ ] **Step 2: Lint the YAML locally (soft check)**

```bash
deno fmt --check .github/workflows/ci.yml
```

Expected: this will likely be a no-op since deno does not own YAML. If it errors because yaml is unsupported, that is fine — deno fmt skips unknown files. The real validation happens when the workflow runs on GitHub.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add PR workflow running deno checks and plugin validate"
```

---

## Task 7: Add release-please configuration

**Files:**
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`

- [ ] **Step 1: Write `release-please-config.json`**

Exact content:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "package-name": "stacked-prs",
      "release-type": "simple",
      "include-component-in-tag": true,
      "component": "stacked-prs",
      "extra-files": [
        {
          "type": "json",
          "path": ".claude-plugin/plugin.json",
          "jsonpath": "$.version"
        }
      ]
    }
  }
}
```

Notes for reviewers:
- `release-type: simple` because there is no package.json or published deno.json version. `plugin.json` is the only versioned artifact.
- `include-component-in-tag: true` with `component: stacked-prs` produces tags of the form `stacked-prs-v1.0.0`, matching `op-remote` and `jmap-mcp` conventions so the marketplace action can find them.

- [ ] **Step 2: Write `.release-please-manifest.json`**

Exact content:

```json
{
  ".": "1.0.0"
}
```

The plugin is already at version `1.0.0` in `.claude-plugin/plugin.json`, so the manifest matches. The first release-please PR after this lands will then propose bumping to whatever the accumulated conventional commits warrant.

- [ ] **Step 3: Verify JSON is valid**

```bash
deno eval 'JSON.parse(Deno.readTextFileSync("release-please-config.json")); JSON.parse(Deno.readTextFileSync(".release-please-manifest.json")); console.log("ok")'
```

Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add release-please-config.json .release-please-manifest.json
git commit -m "ci: add release-please config targeting plugin.json version"
```

---

## Task 8: Add the release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write `.github/workflows/release.yml`**

Exact content:

```yaml
name: Release

on:
  push:
    branches:
      - main

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release-please:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    outputs:
      releases_created: ${{ steps.release.outputs.releases_created }}
      tag_name: ${{ steps.release.outputs.tag_name }}
      version: ${{ steps.release.outputs.version }}
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  update-marketplace:
    needs: release-please
    if: ${{ needs.release-please.outputs.releases_created == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - name: Update marketplace
        uses: wyattjoh/claude-code-marketplace@v1
        with:
          plugin-name: stacked-prs
          version: ${{ needs.release-please.outputs.version }}
          ref: ${{ needs.release-please.outputs.tag_name }}
          token: ${{ secrets.MARKETPLACE_PAT }}
```

Reviewer notes:
- No publish job. JSR publishing is explicitly out of scope per the spec.
- `MARKETPLACE_PAT` must already exist as a repo secret on `wyattjoh/stacked-prs` with `contents:write` on `wyattjoh/claude-code-marketplace`. This is the same secret used by `op-remote` and `jmap-mcp`.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): add release-please workflow with marketplace publishing"
```

**Why `feat:` and not `ci:`** — this commit needs to trigger release-please on
first run. Conventional commit types `chore`, `ci`, `docs`, `refactor`, and
`build` do not trigger a version bump under release-please's default rules, so
if every commit in this PR used those types, release-please would never open a
release PR after merge and Task 12 would have nothing to merge. Adding release
automation is a legitimate product capability (auto-updating marketplace
listings on release) and a minor bump to 1.1.0 is the right outcome.

---

## Task 9: Final local verification before opening the PR

**Files:** none (read-only verification)

- [ ] **Step 1: Clean working tree check**

```bash
git status
```

Expected: working tree clean, branch ahead of main by the commits from tasks 1-8.

- [ ] **Step 2: Re-run full Deno pipeline from scratch**

```bash
deno task check
deno task test
```

Expected: both pass with no warnings.

- [ ] **Step 3: Grep for any leftover references to the old path**

```bash
grep -rn "skills/stacked-prs/scripts" . --exclude-dir=.git --exclude-dir=docs
grep -rn "\$SKILL_DIR" . --exclude-dir=.git --exclude-dir=docs
```

Expected: both return zero matches. (The `docs/` exclusion is because the spec file itself will contain the old path as historical reference.)

- [ ] **Step 4: Verify plugin.json still validates as JSON and version is 1.0.0**

```bash
deno eval 'const m = JSON.parse(Deno.readTextFileSync(".claude-plugin/plugin.json")); console.log(m.version)'
```

Expected: prints `1.0.0`.

- [ ] **Step 5: Log summary**

```bash
git log --oneline main..HEAD
```

Expected: approximately nine commits corresponding to tasks 1 through 8.

No commit here — this task is verification only.

---

## Task 10: Open the PR against `stacked-prs`

**Files:** none (uses `gh pr create`)

- [ ] **Step 1: Push the branch**

If you are already on a feature branch, push it. If you are on `main` locally, create a branch first:

```bash
git branch --show-current
# if it prints main, first run:
#   git checkout -b chore/repo-restructure
git push -u origin HEAD
```

- [ ] **Step 2: Draft the PR title and body, present for review**

Per the user's global guidelines, do NOT run `gh pr create` without approval. Present this draft in chat:

```
Title: chore: restructure repo with root src/ layout and release automation

Body:
## Summary
- Moves the Deno project from `skills/stacked-prs/scripts/` to top-level `src/` and hoists `deno.json`/`deno.lock` to the repo root.
- Rewrites SKILL.md CLI invocations to use `${CLAUDE_PLUGIN_ROOT}/src/cli.ts` so the skill always runs the source shipped with the plugin install.
- Adds a PR CI workflow (deno fmt/lint/check/test + `claude plugin validate`).
- Adds release-please configuration targeting `plugin.json` as the single source of truth, with tags of the form `stacked-prs-v<version>`.
- Adds a release workflow that runs release-please and then calls `wyattjoh/claude-code-marketplace@v1` to update the marketplace listing.
- Updates CLAUDE.md and README.md for the new layout.

No behavioral changes to the stacked-prs skill itself.

## Test plan
- [ ] CI passes (`deno fmt --check`, `deno lint`, `deno check src/cli.ts`, `deno test ...`, `claude plugin validate .`)
- [ ] Plugin manifest still reports version 1.0.0
- [ ] After merge, confirm release-please opens a PR against `main`
```

Wait for the user to approve or tweak the title/body.

- [ ] **Step 3: Create the PR once approved**

```bash
gh pr create --title "chore: restructure repo with root src/ layout and release automation" --body "$(cat <<'EOF'
## Summary
- Moves the Deno project from `skills/stacked-prs/scripts/` to top-level `src/` and hoists `deno.json`/`deno.lock` to the repo root.
- Rewrites SKILL.md CLI invocations to use `${CLAUDE_PLUGIN_ROOT}/src/cli.ts` so the skill always runs the source shipped with the plugin install.
- Adds a PR CI workflow (deno fmt/lint/check/test + `claude plugin validate`).
- Adds release-please configuration targeting `plugin.json` as the single source of truth, with tags of the form `stacked-prs-v<version>`.
- Adds a release workflow that runs release-please and then calls `wyattjoh/claude-code-marketplace@v1` to update the marketplace listing.
- Updates CLAUDE.md and README.md for the new layout.

No behavioral changes to the stacked-prs skill itself.

## Test plan
- [ ] CI passes (deno fmt --check, deno lint, deno check src/cli.ts, deno test, claude plugin validate .)
- [ ] Plugin manifest still reports version 1.0.0
- [ ] After merge, confirm release-please opens a PR against main
EOF
)"
```

- [ ] **Step 4: Report the PR URL to the user**

`gh pr create` prints the URL on success. Share it with the user and pause until the PR is merged before moving to Task 11.

---

## Task 11: Bootstrap the marketplace listing

**Working directory:** `/Users/wyatt.johnson/Code/github.com/wyattjoh/claude-code-marketplace`

**Ordering constraint:** This task must happen AFTER Task 10's PR merges, but BEFORE the release-please PR opened by the release workflow is merged. The reason: the marketplace update action only modifies an existing entry; it will fail on the first release if the entry does not yet exist.

**Files:**
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Confirm the stacked-prs PR has merged**

```bash
cd /Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs
gh pr view --json state,mergedAt
```

Expected: `state: MERGED`.

- [ ] **Step 2: Switch to the marketplace repo and pull main**

```bash
cd /Users/wyatt.johnson/Code/github.com/wyattjoh/claude-code-marketplace
git checkout main
git pull --ff-only origin main
git checkout -b add-stacked-prs
```

**Note on the initial `ref`:** The entry below uses `stacked-prs-v1.0.0` as a
placeholder even though that tag does not yet exist (the first
release-please run in Task 12 will produce `stacked-prs-v1.1.0` because of the
`feat:` commit from Task 8). The `update-marketplace` job will overwrite both
`version` and `ref` as soon as the release PR merges, so the temporary
mismatch only lasts the few minutes between Task 11 landing and Task 12
completing. This matches how `op-remote` and `jmap-mcp` were bootstrapped.

- [ ] **Step 3: Append the stacked-prs entry to `marketplace.json`**

Add a new object to the `plugins` array in `.claude-plugin/marketplace.json`. Insert it after the last existing entry, following the formatting of the surrounding entries (two-space indent, trailing newline at end of file).

```json
{
  "name": "stacked-prs",
  "description": "Manage stacked branches and pull requests with git config metadata, Deno helper scripts, and the gh CLI.",
  "version": "1.0.0",
  "author": {
    "name": "Wyatt Johnson"
  },
  "repository": "https://github.com/wyattjoh/stacked-prs",
  "license": "MIT",
  "keywords": [
    "git",
    "github",
    "pull-requests",
    "stacked-prs",
    "rebase"
  ],
  "category": "development",
  "source": {
    "source": "github",
    "repo": "wyattjoh/stacked-prs",
    "ref": "stacked-prs-v1.0.0"
  }
}
```

- [ ] **Step 4: Validate the resulting JSON**

```bash
deno eval 'const m = JSON.parse(Deno.readTextFileSync(".claude-plugin/marketplace.json")); const entry = m.plugins.find(p => p.name === "stacked-prs"); if (!entry) throw new Error("entry missing"); console.log("ok", entry.version, entry.source.ref)'
```

Expected: prints `ok 1.0.0 stacked-prs-v1.0.0`.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/marketplace.json
git commit -m "feat: add stacked-prs plugin listing"
```

- [ ] **Step 6: Draft the PR title and body, present for review**

Do NOT create the PR without approval. Present:

```
Title: feat: add stacked-prs plugin listing

Body:
## Summary
Bootstraps the stacked-prs plugin entry in the marketplace so the release workflow's update action has an entry to modify on subsequent releases.

Source repo: https://github.com/wyattjoh/stacked-prs
Initial ref: `stacked-prs-v1.0.0`

## Test plan
- [ ] `marketplace.json` remains valid JSON
- [ ] After merge, the next release in `wyattjoh/stacked-prs` successfully updates this entry
```

- [ ] **Step 7: Create the PR once approved**

```bash
git push -u origin add-stacked-prs
gh pr create --title "feat: add stacked-prs plugin listing" --body "$(cat <<'EOF'
## Summary
Bootstraps the stacked-prs plugin entry in the marketplace so the release workflow's update action has an entry to modify on subsequent releases.

Source repo: https://github.com/wyattjoh/stacked-prs
Initial ref: stacked-prs-v1.0.0

## Test plan
- [ ] marketplace.json remains valid JSON
- [ ] After merge, the next release in wyattjoh/stacked-prs successfully updates this entry
EOF
)"
```

- [ ] **Step 8: Report the PR URL and pause**

Share the URL with the user. Wait for this PR to merge before proceeding to Task 12.

---

## Task 12: Merge the first release-please PR and verify

**Working directory:** `/Users/wyatt.johnson/Code/github.com/wyattjoh/stacked-prs`

- [ ] **Step 1: Confirm release-please has opened a PR against main**

```bash
gh pr list --search "release-please" --state open
```

Expected: one PR titled something like "chore(main): release stacked-prs 1.0.0" (or a higher version if conventional commits in this work warranted a bump).

- [ ] **Step 2: Review the release-please PR**

```bash
gh pr view <number>
```

Expected: the PR bumps `.claude-plugin/plugin.json` version and updates `CHANGELOG.md`. Confirm no unexpected files are touched.

- [ ] **Step 3: Present the merge decision to the user**

Do NOT merge without approval. Share the PR URL and wait for approval.

- [ ] **Step 4: Merge once approved**

```bash
gh pr merge <number> --squash --delete-branch
```

(Use whatever merge strategy the user prefers; `--squash` matches the default for single-commit release-please PRs.)

- [ ] **Step 5: Verify the tag exists and the marketplace update ran**

```bash
git fetch --tags origin
git tag -l "stacked-prs-v*"
gh run list --workflow release.yml --limit 5
```

Expected: a tag `stacked-prs-v<version>` exists and the most recent release workflow run shows both `release-please` and `update-marketplace` jobs succeeded.

- [ ] **Step 6: Verify the marketplace entry was updated**

```bash
cd /Users/wyatt.johnson/Code/github.com/wyattjoh/claude-code-marketplace
git pull --ff-only origin main
deno eval 'const m = JSON.parse(Deno.readTextFileSync(".claude-plugin/marketplace.json")); const e = m.plugins.find(p => p.name === "stacked-prs"); console.log(e.version, e.source.ref)'
```

Expected: prints the new version and the new tag ref. If the output still shows `1.0.0` / `stacked-prs-v1.0.0` and the release PR bumped to a higher version, investigate the `update-marketplace` job logs.

No commit in this task — the work is complete.

---

## Post-plan verification checklist

Before declaring this plan complete, run through:

1. **Repo layout matches Task 1's target:** `src/` exists at root, `skills/stacked-prs/scripts/` is gone, `deno.json` and `deno.lock` are at the root.
2. **`deno task test` passes from root** with no warnings or errors.
3. **`deno task check` passes from root.**
4. **SKILL.md has no references to `scripts/cli.ts` or `$SKILL_DIR`.**
5. **CI workflow ran successfully on the PR** (all four checks green plus plugin validate).
6. **Release workflow ran successfully** after merging the release-please PR, and produced a tag of the form `stacked-prs-v<version>`.
7. **Marketplace listing exists and is at the new version / ref.**

If any of these fail, diagnose and fix before treating the plan as done.
