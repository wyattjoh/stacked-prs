# Serve Progressive Repository Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream per-repository load progress to the `serve` browser UI so the page shows a live `queued -> loading -> done | error` list, then swaps to the full stack view once every repository settles.

**Architecture:** Add a concurrency-capped worker pool in `serve.ts` that loads repositories and fires progress callbacks. Expose a new `/api/status/stream` Server-Sent Events route that emits `init`, `repo-start`, `repo-done`/`repo-error`, and a final `complete` event. The browser client consumes it with `EventSource`, renders a progress screen, and swaps to the existing stack view on `complete`. The existing `/api/status` route stays for backward compatibility and reuses the same pool.

**Tech Stack:** Deno + TypeScript, Hono (`hono/streaming` `streamSSE`), vanilla browser `EventSource`, `@std/testing/bdd` + `@std/expect`.

## Global Constraints

- All scripts are Deno TypeScript with explicit permissions. No bash scripts.
- Command functions stay pure (no `Deno.args`, `console.log`, `Deno.exit`); `cli.ts` owns I/O. `serve.ts` route handlers are part of the Hono app, not the pure-command contract.
- `serve.css` and `serve.client.js` are read at runtime relative to `import.meta.url`; no build step. Editing a source file is reflected on the next page load.
- Keep the `serve` UI read-only. No new CLI flags.
- Repositories are identified by the unique `repo.path`, never the basename `name`.
- Never use em dashes in comments, commit messages, or docs. Use commas, parentheses, or separate sentences.
- Tests acquire temp git state inline via `await using` (see `.claude/rules/testing.md`). No `beforeEach`/`afterEach`.
- Test run command for this file:
  `deno test --allow-run=git,gh --allow-env --allow-read --allow-write --allow-net src/commands/serve.test.ts`
- Full check before finishing: `deno task check` then `deno task test`.
- After code changes, run `deno task install` (user runs the global binary as a daily driver).
- Commit messages use Conventional Commits. These files live under `src/`, so use `feat(serve): ...` / `test(serve): ...` / `docs: ...` as appropriate (the `skills/**` `feat:`/`fix:` rule does not apply here).

---

## Task 1: Concurrency-capped repository loader

Add a worker-pool loader to `serve.ts` that loads repositories with bounded concurrency and progress callbacks, mirroring the TUI's `loadPrsProgressive`. Refactor `buildServeStatus` to use it so the existing `/api/status` route and its tests are unchanged.

**Files:**
- Modify: `src/commands/serve.ts` (add `LOAD_CONCURRENCY`, `LoadRepositoryStatusesOptions`, `loadRepositoryStatuses`, `finalizeServeStatus`; rewrite `buildServeStatus`)
- Test: `src/commands/serve.test.ts`

**Interfaces:**
- Consumes: existing `loadRepositoryStatus(repository: ServeRepository): Promise<ServeRepositoryStatus>`, `buildServeSharedStackGroups`, types `ServeRepository`, `ServeRepositoryStatus`, `ServeStatusPayload`.
- Produces:
  - `const LOAD_CONCURRENCY = 6`
  - `interface LoadRepositoryStatusesOptions { concurrency: number; onStart?: (path: string) => void | Promise<void>; onSettled?: (status: ServeRepositoryStatus) => void | Promise<void>; }`
  - `loadRepositoryStatuses(repositories: ServeRepository[], opts: LoadRepositoryStatusesOptions): Promise<ServeRepositoryStatus[]>` — results in input order.
  - `finalizeServeStatus(statuses: ServeRepositoryStatus[]): ServeStatusPayload` (module-private).

- [ ] **Step 1: Write the failing test**

Add to `src/commands/serve.test.ts`. Put the new import alongside the existing import block from `./serve.ts` (add `loadRepositoryStatuses` to the named imports):

