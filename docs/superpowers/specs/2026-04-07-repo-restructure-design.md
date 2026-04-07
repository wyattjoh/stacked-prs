# Repo restructure: src/ layout, CI, and release automation

**Date:** 2026-04-07
**Status:** Approved

## Summary

Move the stacked-prs Deno source out of `skills/stacked-prs/scripts/` into a
top-level `src/` directory, hoist `deno.json` / `deno.lock` to the repo root,
and add GitHub Actions CI plus release-please-driven release automation that
publishes the plugin to `wyattjoh/claude-code-marketplace`. JSR publishing is
intentionally out of scope: the skill always runs its source from the plugin
install via `${CLAUDE_PLUGIN_ROOT}`, so a published library package has no
consumer.

## Motivation

The current layout nests the Deno project three levels deep inside
`skills/stacked-prs/scripts/`, which makes the repo root feel like a shell
around a single subdirectory. Hoisting `src/` and `deno.json` to the root makes
the repo read like a standard Deno project, simplifies tooling paths, and
matches the conventions used by sibling plugins (`op-remote`, `jmap-mcp`).

At the same time, the plugin has no release automation. Version bumps are
manual, the marketplace listing in `wyattjoh/claude-code-marketplace` does not
exist yet, and there is no CI gate on PRs. This spec addresses both in one
change since the layout move invalidates any existing script paths the
workflows would reference.

## Non-goals

- **JSR publishing.** The skill runs its own source via
  `${CLAUDE_PLUGIN_ROOT}/src/cli.ts`, so there is no external consumer for a
  `@wyattjoh/stacked-prs` JSR package. Publishing would be pure ceremony.
- **Renovate or dependency automation.** `jmap-mcp` has `deps.yml`; `op-remote`
  does not. Skipped for this repo.
- **Behavior changes to the skill itself.** The tree model, segment-based
  rebase, git config schema, and confirmation gates all stay exactly as they
  are. Only file locations and command prefixes change.

## Target layout

```
stacked-prs/
├── .claude-plugin/plugin.json
├── .github/workflows/
│   ├── ci.yml
│   └── release.yml
├── .release-please-manifest.json
├── release-please-config.json
├── CHANGELOG.md                    # created by release-please on first release
├── CLAUDE.md                       # updated for new layout
├── README.md                       # updated for new layout
├── deno.json                       # moved from skills/stacked-prs/
├── deno.lock                       # moved
├── src/                            # was skills/stacked-prs/scripts/
│   ├── cli.ts
│   ├── lib/
│   │   ├── stack.ts
│   │   ├── stack.test.ts
│   │   ├── gh.ts
│   │   ├── gh.test.ts
│   │   └── testdata/helpers.ts
│   └── commands/
│       ├── config.ts
│       ├── config.test.ts
│       ├── status.ts
│       ├── status.test.ts
│       ├── restack.ts
│       ├── restack.test.ts
│       ├── nav.ts
│       ├── nav.test.ts
│       ├── verify-refs.ts
│       ├── verify-refs.test.ts
│       ├── import-discover.ts
│       ├── import-discover.test.ts
│       ├── submit-plan.ts
│       └── submit-plan.test.ts
└── skills/stacked-prs/
    ├── SKILL.md                    # commands rewritten to use ${CLAUDE_PLUGIN_ROOT}
    └── references/git-commands.md
```

`skills/stacked-prs/deno.json`, `skills/stacked-prs/deno.lock`, and
`skills/stacked-prs/scripts/` are removed entirely. The plugin manifest, skill
runbook, and references stay inside `skills/stacked-prs/` because the Claude
Code plugin loader auto-discovers skills from that directory.

## Component changes

### `deno.json` (root)

Stripped of all JSR-related fields. The new file is a plain Deno workspace
config for a private (non-published) project:

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

No `name`, no `version`, no `exports`, no `publish` block. The `fmt.exclude`
for `CHANGELOG.md` prevents release-please's output from being reformatted on
the next `deno fmt` run.

### `skills/stacked-prs/SKILL.md`

Every CLI invocation is rewritten to address the new source location via the
plugin root environment variable. Example:

```
# before
deno run --allow-run=git,gh --allow-env scripts/cli.ts status --json

# after
deno run --allow-run=git,gh --allow-env --allow-read ${CLAUDE_PLUGIN_ROOT}/src/cli.ts status --json
```

`--allow-read` is added because Deno needs read permission on the `.ts` source
file when it lives outside the current working directory. The runbook logic
(sub-commands, confirmation gates, plan presentation) is unchanged.

### `.github/workflows/ci.yml`

Runs on pull requests to `main`. Two jobs:

```yaml
name: CI
on:
  pull_request:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno fmt --check
      - run: deno lint
      - run: deno check src/cli.ts
      - run: deno test --allow-run=git,gh --allow-env --allow-read --allow-write
  validate-plugin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: npm install -g @anthropic-ai/claude-code
      - run: claude plugin validate .
```

The `validate-plugin` job is copied from `op-remote`'s CI and catches plugin
manifest errors before release-please sees them.

### `.github/workflows/release.yml`

Runs on push to `main`. Two jobs: release-please, then marketplace update.

```yaml
name: Release
on:
  push:
    branches: [main]
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
      - uses: wyattjoh/claude-code-marketplace@v1
        with:
          plugin-name: stacked-prs
          version: ${{ needs.release-please.outputs.version }}
          ref: ${{ needs.release-please.outputs.tag_name }}
          token: ${{ secrets.MARKETPLACE_PAT }}
```

No publish job. This keeps the release pipeline minimal: release-please opens
and merges release PRs, then the marketplace action propagates the new version
to `wyattjoh/claude-code-marketplace`.

### release-please configuration

