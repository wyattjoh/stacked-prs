# Serve live watch + PR polling

Date: 2026-06-27
Status: Approved

## Problem

`stacked-prs serve` renders a read-only browser view of one or more
repositories' stacks. Today the data is loaded once at page load (over the
`/api/status/stream` SSE route, which ends with a terminal `complete` event) and
only refreshes on a full browser reload. When a stack changes locally (commit,
rebase, branch create, stack-metadata edit) or a PR changes on GitHub, the user
must manually reload to see it.

## Goal

Make the served view live:

- Watch each served repository's `.git` for stack-relevant changes and push an
  optimistic per-repository data update to the browser.
- Poll the GitHub API on an interval so PR badges (open/draft/merged/closed,
  numbers, URLs) go live too, since a filesystem watcher cannot observe GitHub
  state.
- On each update, apply the new data immediately and show a transient toast
  naming the repository that changed.

## Non-goals

- No change to the initial progressive-load contract (`/api/status/stream` keeps
  emitting `init` / `repo-start` / `repo-done` / `repo-error` / `complete`).
- No change to the buffered `/api/status` route.
- The view stays read-only; no write paths are added.
- No persistent connection-status indicator (toast only).

## Approach (selected: A)

A new long-lived SSE route `/api/watch` on the existing Hono app. The client
opens it as a second `EventSource` after the initial load completes. The route
never sends a terminal event; it stays open until the client disconnects. Two
trigger sources funnel into a single "reload one repository, emit
`repo-updated`" path:

1. Filesystem watch (`Deno.watchFs`) per repository, debounced.
2. A PR-poll interval timer that re-triggers the reload path for GitHub repos.

Rejected alternatives:

- **B (one stream):** fold live updates into `/api/status/stream` by never
  ending it. Conflates initial-load progress with live updates and complicates
  the client loading screen.
- **C (client polling):** client re-fetches `/api/status` on a timer. Cannot
  react promptly to local git changes, re-runs all repos every tick, wastes work
  when idle.

## Server design

### Route

```
GET /api/watch
  → event: ready          data: {}                            (watchers + timer attached)
  → event: repo-updated   data: <ServeRepositoryStatus JSON>
```

The `ready` event is emitted once after all per-repository watchers and the poll
timer are attached, so a consumer knows the channel is live (used by tests to
avoid a setup race, and available for a future connection indicator). The client
ignores it beyond confirming the connection.

`createServeApp(rootDir, repositories, watch)` gains a `watch` config:

```ts
interface ServeWatchConfig {
  enabled: boolean;        // false => route not registered
  pollIntervalMs: number;  // 0 => PR polling disabled, fs watch still runs
}
```

When `watch.enabled` is false, the `/api/watch` route is not registered (the
client also will not open it; see Client design).

### Reload path

A single per-connection helper reloads one repository and emits it:

- Calls the existing `loadRepositoryStatus(repo)` (already captures its own
  errors and returns an `error` field; never throws).
- Writes `event: repo-updated` with the full `ServeRepositoryStatus` JSON
  (including the `error` field when the reload failed; a failed reload does not
  tear down the channel).
- A per-repository guard prevents overlapping reloads: a `reloading` flag plus a
  `pending` flag. If triggers arrive while a reload is in flight, exactly one
  more reload runs afterward (coalescing bursts).

The `repo-updated` payload carries a single `ServeRepositoryStatus`. The client
derives its own stack grouping and shared-stack groups, so the server does not
recompute `sharedStacks` for incremental updates.

### Trigger 1: filesystem watch

Per repository, resolve the git directories once at connection start:

- `git rev-parse --git-dir` (the repo's own git dir; for a linked worktree this
  is `<main>/.git/worktrees/<name>`).
- `git rev-parse --git-common-dir` (shared dir holding `refs/`, `packed-refs`,
  and `config`).

