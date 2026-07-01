# Serve progressive repository loading

## Problem

`stacked-prs serve` loads every repository's stack status in parallel
(`Promise.all` over `loadRepositoryStatus` in `src/commands/serve.ts`), but
delivery is all-or-nothing: the `/api/status` route awaits the entire batch and
returns one JSON blob. The browser client paints a static
`"Loading repositories..."` string and blocks on that single `fetch` until the
slowest repository finishes. There is no per-repository feedback, and the
slowest repo gates the whole page.

The loading *work* is already parallel; what is missing is an incremental
channel from server to client so the UI can show progress.

## Goals

- Show a per-repository loading list with live states
  (`queued -> loading -> done | error`).
- Keep the main stack view unchanged: show the progress screen until every repo
  settles, then swap to the full view in one transition (no progressive reveal,
  no mid-load reflow).
- Cap concurrency so the `queued` state is meaningful and so large repo sets do
  not fire dozens of simultaneous `gh pr list` calls.

## Non-goals

- Progressive reveal of stacks as each repo arrives.
- Changing `serve` CLI flags or invocation.
- Reworking the stack-view rendering, the repo filter, or sessionStorage view
  state.

## Approach

Server-Sent Events (SSE). A new `/api/status/stream` route emits an `init` event
(the full repo list), then `repo-start` / `repo-done` / `repo-error` events as a
concurrency-capped worker pool processes each repository, then a final
`complete` event carrying the same payload shape `/api/status` returns today. The
browser uses native `EventSource`.

SSE is the idiomatic fit for one-way server->client streaming, Hono ships
`streamSSE`, and `EventSource` keeps the client trivial. NDJSON-over-`fetch`
(manual buffering/line-splitting) and polling-with-server-job-state (job
lifecycle, cleanup) were considered and rejected as more code for no gain here.

## Data flow

1. Page loads; client opens `EventSource("/api/status/stream")`.
2. Server emits `init` with the full requested repo list; client paints every
   repo as a `queued` row immediately.
3. A concurrency-capped worker pool processes repos. Per repo it emits
   `repo-start`, then `repo-done` (or `repo-error`).
4. When all repos settle, the server applies the existing "only repos with
   stacks" filter, computes `sharedStacks`, and emits `complete` with the
   payload.
5. Client closes the `EventSource` on `complete`, builds its model, reconciles
   sessionStorage view state, and swaps the progress screen for the full stack
   view.

## Server changes (`src/commands/serve.ts`)

### Worker pool

New `loadRepositoryStatuses(repositories, opts)` mirroring `loadPrsProgressive`
(`src/tui/state/loader.ts:109`):

- Runs `loadRepositoryStatus` across `opts.concurrency` workers pulling from a
  shared index.
- Fires `opts.onStart(path)` before a repo begins and `opts.onSettled(result)`
  when it resolves.
- Returns `ServeRepositoryStatus[]` in input order (results written by index).

Constant `LOAD_CONCURRENCY = 6`.

`loadRepositoryStatus` already catches its own errors and returns an `error`
field rather than throwing, so the pool never needs a try/catch; `onSettled`
inspects `result.error` to choose the done vs error event.

### Shared finalize helper

Extract `finalizeServeStatus(statuses): ServeStatusPayload` containing the
current `renderedRepositories` filter (`status.stacks.length > 0`) plus
`buildServeSharedStackGroups`. Used by both routes.

### Refactor `buildServeStatus`

`buildServeStatus(repositories)` calls `loadRepositoryStatuses` with default
(no-op) callbacks and `LOAD_CONCURRENCY`, then `finalizeServeStatus`. Its
signature and return type are unchanged, so the existing `/api/status` route and
its tests keep working. (This also gives `/api/status` the concurrency cap for
free.)

### New stream route

`app.get("/api/status/stream", ...)` using `streamSSE` from `hono/streaming`:

1. Emit `init` with `{ repositories: repositories.map(({name, path}) => ...) }`.
2. Call `loadRepositoryStatuses` with callbacks that emit `repo-start {path}`
   and, on settle, `repo-error {path, message}` when `result.error` else
   `repo-done {path, hasStacks}` (`hasStacks` = `result.status.stacks.length >
   0`).
3. After the pool resolves, emit `complete` with
   `{ rootDir, ...finalizeServeStatus(statuses) }`.

`/api/status` stays as-is for backward compatibility and existing tests.

### Event shapes (named SSE events, JSON `data`)

- `init`: `{ repositories: [{ name, path }] }`
- `repo-start`: `{ path }`
- `repo-done`: `{ path, hasStacks: boolean }`
- `repo-error`: `{ path, message: string }`
- `complete`: `{ rootDir, repositories, sharedStacks }`

Repositories are identified by the unique `path` (never the basename `name`),
consistent with the repo filter.

## Client changes (`src/commands/serve.client.js`)

- Replace the single `fetch` in `loadStatus()` with an `EventSource` flow and a
  `loadState` Map (`path -> "queued" | "loading" | "done" | "error"`), plus a
  per-path error message map for error rows.
- New `renderLoading()`: a header (`Loading N repositories`) with a progress
  count / bar, and one row per repo (name + state badge): `queued` gray,
  `loading` pulsing accent dot/spinner, `done` green check, `error` red with the
  message. Re-rendered on each event.
- On `complete`: run the existing `buildModel` + sessionStorage reconciliation
  (selected stack key `stacked-prs:selected-stack`; repo filter key
  `stacked-prs:selected-repos`) exactly as today, then call `render()` to swap in
  the real view.
- Close the `EventSource` on `complete`. On `onerror` before completion, show the
  error (matching today's catch). Closing on complete prevents `EventSource`
  auto-reconnect from re-running the load.

## Styling (`src/commands/serve.css`)

Add a spinner/pulse keyframe and a `.repo-load-row` rule (CSS animations require
the stylesheet). Everything else stays inline like the rest of the client,
matching the dark theme, MONO font, and existing badge styling.

## Testing

- `src/commands/serve.test.ts`:
  - `loadRepositoryStatuses`: callbacks fire (`onStart` before `onSettled` per
    repo), results returned in input order, concurrency respected (no more than
    `concurrency` in flight at once).
  - `/api/status/stream`: read the streamed response against a temp repo and
    assert `init` and `complete` events appear in the body.
  - Keep the existing `/api/status` test.
- The browser client has no unit harness today; `getServeHtmlForTest` only checks
  document rendering. No client-side tests are added, matching current state.

## Docs

- Update the `serve` sections of `CLAUDE.md` and `README.md` to note the
  streaming load and concurrency cap.
- SKILL.md is untouched (no flag/invocation changes).
- Commit type `feat(serve): ...` (these files live under `src/`, not `skills/`).
</content>
</invoke>