`.release-please-manifest.json`:

```json
{ ".": "1.0.0" }
```

`release-please-config.json`:

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

Notes:

- `release-type: simple` because there is no `package.json` or published
  `deno.json` version to bump. `plugin.json` is the single source of truth.
- `include-component-in-tag: true` with `component: stacked-prs` produces tags
  of the form `stacked-prs-v1.0.0`, matching the convention used by sibling
  plugins in `wyattjoh/claude-code-marketplace` (for example
  `jmap-mcp-v0.6.1`, `op-remote-v0.4.1`).
- Only `plugin.json` is listed in `extra-files`. `SKILL.md` stays version-free
  because the skill always runs against its own bundled source, so there is no
  version string embedded in the runbook to update.

### Marketplace listing

A new entry is appended to
`../claude-code-marketplace/.claude-plugin/marketplace.json` as a one-time
bootstrap. The `wyattjoh/claude-code-marketplace@v1` action handles all
subsequent version bumps automatically from the release workflow.

```json
{
  "name": "stacked-prs",
  "description": "Manage stacked branches and pull requests with git config metadata, Deno helper scripts, and the gh CLI.",
  "version": "1.0.0",
  "author": { "name": "Wyatt Johnson" },
  "repository": "https://github.com/wyattjoh/stacked-prs",
  "license": "MIT",
  "keywords": ["git", "github", "pull-requests", "stacked-prs", "rebase"],
  "category": "development",
  "source": {
    "source": "github",
    "repo": "wyattjoh/stacked-prs",
    "ref": "stacked-prs-v1.0.0"
  }
}
```

This is committed to `../claude-code-marketplace` as a separate PR, not to the
`stacked-prs` repo.

### Documentation updates

- **`CLAUDE.md`**: rewrite the Layout, Commands, and Architecture sections to
  reference `src/` instead of `skills/stacked-prs/scripts/`. Update the command
  examples to run from the repo root (no more `cd skills/stacked-prs/`). Update
  the script roles table to list `src/...` paths. Add a short note describing
  the CI and release workflows.
- **`README.md`**: update any install / usage commands that reference the old
  nested path. User-facing install instructions (adding the plugin from the
  marketplace) do not change, but any developer-oriented sections (running
  tests, type-checking) do.

## Execution order

The restructure and automation changes must land in the right order to avoid a
broken state where CI references paths that no longer exist or release-please
fires before the workflow files are in place.

1. **Move source files.** `skills/stacked-prs/scripts/*` to `src/*`,
   `skills/stacked-prs/deno.json` and `skills/stacked-prs/deno.lock` to the
   repo root. Verify `deno test` and `deno check src/cli.ts` still pass from
   the new layout.
2. **Rewrite `SKILL.md`** command invocations to use
   `${CLAUDE_PLUGIN_ROOT}/src/cli.ts` with `--allow-read`.
3. **Update `CLAUDE.md` and `README.md`** for the new layout.
4. **Add `deno.json` root config** with tasks, imports, and fmt exclusion.
5. **Add CI workflow** (`ci.yml`).
6. **Add release-please config** (`.release-please-manifest.json` and
   `release-please-config.json`).
7. **Add release workflow** (`release.yml`).
8. **Open PR against `stacked-prs`** containing all of the above. CI runs,
   validates the new layout, and the plugin validator confirms the manifest.
9. **Merge the restructure PR.** The `release.yml` workflow fires on the push
   to `main` and release-please opens its first release PR. This release PR
   does not auto-merge, so there is a safe gap before any marketplace action
   runs.
10. **Open PR against `claude-code-marketplace`** adding the `stacked-prs`
    entry shown above. Merge it. This bootstraps the marketplace listing.
11. **Merge the release-please PR.** This creates tag `stacked-prs-v1.0.0`
    and triggers `update-marketplace`, which finds the existing entry and
    updates its version and ref.

The ordering constraint is that step 10 must complete before step 11. The
marketplace action only updates an existing entry; it will fail if the
listing does not yet exist. Steps 8 and 9 are safe to run first because
release-please opens its release PR as a draft PR that waits for human
merge.

## Testing strategy

- **Local verification after the move:** `deno fmt --check`, `deno lint`,
  `deno check src/cli.ts`, and the full test suite must all pass from the repo
  root with no `cd`.
- **CI verification:** the `ci.yml` workflow runs the same four commands plus
  `claude plugin validate .`. First PR exercises the whole pipeline.
- **Release dry-run:** before merging, inspect the release-please PR on GitHub
  to confirm it bumps `plugin.json` to `1.0.0` and produces the tag
  `stacked-prs-v1.0.0`.
- **Marketplace action:** on the first successful release, confirm a commit
  lands in `wyattjoh/claude-code-marketplace` updating the `stacked-prs` entry
  version and ref.

## Risks and mitigations

- **Broken skill paths during the move.** Any missed reference to
  `scripts/cli.ts` would silently break the runbook. Mitigation: grep for
  `scripts/cli.ts` and `skills/stacked-prs/scripts` across the entire repo
  before committing.
- **Marketplace action fails on first run.** If step 10 is skipped or the
  marketplace entry has a typo, the first release job errors. Mitigation:
  sequence the marketplace PR before the release-please PR merge; re-running
  the release job after fixing the entry is idempotent.
- **`--allow-read` scope.** Adding `--allow-read` without a path grants full
  read access. Mitigation: the skill already runs inside user-owned git
  repositories and needs to read arbitrary source files; this matches the
  posture of the existing `--allow-run=git,gh` grants. Not tightening.
- **`release-type: simple` producing no changelog entries.** Verified against
  release-please docs: simple type still generates a `CHANGELOG.md` from
  Conventional Commits. No mitigation needed.