```ts
describe("loadRepositoryStatuses", () => {
  test("fires onStart before onSettled per repo and returns results in input order", async () => {
    await using repoA = await createTestRepo();
    await using repoB = await createTestRepo();

    await addBranch(repoA.dir, "feature/a", "main");
    await setStackNode(repoA.dir, "feature/a", "stack-a", "main");
    await setBaseBranch(repoA.dir, "stack-a", "main");

    const repositories = [
      { name: "a", path: repoA.dir },
      { name: "b", path: repoB.dir },
    ];

    const events: string[] = [];
    const results = await loadRepositoryStatuses(repositories, {
      concurrency: 1,
      onStart: (path) => {
        events.push(`start:${path}`);
      },
      onSettled: (status) => {
        events.push(`settle:${status.path}`);
      },
    });

    // Input order preserved regardless of completion order.
    expect(results.map((r) => r.path)).toEqual([repoA.dir, repoB.dir]);
    // Every repo starts before it settles.
    expect(events.indexOf(`start:${repoA.dir}`))
      .toBeLessThan(events.indexOf(`settle:${repoA.dir}`));
    expect(events.indexOf(`start:${repoB.dir}`))
      .toBeLessThan(events.indexOf(`settle:${repoB.dir}`));
    // Both repos are accounted for.
    expect(events.filter((e) => e.startsWith("start:"))).toHaveLength(2);
    expect(events.filter((e) => e.startsWith("settle:"))).toHaveLength(2);
  });

  test("never exceeds the configured concurrency", async () => {
    await using repoA = await createTestRepo();
    await using repoB = await createTestRepo();
    await using repoC = await createTestRepo();

    const repositories = [
      { name: "a", path: repoA.dir },
      { name: "b", path: repoB.dir },
      { name: "c", path: repoC.dir },
    ];

    let inFlight = 0;
    let maxInFlight = 0;
    await loadRepositoryStatuses(repositories, {
      concurrency: 2,
      onStart: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
      },
      onSettled: () => {
        inFlight--;
      },
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write --allow-net src/commands/serve.test.ts`
Expected: FAIL — `loadRepositoryStatuses` is not exported / not a function.

- [ ] **Step 3: Add the constant and loader to `serve.ts`**

Add the constant just above the existing `loadRepositoryStatus` function:

```ts
/** Maximum number of repositories loaded concurrently by the serve routes. */
const LOAD_CONCURRENCY = 6;
```

Add immediately after `loadRepositoryStatus` (before `buildServeStatus`):

```ts
/**
 * Options for the concurrency-capped repository loader.
 */
export interface LoadRepositoryStatusesOptions {
  concurrency: number;
  onStart?: (path: string) => void | Promise<void>;
  onSettled?: (status: ServeRepositoryStatus) => void | Promise<void>;
}

/**
 * Load every repository's stack status through a worker pool capped at
 * `concurrency`. Mirrors the TUI's loadPrsProgressive: workers pull from a
 * shared index, fire onStart before a repo begins and onSettled when it
 * resolves, and results come back in input order. loadRepositoryStatus captures
 * its own errors (returning an `error` field) so the pool never throws.
 */
export async function loadRepositoryStatuses(
  repositories: ServeRepository[],
  opts: LoadRepositoryStatusesOptions,
): Promise<ServeRepositoryStatus[]> {
  const results = new Array<ServeRepositoryStatus>(repositories.length);
  let idx = 0;
  const work = async (): Promise<void> => {
    while (idx < repositories.length) {
      const current = idx++;
      const repository = repositories[current];
      await opts.onStart?.(repository.path);
      const status = await loadRepositoryStatus(repository);
      results[current] = status;
      await opts.onSettled?.(status);
    }
  };
  const workers = Array.from(
    { length: Math.min(opts.concurrency, repositories.length) },
    () => work(),
  );
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Add `finalizeServeStatus` and rewrite `buildServeStatus`**

Replace the existing `buildServeStatus` body (currently `serve.ts:552-563`) with:

```ts
/**
 * Apply the browser payload filter (only repositories with stacks) and compute
 * shared-stack groups. Shared by the buffered and streaming status routes.
 */
function finalizeServeStatus(
  statuses: ServeRepositoryStatus[],
): ServeStatusPayload {
  const renderedRepositories = statuses.filter((repo) =>
    (repo.status?.stacks.length ?? 0) > 0
  );
  return {
    repositories: renderedRepositories,
    sharedStacks: buildServeSharedStackGroups(renderedRepositories),
  };
}