Both are resolved relative to the repository path and normalized to absolute
paths. A helper `resolveGitWatchPaths(dir)` returns the deduplicated list of absolute
git-dir paths to watch: the `git-common-dir` (holds `config`, `packed-refs`,
`refs/`) and, when different, the `git-dir` (holds the worktree's `HEAD`). Only
paths that exist on disk are returned; a repo whose git dir cannot be resolved
is not watched (PR polling still applies if it has a remote).

`Deno.watchFs` recurses into a watched directory, so watching the common git dir
captures top-level files (`config`, `packed-refs`, `HEAD`, `ORIG_HEAD`), the
`refs/` subtree, and the heavy `objects/` tree all at once. Rather than
enumerate many subpaths that may or may not exist, we watch the one or two git
dirs wholesale and discard noisy events with the relevance filter below. This
keeps the watcher set small (one or two `Deno.FsWatcher` per repo) and pushes
all noise handling into a single pure predicate.

A pure predicate decides relevance:

```ts
function isRelevantGitChange(path: string): boolean
```

Relevant when the path (anywhere under a watched git dir) is:

- exactly `config`, `packed-refs`, `HEAD`, or `ORIG_HEAD` at a git-dir root, or
- under a `refs/` segment.

Ignored: anything under `objects/`, `index`, `*.lock`, `FETCH_HEAD`,
`COMMIT_EDITMSG`, and other transient files. The predicate matches on path
segments (using `/` and the platform separator) so it is OS-agnostic.

Events passing the filter are debounced per repository (~300ms) before
triggering the reload path.

### Trigger 2: PR poll timer

When `pollIntervalMs > 0`, a single interval timer fires every
`pollIntervalMs`. On each tick it triggers the reload path for every repository
that has a resolved GitHub remote (`repo.github != null`, determined from the
last reload, or probed once at start). Local-only repositories are not polled;
their local changes are caught by the filesystem watch. PR polling reuses the
same reload path, so it also refreshes local git state for those repos.

### Lifecycle / cleanup

Each `/api/watch` connection owns its `Deno.FsWatcher` instances and interval
timer. On stream abort (tab closed, navigation) the route's `finally` block (and
`stream.onAbort`) closes every watcher and clears the interval, so nothing
leaks. For a local single-user tool, one or two concurrent connections is the
expected load; each connection's watchers are independent.

## Client design

State additions in `serve.client.js`:

- A `Map<path, ServeRepositoryStatus>` (`reposByPath`) holding the raw payload
  repositories, populated from the initial `complete` payload.
- A `toast(message)` helper that appends an auto-dismissing toast element
  (~3s) to a fixed-position container; multiple toasts stack.

After `applyPayload` runs on `complete`, if `window.__STACKED_PRS__?.watch` is
true, open `new EventSource("/api/watch")` and handle `repo-updated`:

1. Parse the `ServeRepositoryStatus`.
2. Upsert into `reposByPath` by `path` when it has at least one stack; delete the
   entry when it has zero stacks (mirrors the server's has-stacks filter so a
   repo gaining its first stack appears and one losing its last drops out).
3. Rebuild the model from `[...reposByPath.values()]` via the existing
   `buildModel` + `allRepos` derivation, preserving:
   - `state.selectedRepos`: keep current selection intersected with present
     paths; auto-add newly appeared paths so new repos are visible by default.
   - `state.selectedId`: keep unless it now names a stack that no longer exists,
     in which case reset to all-stacks (same rule as `applyPayload`).
   - `state.showArchived` and dropdown open/closed flags: untouched.
4. `render()`.
5. `toast(`${repo.name} updated`)`.

`EventSource` auto-reconnects on a dropped connection; no manual reconnect
logic. The watch channel is purely additive: if it never connects, the page
still works exactly as today.

### Config injection

`renderServeDocument(watchEnabled)` inlines a config global before the client
script:

```html
<script>window.__STACKED_PRS__ = { watch: true };</script>
```

Only the boolean is exposed; the poll cadence stays server-side.

## CLI

Two new options on `serve`, matching the existing option style:

- `--no-watch` — disables the live channel entirely (route not registered,
  client global set to `{ watch: false }`).
- `--poll-interval <seconds>` (default `60`; `0` disables PR polling while
  keeping the filesystem watch).

`startServeServer` / `ServeServerOptions` gain a `watch: ServeWatchConfig`
field; `cli.ts` builds it from the flags.

## Testing

- Pure unit: `isRelevantGitChange` (refs/config/HEAD/ORIG_HEAD react;
  objects/index/`*.lock`/FETCH_HEAD ignored).
- Resolution: `resolveGitWatchPaths` against a real temp repo returns the git
  dir; verifies a linked worktree includes both the worktree and common dirs.
- Integration (route): drive `app.request` against `/api/watch` with a real temp
  repo, wait for the `ready` event, mutate a ref, and assert a `repo-updated`
  event arrives carrying that repo's path; abort the request to tear the stream
  down (watchers closed, no leaks).
- `--no-watch`: assert `/api/watch` is not registered (404) and the document
  global is `{ watch: false }`.
- Existing serve tests remain green.

## Docs to update

- `CLAUDE.md`: serve architecture paragraph (add the watch channel, triggers,
  cleanup) and the serve dev-rules bullet (new route, new flags, config global).
- `skills/stacked-prs/SKILL.md`: serve entry (new flags). Commit as `feat:`
  because `skills/**` ships in the plugin.
- `README.md`: serve section (live updates, `--no-watch`, `--poll-interval`).