/**
 * Load stack status for rendered repositories.
 */
export async function buildServeStatus(
  repositories: ServeRepository[],
): Promise<ServeStatusPayload> {
  const statuses = await loadRepositoryStatuses(repositories, {
    concurrency: LOAD_CONCURRENCY,
  });
  return finalizeServeStatus(statuses);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write --allow-net src/commands/serve.test.ts`
Expected: PASS — both new tests and all existing `buildServeStatus` tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/serve.ts src/commands/serve.test.ts
git commit -m "feat(serve): add concurrency-capped repository loader with progress callbacks"
```

---

## Task 2: SSE streaming status route

Add a `/api/status/stream` route that emits the progress + final-payload events. Keep `/api/status` unchanged.

**Files:**
- Modify: `src/commands/serve.ts` (add `streamSSE` import, add route in `createServeApp`)
- Test: `src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `loadRepositoryStatuses`, `finalizeServeStatus`, `LOAD_CONCURRENCY` (Task 1); `streamSSE` from `hono/streaming`.
- Produces: SSE route `GET /api/status/stream` emitting events:
  - `init`: `data = { repositories: [{ name, path }] }`
  - `repo-start`: `data = { path }`
  - `repo-done`: `data = { path, hasStacks: boolean }`
  - `repo-error`: `data = { path, message: string }`
  - `complete`: `data = { rootDir, repositories, sharedStacks }`

- [ ] **Step 1: Write the failing test**

Add to `src/commands/serve.test.ts` inside the existing `describe("createServeApp", ...)` block:

```ts
test("streams init and complete events from /api/status/stream", async () => {
  await using repo = await createTestRepo();
  await addBranch(repo.dir, "feature/a", "main");
  await setStackNode(repo.dir, "feature/a", "stream-stack", "main");
  await setBaseBranch(repo.dir, "stream-stack", "main");

  const app = createServeApp(repo.dir, [{ name: "repo-a", path: repo.dir }]);
  const res = await app.request("/api/status/stream");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const body = await res.text();
  // The init event lists the requested repo by its unique path.
  expect(body).toContain("event: init");
  expect(body).toContain(repo.dir);
  // Per-repo progress events fire.
  expect(body).toContain("event: repo-start");
  expect(body).toContain("event: repo-done");
  // The terminal event carries the assembled payload with the stack.
  expect(body).toContain("event: complete");
  expect(body).toContain("stream-stack");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write --allow-net src/commands/serve.test.ts`
Expected: FAIL — `/api/status/stream` returns 404 (route not registered).

- [ ] **Step 3: Add the `streamSSE` import**

In `src/commands/serve.ts`, add to the import group near the other `hono` imports (currently `import { Hono } from "hono";` and `import { html, raw } from "hono/html";`):

```ts
import { streamSSE } from "hono/streaming";
```

- [ ] **Step 4: Register the stream route in `createServeApp`**

In `createServeApp`, after the existing `app.get("/api/status", ...)` registration, add:

```ts
app.get("/api/status/stream", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "init",
      data: JSON.stringify({
        repositories: repositories.map(({ name, path }) => ({ name, path })),
      }),
    });

    const statuses = await loadRepositoryStatuses(repositories, {
      concurrency: LOAD_CONCURRENCY,
      onStart: async (path) => {
        await stream.writeSSE({
          event: "repo-start",
          data: JSON.stringify({ path }),
        });
      },
      onSettled: async (status) => {
        if (status.error) {
          await stream.writeSSE({
            event: "repo-error",
            data: JSON.stringify({ path: status.path, message: status.error }),
          });
          return;
        }
        await stream.writeSSE({
          event: "repo-done",
          data: JSON.stringify({
            path: status.path,
            hasStacks: (status.status?.stacks.length ?? 0) > 0,
          }),
        });
      },
    });

    await stream.writeSSE({
      event: "complete",
      data: JSON.stringify({ rootDir, ...finalizeServeStatus(statuses) }),
    });
  }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write --allow-net src/commands/serve.test.ts`
Expected: PASS — the new stream test and all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/serve.ts src/commands/serve.test.ts
git commit -m "feat(serve): stream per-repository load progress over SSE"
```

---

## Task 3: Loading-screen styles

Add a spinner keyframe and `.repo-load-row` rule to `serve.css` for the progress UI. (CSS animations require the stylesheet; the client inlines everything else.)

**Files:**
- Modify: `src/commands/serve.css`
- Test: `src/commands/serve.test.ts` (extend the existing `getServeHtmlForTest` test)

**Interfaces:**
- Produces: CSS classes `.repo-load-row`, `.repo-load-spinner` and keyframes `spp-spin` available to the inlined client.

- [ ] **Step 1: Write the failing test**

Extend the existing `getServeHtmlForTest` test in `src/commands/serve.test.ts` with one assertion (the served document inlines `serve.css`, so the new rule appears in the HTML):

```ts
expect(html).toContain(".repo-load-row");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write --allow-net src/commands/serve.test.ts`
Expected: FAIL — `.repo-load-row` not present in the document.

- [ ] **Step 3: Append the styles to `serve.css`**

Add to the end of `src/commands/serve.css`:

```css
/* Loading screen: per-repository progress rows shown until every repo settles. */
.repo-load-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #21262d;
  background: #0d1117;
  font:
    500 13px/1.4 "JetBrains Mono",
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  color: #c9d1d9;
}

.repo-load-spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 2px solid #30363d;
  border-top-color: #539bf5;
  animation: spp-spin 0.7s linear infinite;
}

@keyframes spp-spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write --allow-net src/commands/serve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/serve.css src/commands/serve.test.ts
git commit -m "feat(serve): add loading-screen styles for repository progress"
```

---

## Task 4: Client EventSource progress UI

Replace the single `fetch` in `loadStatus()` with an `EventSource` flow that renders the per-repo progress screen and swaps to the full view on `complete`.

**Files:**
- Modify: `src/commands/serve.client.js` (rewrite `loadStatus()`, add `loadState` + `renderLoading()`, adjust the bottom catch)

**Interfaces:**
- Consumes: `/api/status/stream` SSE events from Task 2; existing `el`, `buildModel`, `render`, `setSelected`, constants `MONO`, `ALL_ID`, `REPOS_KEY`, and the existing `stacks`/`allRepos`/`state` module variables.
- Produces: a finished loading flow that populates `stacks`, `allRepos`, reconciles sessionStorage selection, and calls `render()`.

- [ ] **Step 1: Add the loading state + render function**

In `src/commands/serve.client.js`, add near the other module-level `let` declarations (after `let allRepos = [];`):

```js
// Per-path load state for the progress screen: "queued" | "loading" | "done" |
// "error". Reset each time loadStatus() runs. Error messages are kept alongside
// so error rows can show why a repo failed.
let loadOrder = [];
const loadState = new Map();
const loadError = new Map();
```

Add this render function just above `async function loadStatus()`:

```js
// Loading screen shown until every repository settles, then swapped for the
// real view (render()). One row per repository with a live state badge.
function renderLoading() {
  app.replaceChildren();
  const total = loadOrder.length;
  let done = 0;
  for (const path of loadOrder) {
    const s = loadState.get(path);
    if (s === "done" || s === "error") done++;
  }

  const wrap = el("div", { class: "app-content" });
  wrap.append(
    el("div", {
      style: `font:600 15px ${MONO};color:#e6edf3;margin-bottom:4px;`,
      text: total === 0 ? "Loading repositories..." : `Loading ${total} ${
        total === 1 ? "repository" : "repositories"
      }`,
    }),
  );
  wrap.append(
    el("div", {
      style: `font:400 12px ${MONO};color:#6e7681;margin-bottom:16px;`,
      text: `${done} of ${total} loaded`,
    }),
  );

  const list = el("div", {
    style: "display:flex;flex-direction:column;gap:8px;",
  });
  for (const repo of loadOrder.map((p) => loadRepoByPath(p))) {
    list.append(loadRow(repo));
  }
  wrap.append(list);
  app.append(wrap);
}

// Resolve a path back to its {name, path} for the progress row label.
function loadRepoByPath(path) {
  return loadInfo.get(path) || { name: path, path };
}

// One progress row: state marker + repo name (+ error message when failed).
function loadRow(repo) {
  const s = loadState.get(repo.path) || "queued";
  let marker;
  if (s === "loading") {
    marker = el("span", { class: "repo-load-spinner" });
  } else if (s === "done") {
    marker = el("span", {
      style: "color:#3fb950;font-weight:600;flex:none;width:12px;",
      text: "✓",
    });
  } else if (s === "error") {
    marker = el("span", {
      style: "color:#ff7b72;font-weight:600;flex:none;width:12px;",
      text: "✗",
    });
  } else {
    marker = el("span", {
      style:
        "width:10px;height:10px;flex:none;border-radius:50%;background:#30363d;",
    });
  }
  const children = [
    marker,
    el("span", { style: "color:#e6edf3;", text: repo.name }),
  ];
  if (s === "error") {
    children.push(el("span", {
      style: "color:#ff7b72;font-size:11px;margin-left:auto;text-align:right;",
      text: loadError.get(repo.path) || "failed",
    }));
  } else {
    children.push(el("span", {
      style: "margin-left:auto;color:#6e7681;font-size:11px;",
      text: s,
    }));
  }
  return el("div", { class: "repo-load-row" }, children);
}
```

Add the `loadInfo` map with the other load-state declarations from above:

```js
// path -> {name, path} from the init event, for progress row labels.
const loadInfo = new Map();
```

- [ ] **Step 2: Rewrite `loadStatus()` to consume the SSE stream**

Replace the entire existing `loadStatus()` function (currently `serve.client.js:1067-1109`) with:

```js
function loadStatus() {
  loadOrder = [];
  loadState.clear();
  loadError.clear();
  loadInfo.clear();
  renderLoading();

  const es = new EventSource("/api/status/stream");
  let completed = false;

  es.addEventListener("init", (e) => {
    const data = JSON.parse(e.data);
    const repos = data.repositories || [];
    loadOrder = repos.map((r) => r.path);
    for (const r of repos) {
      loadInfo.set(r.path, { name: r.name, path: r.path });
      loadState.set(r.path, "queued");
    }
    renderLoading();
  });

  es.addEventListener("repo-start", (e) => {
    const { path } = JSON.parse(e.data);
    loadState.set(path, "loading");
    renderLoading();
  });

  es.addEventListener("repo-done", (e) => {
    const { path } = JSON.parse(e.data);
    loadState.set(path, "done");
    renderLoading();
  });

  es.addEventListener("repo-error", (e) => {
    const { path, message } = JSON.parse(e.data);
    loadState.set(path, "error");
    loadError.set(path, message || "failed");
    renderLoading();
  });

  es.addEventListener("complete", (e) => {
    completed = true;
    es.close();
    applyPayload(JSON.parse(e.data));
  });

  // EventSource auto-reconnects on a dropped connection; surface a real error
  // only when we never received the terminal `complete` event.
  es.addEventListener("error", () => {
    if (completed) return;
    es.close();
    app.replaceChildren(el("div", {
      style: `padding:40px;color:#ff7b72;font:400 13px ${MONO};`,
      text: "Failed to load repository status.",
    }));
  });
}

// Build the view model from the terminal payload, reconcile per-tab view state,
// and swap the loading screen for the full stack view.
function applyPayload(payload) {
  document.title = `stacked-prs${
    payload.rootDir ? ` · ${payload.rootDir}` : ""
  }`;
  stacks = buildModel(payload.repositories || []);
  allRepos = (payload.repositories || [])
    .map((r) => ({
      name: r.name,
      path: r.path,
      github: r.github ? `${r.github.owner}/${r.github.repo}` : null,
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
    );
  const present = new Set(allRepos.map((r) => r.path));
  let stored = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(REPOS_KEY) || "null");
  } catch {
    stored = null;
  }
  const restored = Array.isArray(stored)
    ? stored.filter((p) => present.has(p))
    : [];
  // Fall back to all-selected when nothing was stored or the stored set is stale
  // (e.g. a different folder set produced these paths), so the page never loads
  // blank on a meaningless selection.
  state.selectedRepos = restored.length > 0 ? new Set(restored) : present;
  if (
    state.selectedId !== ALL_ID &&
    !stacks.some((s) => s.id === state.selectedId)
  ) {
    state.selectedId = ALL_ID;
    setSelected(ALL_ID);
  }
  render();
}
```

- [ ] **Step 3: Update the bottom invocation**

The current file ends with `loadStatus().catch((err) => { ... })` (`serve.client.js:1111-1116`). `loadStatus()` no longer returns a promise (errors are handled via the EventSource `error` listener). Replace that trailing block with a plain call:

```js
loadStatus();
```

- [ ] **Step 4: Manual verification (no client unit harness exists)**

Build and launch against this repo plus one more to see multiple rows:

Run:
```bash
deno task install
stacked-prs serve . --no-open
```
Then open the printed URL in a browser. Expected: a "Loading N repositories" screen with one row per repo cycling `queued -> loading -> done`, then a swap to the normal stack view. Stop the server with Ctrl-C.

If only one repo is available, serve two folders to see concurrency:
`stacked-prs serve . ../<another-repo> --no-open`.

- [ ] **Step 5: Run the type check and full test suite**

Run: `deno task check`
Expected: no type or lint errors.

Run: `deno task test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/serve.client.js
git commit -m "feat(serve): render live per-repository loading progress in the browser"
```

---

## Task 5: Documentation

Document the streaming load + concurrency cap in `CLAUDE.md` and `README.md`.

**Files:**
- Modify: `CLAUDE.md` (the `serve` description under "Layout" / "Architecture" and the serve dev-rule bullet)
- Modify: `README.md` (serve section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `CLAUDE.md`**

In the `serve` paragraph under "Layout", add a sentence describing the progressive loading. Locate the sentence near the start of the serve description that begins "`serve` is a read-only local browser view:" and, after the sentence describing reusing `getAllStackStatuses`, add:

```
The browser loads via a Server-Sent Events route (`/api/status/stream`):
`createServeApp` emits an `init` event (the full repo list), then
`repo-start`/`repo-done`/`repo-error` events as a concurrency-capped worker pool
(`loadRepositoryStatuses`, cap `LOAD_CONCURRENCY`) loads each repository, then a
final `complete` event carrying the same payload `/api/status` returns. The
client shows a per-repository `queued -> loading -> done | error` progress screen
and swaps to the full stack view on `complete`. `/api/status` remains for the
buffered (non-streaming) payload and shares the same pool via
`finalizeServeStatus`.
```

In the "Browser UI for `serve`" dev-rule bullet under "Development rules", add a sentence after the existing description of `createServeApp`:

```
`createServeApp` also serves `/api/status/stream` (SSE via `streamSSE` from
`hono/streaming`) for progressive per-repository loading; both routes load
through `loadRepositoryStatuses` (capped at `LOAD_CONCURRENCY`) and finalize via
`finalizeServeStatus`.
```

- [ ] **Step 2: Update `README.md`**

Find the `serve` section in `README.md` (search for "serve"). Add a sentence to its description noting that the browser shows a live per-repository loading progress screen (each repo `queued -> loading -> done`) before rendering the stacks, and that loading is concurrency-capped. Match the surrounding prose style. (Read the section first; if the README does not document `serve` in prose, skip the README edit and note it in the commit body.)

- [ ] **Step 3: Verify docs reference real symbols**

Run: `grep -n "loadRepositoryStatuses\|finalizeServeStatus\|api/status/stream\|LOAD_CONCURRENCY" CLAUDE.md README.md src/commands/serve.ts`
Expected: the symbols referenced in the docs exist in `serve.ts`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document serve streaming load and concurrency cap"
```

---

## Final verification

- [ ] Run `deno task check` (type check, lint, fmt check) — expected clean.
- [ ] Run `deno task test` — expected all pass.
- [ ] Run `deno task install` so the global binary reflects the changes.
- [ ] Confirm every plan task's checkboxes are ticked.
</content>
