# Serve Live Watch + PR Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `stacked-prs serve` live: watch each served repo's `.git` and poll GitHub so the browser optimistically re-renders changed repositories with a toast, instead of requiring a manual reload.

**Architecture:** A new long-lived SSE route `/api/watch` on the existing Hono app. A per-connection `Deno.watchFs` watcher per repo (debounced, filtered to stack-relevant files) and a PR-poll interval both funnel into one coalescing "reload one repo, emit `repo-updated`" scheduler. The client opens a second `EventSource`, upserts the changed repo into its model, re-renders, and shows a toast.

**Tech Stack:** Deno + TypeScript, Hono (`hono/streaming` `streamSSE`), `Deno.watchFs`, vanilla browser JS (`EventSource`), `@std/testing/bdd` + `@std/expect`.

## Global Constraints

- All scripts are Deno TypeScript; no bash scripts. Commands stay pure (no `Deno.args`/`console.log`/`Deno.exit` in command modules); `cli.ts` owns I/O.
- `serve` already runs with `--allow-read`, which covers `Deno.watchFs` and `Deno.stat`; no new permission is required.
- Never use em dashes in any output, comments, commit messages, or docs. Use commas, parentheses, or separate sentences.
- Tests acquire temp git state inline via `await using` (`createTestRepo` / `makeTempDir`); no `beforeEach`/`afterEach`.
- Commits touching `skills/**` use `feat:` or `fix:` (shipped plugin artifacts); `docs:` only for non-shipped files (`README.md`, `CLAUDE.md`, in-repo notes).
- Conventional Commits; branch already `wyattjoh/serve-command`.
- Run `deno task check` (fmt + lint + type) and the serve test file after changes. Run `deno task install` after the feature is complete (user runs the global binary).
- Keep the serve UI read-only.

## File Structure

- `src/commands/serve.ts` (modify): add `ServeWatchConfig`, pure `isRelevantGitChange`, `resolveGitWatchPaths`, `createReloadScheduler`, `watchRepoFs`, the `/api/watch` route, `watch` plumbing through `createServeApp` / `renderServeDocument` / `startServeServer` / `ServeServerOptions`.
- `src/commands/serve.client.js` (modify): `reposByPath` map, `toast()`, `startWatch()`, `applyRepoUpdate()`, read `window.__STACKED_PRS__`.
- `src/commands/serve.css` (modify): toast styles.
- `src/cli.ts` (modify): `--no-watch`, `--poll-interval` flags; build the watch config.
- `src/commands/serve.test.ts` (modify): unit + integration tests.
- `CLAUDE.md`, `skills/stacked-prs/SKILL.md`, `README.md` (modify): docs.

---

### Task 1: Pure git-change relevance predicate

**Files:**
- Modify: `src/commands/serve.ts` (add exported `isRelevantGitChange`)
- Test: `src/commands/serve.test.ts`

**Interfaces:**
- Produces: `export function isRelevantGitChange(path: string): boolean`

- [ ] **Step 1: Write the failing test**

Add to `src/commands/serve.test.ts`. Add `isRelevantGitChange` to the existing import block from `./serve.ts`.

```ts
describe("isRelevantGitChange", () => {
  test("reacts to ref, config, and HEAD changes", () => {
    expect(isRelevantGitChange("/r/.git/refs/heads/feature")).toBe(true);
    expect(isRelevantGitChange("/r/.git/packed-refs")).toBe(true);
    expect(isRelevantGitChange("/r/.git/config")).toBe(true);
    expect(isRelevantGitChange("/r/.git/HEAD")).toBe(true);
    expect(isRelevantGitChange("/r/.git/ORIG_HEAD")).toBe(true);
    // A ref literally named "objects" still counts (refs/ wins over objects/).
    expect(isRelevantGitChange("/r/.git/refs/heads/objects")).toBe(true);
  });

  test("ignores object churn, index, locks, and transient files", () => {
    expect(isRelevantGitChange("/r/.git/objects/ab/cdef")).toBe(false);
    expect(isRelevantGitChange("/r/.git/index")).toBe(false);
    expect(isRelevantGitChange("/r/.git/refs/heads/feature.lock")).toBe(false);
    expect(isRelevantGitChange("/r/.git/config.lock")).toBe(false);
    expect(isRelevantGitChange("/r/.git/FETCH_HEAD")).toBe(false);
    expect(isRelevantGitChange("/r/.git/COMMIT_EDITMSG")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "isRelevantGitChange"`
Expected: FAIL (`isRelevantGitChange` is not exported / not defined).

- [ ] **Step 3: Write minimal implementation**

Add to `src/commands/serve.ts` (near the other helpers, e.g. after `stripAnsi`):

```ts
/**
 * Decide whether a filesystem path under a watched git dir represents a
 * stack-relevant change. Ref updates (anywhere under `refs/`), `packed-refs`,
 * `config` (stack metadata lives here), `HEAD`, and `ORIG_HEAD` count; object
 * store churn, the index, lock files, and transient files do not. Matches on
 * path segments so it is OS-agnostic.
 */
export function isRelevantGitChange(path: string): boolean {
  const segments = path.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1];
  if (last.endsWith(".lock")) return false;
  if (last === "index" || last === "FETCH_HEAD" || last === "COMMIT_EDITMSG") {
    return false;
  }
  // Check refs before objects so a ref named "objects" is not discarded.
  if (segments.includes("refs")) return true;
  if (segments.includes("objects")) return false;
  return last === "config" || last === "packed-refs" || last === "HEAD" ||
    last === "ORIG_HEAD";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "isRelevantGitChange"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/serve.ts src/commands/serve.test.ts
git commit -m "feat(serve): add stack-relevant git-change predicate"
```

---

### Task 2: Resolve git directories to watch

**Files:**
- Modify: `src/commands/serve.ts` (add exported `resolveGitWatchPaths`)
- Test: `src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `runGitCommand` (already imported), `isAbsolute`, `join`, `normalize` (already imported from `@std/path`).
- Produces: `export function resolveGitWatchPaths(dir: string): Promise<string[]>` (deduplicated absolute git-dir + common-dir paths that exist on disk).

- [ ] **Step 1: Write the failing test**

Add to `src/commands/serve.test.ts` (add `resolveGitWatchPaths` to the `./serve.ts` import block; `normalize` and `join` are needed too: import `join`, `normalize` from `@std/path`. `join` is already imported, add `normalize`).

```ts
describe("resolveGitWatchPaths", () => {
  test("returns the git dir for a normal repo", async () => {
    await using repo = await createTestRepo();
    const paths = await resolveGitWatchPaths(repo.dir);
    expect(paths).toEqual([normalize(join(repo.dir, ".git"))]);
  });

  test("includes both the worktree and common git dirs for a linked worktree", async () => {
    await using repo = await createTestRepo();
    await using tmp = await makeTempDir("serve-watch-wt-");
    const wt = join(tmp.path, "wt");
    await runGit(repo.dir, "worktree", "add", "-b", "wt-branch", wt);

    const paths = await resolveGitWatchPaths(wt);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.endsWith(".git"))).toBe(true);
    expect(paths.some((p) => p.includes("worktrees"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "resolveGitWatchPaths"`
Expected: FAIL (`resolveGitWatchPaths` not defined).

- [ ] **Step 3: Write minimal implementation**

Add to `src/commands/serve.ts` (after `isRelevantGitChange`):

```ts
/**
 * Resolve the git directories to watch for a repository: the common dir (holds
 * `refs/`, `packed-refs`, `config`) and, for a linked worktree, the worktree's
 * own git dir (holds `HEAD`). Returns deduplicated absolute paths that exist on
 * disk; a repo whose git dir cannot be resolved yields an empty list.
 */
export async function resolveGitWatchPaths(dir: string): Promise<string[]> {
  const out = new Set<string>();
  for (const flag of ["--git-common-dir", "--git-dir"]) {
    const res = await runGitCommand(dir, "rev-parse", flag);
    if (res.code !== 0 || !res.stdout) continue;
    const abs = isAbsolute(res.stdout) ? res.stdout : join(dir, res.stdout);
    const norm = normalize(abs);
    try {
      const stat = await Deno.stat(norm);
      if (stat.isDirectory) out.add(norm);
    } catch {
      // Missing or unreadable git dir; skip.
    }
  }
  return [...out];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "resolveGitWatchPaths"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/serve.ts src/commands/serve.test.ts
git commit -m "feat(serve): resolve git dirs to watch (worktree-aware)"
```

---

### Task 3: Coalescing reload scheduler

**Files:**
- Modify: `src/commands/serve.ts` (add exported `createReloadScheduler`)
- Test: `src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `ServeRepository` (already exported).
- Produces:
  ```ts
  export function createReloadScheduler(
    reload: (repo: ServeRepository) => Promise<void>,
  ): { trigger(repo: ServeRepository): void }
  ```
  Guarantees: at most one in-flight reload per `repo.path`; triggers during an in-flight reload coalesce into exactly one follow-up reload.

- [ ] **Step 1: Write the failing test**

Add to `src/commands/serve.test.ts` (add `createReloadScheduler` to the `./serve.ts` import block, and add `type ServeRepository` to it).

```ts
describe("createReloadScheduler", () => {
  test("coalesces triggers during an in-flight reload", async () => {
    const calls: string[] = [];
    let resolveCurrent: (() => void) | undefined;
    const reload = (repo: ServeRepository) => {
      calls.push(repo.path);
      return new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
    };
    const scheduler = createReloadScheduler(reload);
    const repo: ServeRepository = { name: "a", path: "/a" };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    scheduler.trigger(repo); // starts reload #1
    scheduler.trigger(repo); // in-flight -> pending
    scheduler.trigger(repo); // in-flight -> still pending (deduped)
    expect(calls).toEqual(["/a"]);

    const finishFirst = resolveCurrent!;
    finishFirst(); // completes #1 -> pending fires reload #2
    await flush();
    expect(calls).toEqual(["/a", "/a"]);

    resolveCurrent!(); // completes #2 -> no pending left
    await flush();
    expect(calls).toEqual(["/a", "/a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "createReloadScheduler"`
Expected: FAIL (`createReloadScheduler` not defined).

- [ ] **Step 3: Write minimal implementation**

Add to `src/commands/serve.ts` (after `resolveGitWatchPaths`):

```ts
/**
 * Build a per-repository reload scheduler that never runs two reloads for the
 * same path at once. Triggers arriving while a reload is in flight coalesce into
 * exactly one follow-up reload, so a burst of filesystem events produces at most
 * one extra refresh.
 */
export function createReloadScheduler(
  reload: (repo: ServeRepository) => Promise<void>,
): { trigger(repo: ServeRepository): void } {
  const reloading = new Set<string>();
  const pending = new Map<string, ServeRepository>();

  const run = (repo: ServeRepository): void => {
    reloading.add(repo.path);
    reload(repo).catch(() => {}).finally(() => {
      reloading.delete(repo.path);
      const next = pending.get(repo.path);
      if (next) {
        pending.delete(repo.path);
        run(next);
      }
    });
  };

  return {
    trigger(repo: ServeRepository): void {
      if (reloading.has(repo.path)) {
        pending.set(repo.path, repo);
        return;
      }
      run(repo);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "createReloadScheduler"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/serve.ts src/commands/serve.test.ts
git commit -m "feat(serve): add coalescing per-repo reload scheduler"
```

---

### Task 4: Filesystem watcher helper

**Files:**
- Modify: `src/commands/serve.ts` (add exported `watchRepoFs`)
- Test: `src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `resolveGitWatchPaths`, `isRelevantGitChange`, `ServeRepository`, `Deno.watchFs`.
- Produces:
  ```ts
  export function watchRepoFs(
    repo: ServeRepository,
    onChange: () => void,
    debounceMs: number,
  ): Promise<() => Promise<void>>
  ```
  Returns a closer that stops the watcher and clears any pending debounce. `onChange` fires once per debounce window after a relevant change.

- [ ] **Step 1: Write the failing test**

Add to `src/commands/serve.test.ts` (add `watchRepoFs` to the `./serve.ts` import block).

```ts
describe("watchRepoFs", () => {
  test("fires onChange (debounced) on a relevant git change", async () => {
    await using repo = await createTestRepo();
    let count = 0;
    const close = await watchRepoFs(
      { name: "a", path: repo.dir },
      () => {
        count++;
      },
      30,
    );
    try {
      await runGit(repo.dir, "branch", "watch-target");
      const deadline = Date.now() + 2000;
      while (count === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "watchRepoFs"`
Expected: FAIL (`watchRepoFs` not defined).

- [ ] **Step 3: Write minimal implementation**

Add to `src/commands/serve.ts` (after `createReloadScheduler`):

```ts
/**
 * Watch a repository's git dirs and call `onChange` (debounced by `debounceMs`)
 * whenever a stack-relevant file changes. Returns a closer that stops the
 * watcher and clears any pending debounce timer. A repo whose git dirs cannot be
 * resolved is not watched and the closer is a no-op.
 */
export async function watchRepoFs(
  repo: ServeRepository,
  onChange: () => void,
  debounceMs: number,
): Promise<() => Promise<void>> {
  const paths = await resolveGitWatchPaths(repo.path);
  if (paths.length === 0) return () => Promise.resolve();

  let watcher: Deno.FsWatcher;
  try {
    watcher = Deno.watchFs(paths, { recursive: true });
  } catch {
    return () => Promise.resolve();
  }

  let timer: number | undefined;
  let closed = false;
  const loop = (async () => {
    for await (const event of watcher) {
      if (!event.paths.some(isRelevantGitChange)) continue;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed) onChange();
      }, debounceMs);
    }
  })();

  return async () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
    await loop.catch(() => {});
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "watchRepoFs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/serve.ts src/commands/serve.test.ts
git commit -m "feat(serve): add debounced git filesystem watcher"
```

---

### Task 5: Watch config, `/api/watch` route, and document global

**Files:**
- Modify: `src/commands/serve.ts` (`ServeWatchConfig`, `WATCH_DISABLED`, `renderServeDocument(watchEnabled)`, `createServeApp(..., watch)`, `/api/watch` route, `ServeServerOptions.watch`, `startServeServer` plumbing, `getServeHtmlForTest(watchEnabled)`)
- Test: `src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `watchRepoFs`, `createReloadScheduler`, `loadRepositoryStatus` (module-private), `resolveGitHubRepository` (module-private), `streamSSE` (already imported).
- Produces:
  ```ts
  export interface ServeWatchConfig {
    enabled: boolean;
    pollIntervalMs: number;
    debounceMs: number;
  }
  export function createServeApp(
    rootDir: string,
    repositories: ServeRepository[],
    watch?: ServeWatchConfig,
  ): Hono
  export function getServeHtmlForTest(watchEnabled?: boolean): Promise<string>
  ```
  `ServeServerOptions` gains `watch: ServeWatchConfig`. The `/api/watch` route emits a `ready` event, then `repo-updated` events; it is only registered when `watch.enabled`.

- [ ] **Step 1: Write the failing tests**

Add to `src/commands/serve.test.ts`. The integration test needs a bounded wait so it never hangs.

```ts
describe("/api/watch", () => {
  test("is not registered when watch is disabled", async () => {
    const app = createServeApp("/tmp/root", [], {
      enabled: false,
      pollIntervalMs: 0,
      debounceMs: 300,
    });
    const res = await app.request("/api/watch");
    expect(res.status).toBe(404);
    await res.text();
  });

  test("emits ready then repo-updated on a git change", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await setStackNode(repo.dir, "feature/a", "watch-stack", "main");
    await setBaseBranch(repo.dir, "watch-stack", "main");

    const app = createServeApp(repo.dir, [{ name: "repo-a", path: repo.dir }], {
      enabled: true,
      pollIntervalMs: 0,
      debounceMs: 30,
    });
    const ac = new AbortController();
    const res = await app.request("/api/watch", { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const readUntil = (needle: string) => {
      let timer = 0;
      const wait = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${needle}`)),
          5000,
        );
      });
      const pump = (async () => {
        let buf = "";
        while (!buf.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value);
        }
        return buf;
      })();
      return Promise.race([pump, wait]).finally(() => clearTimeout(timer));
    };

    try {
      await readUntil("event: ready");
      await runGit(repo.dir, "branch", "watch-target");
      const body = await readUntil("event: repo-updated");
      expect(body).toContain("event: repo-updated");
      expect(body).toContain(repo.dir);
    } finally {
      await reader.cancel();
      ac.abort();
    }
  });
});

describe("watch document global", () => {
  test("emits the watch global enabled", async () => {
    const html = await getServeHtmlForTest(true);
    expect(html).toContain("window.__STACKED_PRS__");
    expect(html).toContain('{"watch":true}');
    expect(html).toContain("/api/watch");
  });

  test("emits the watch global disabled", async () => {
    const html = await getServeHtmlForTest(false);
    expect(html).toContain('{"watch":false}');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "/api/watch"`
Expected: FAIL (route not registered as expected / `getServeHtmlForTest` arity / global missing).

- [ ] **Step 3: Implement the watch config type and default**

Add near the other interfaces in `src/commands/serve.ts` (e.g. after `ServeServer`):

```ts
/**
 * Live-watch configuration for the local browser server. When `enabled` is
 * false the `/api/watch` route is not registered and the client does not open
 * it. `pollIntervalMs` of 0 disables PR polling while keeping the filesystem
 * watch. `debounceMs` collapses filesystem event bursts per repository.
 */
export interface ServeWatchConfig {
  enabled: boolean;
  pollIntervalMs: number;
  debounceMs: number;
}

const WATCH_DISABLED: ServeWatchConfig = {
  enabled: false,
  pollIntervalMs: 0,
  debounceMs: 300,
};
```

- [ ] **Step 4: Inject the watch global into the document**

Replace the `renderServeDocument` signature and the `<body>` script opening in `src/commands/serve.ts`. Change the function declaration:

```ts
async function renderServeDocument(watchEnabled: boolean): Promise<string> {
```

and inside the returned template, immediately before `<div id="app" ...>` add the config global script. The body becomes:

```ts
      <body>
        <script>
        window.__STACKED_PRS__ = ${raw(JSON.stringify({ watch: watchEnabled }))};
        </script>
        <div id="app" class="page"></div>
        <script type="module">
        ${raw(clientScript)}
        </script>
      </body>
```

Update `getServeHtmlForTest`:

```ts
export function getServeHtmlForTest(watchEnabled = false): Promise<string> {
  return renderServeDocument(watchEnabled);
}
```

- [ ] **Step 5: Add the `watch` parameter and `/api/watch` route to `createServeApp`**

Change the signature:

```ts
export function createServeApp(
  rootDir: string,
  repositories: ServeRepository[],
  watch: ServeWatchConfig = WATCH_DISABLED,
): Hono {
  const app = new Hono();
  app.get("/", async (c) => c.html(await renderServeDocument(watch.enabled)));
```

Leave the existing `/api/status` and `/api/status/stream` routes unchanged. After the `/api/status/stream` route and before `return app;`, add:

```ts
  if (watch.enabled) {
    app.get("/api/watch", (c) =>
      streamSSE(c, async (stream) => {
        const closers: Array<() => Promise<void>> = [];
        let pollTimer: number | undefined;
        const cleanup = async () => {
          if (pollTimer !== undefined) clearInterval(pollTimer);
          pollTimer = undefined;
          await Promise.all(closers.splice(0).map((close) => close()));
        };

        const reload = async (repo: ServeRepository) => {
          const status = await loadRepositoryStatus(repo);
          await stream.writeSSE({
            event: "repo-updated",
            data: JSON.stringify(status),
          });
        };
        const scheduler = createReloadScheduler(reload);

        try {
          for (const repo of repositories) {
            closers.push(
              await watchRepoFs(
                repo,
                () => scheduler.trigger(repo),
                watch.debounceMs,
              ),
            );
          }

          if (watch.pollIntervalMs > 0) {
            const githubRepos: ServeRepository[] = [];
            for (const repo of repositories) {
              if (await resolveGitHubRepository(repo.path)) {
                githubRepos.push(repo);
              }
            }
            if (githubRepos.length > 0) {
              pollTimer = setInterval(() => {
                for (const repo of githubRepos) scheduler.trigger(repo);
              }, watch.pollIntervalMs);
            }
          }

          // Signal the channel is live, then hold it open until the client
          // disconnects. EventSource on the client reconnects automatically.
          await stream.writeSSE({ event: "ready", data: "{}" });
          await new Promise<void>((resolve) => {
            if (stream.aborted || stream.closed) resolve();
            else stream.onAbort(resolve);
          });
        } finally {
          await cleanup();
        }
      }));
  }
  return app;
}
```

- [ ] **Step 6: Thread `watch` through `ServeServerOptions` and `startServeServer`**

In `ServeServerOptions` add the field:

```ts
export interface ServeServerOptions {
  rootDir: string;
  repositories: ServeRepository[];
  host: string;
  port: number;
  watch: ServeWatchConfig;
}
```

In `startServeServer`, pass it to `createServeApp`:

```ts
  const app = createServeApp(options.rootDir, options.repositories, options.watch);
```

- [ ] **Step 7: Run the serve test file**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts`
Expected: PASS (new `/api/watch` and document-global tests plus all existing tests).

- [ ] **Step 8: Type-check**

Run: `deno check src/cli.ts`
Expected: a type error in `src/cli.ts` because `startServeServer` now requires `watch` (fixed in Task 6). The `serve.ts` module itself must type-check; if `deno check src/commands/serve.ts` reports errors, fix them. Proceed to Task 6 to satisfy the `cli.ts` call site.

- [ ] **Step 9: Commit**

```bash
git add src/commands/serve.ts src/commands/serve.test.ts
git commit -m "feat(serve): add /api/watch live channel and watch config"
```

---

### Task 6: CLI flags

**Files:**
- Modify: `src/cli.ts:497-514` (the `serve` command registration and action)

**Interfaces:**
- Consumes: `ServeWatchConfig` shape via `startServeServer` options (no new import needed; the object is structural).

- [ ] **Step 1: Add the options and build the watch config**

In `src/cli.ts`, in the `serve` command chain, add two options after `--no-open`:

```ts
  .option("--no-watch", "Disable live updates (file watch and PR polling)")
  .option(
    "--poll-interval <seconds:number>",
    "Seconds between PR status polls (0 disables polling)",
    { default: 60 },
  )
```

Then in the `.action(async (options, ...folders: string[]) => {` body, replace the `startServeServer({...})` call with:

```ts
    const pollSeconds = options.pollInterval ?? 60;
    const server = await startServeServer({
      rootDir: dir,
      repositories,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      watch: {
        enabled: options.watch !== false,
        pollIntervalMs: Math.max(0, pollSeconds) * 1000,
        debounceMs: 300,
      },
    });
```

- [ ] **Step 2: Type-check**

Run: `deno check src/cli.ts`
Expected: PASS.

- [ ] **Step 3: Smoke test the help output**

Run: `deno run --allow-run=git,gh,open --allow-env --allow-read --allow-net src/cli.ts serve --help`
Expected: output lists `--no-watch` and `--poll-interval`.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(serve): add --no-watch and --poll-interval flags"
```

---

### Task 7: Browser client live updates + toast

**Files:**
- Modify: `src/commands/serve.client.js`
- Modify: `src/commands/serve.css`
- Test: `src/commands/serve.test.ts` (document-contains assertions)

**Interfaces:**
- Consumes: `window.__STACKED_PRS__.watch` (set by the document), `EventSource`, existing `buildModel`, `el`, `render`, `applyPayload`, `state`, `REPOS_KEY`.
- Produces: client-only behavior; verified via document-string assertions and manual run.

- [ ] **Step 1: Write the failing test**

Add to `src/commands/serve.test.ts`:

```ts
describe("serve client watch wiring", () => {
  test("client subscribes to repo-updated on the watch channel", async () => {
    const html = await getServeHtmlForTest(true);
    expect(html).toContain('new EventSource("/api/watch")');
    expect(html).toContain('"repo-updated"');
    expect(html).toContain("toast-host");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "serve client watch wiring"`
Expected: FAIL (client does not yet reference the watch channel).

- [ ] **Step 3: Add the toast helper, raw-repo map, and watch wiring to `serve.client.js`**

Add a non-rendering repo-persist helper and refactor `setSelectedRepos` to use it. Replace the existing `setSelectedRepos`:

```js
function persistRepos(set) {
  try {
    sessionStorage.setItem(REPOS_KEY, JSON.stringify([...set]));
  } catch {
    // sessionStorage unavailable (private mode); keep the selection ephemeral.
  }
}

function setSelectedRepos(set) {
  persistRepos(set);
  render();
}
```

Add module-level state near `let allRepos = [];`:

```js
// Raw /api/status repositories keyed by unique path, kept so a live
// `repo-updated` event can upsert a single repo and rebuild the model.
let reposByPath = new Map();
let watching = false;
let toastHost = null;
```

Add a `buildFromRepos` helper and a toast helper (place them near `applyPayload`):

```js
// Rebuild the grouped model + repo list from a raw repositories array. Shared by
// the initial payload and live per-repo updates.
function buildFromRepos(repositories) {
  stacks = buildModel(repositories || []);
  allRepos = (repositories || [])
    .map((r) => ({
      name: r.name,
      path: r.path,
      github: r.github ? `${r.github.owner}/${r.github.repo}` : null,
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
    );
}

// Transient corner toast; auto-dismisses after ~3s. Multiple toasts stack.
function toast(message) {
  if (!toastHost) {
    toastHost = el("div", { class: "toast-host" });
    document.body.append(toastHost);
  }
  const node = el("div", { class: "toast", text: message });
  toastHost.append(node);
  requestAnimationFrame(() => node.classList.add("toast--show"));
  setTimeout(() => {
    node.classList.remove("toast--show");
    setTimeout(() => node.remove(), 250);
  }, 3000);
}
```

- [ ] **Step 4: Use `buildFromRepos` and start the watch channel in `applyPayload`**

Replace the body of `applyPayload` so it stores the raw map, uses `buildFromRepos`, and starts the watch channel after the first render. Replace the existing `stacks = buildModel(...)` and `allRepos = (...)...` lines with calls to the new helpers:

```js
function applyPayload(payload) {
  document.title = `stacked-prs${
    payload.rootDir ? ` · ${payload.rootDir}` : ""
  }`;
  reposByPath = new Map(
    (payload.repositories || []).map((r) => [r.path, r]),
  );
  buildFromRepos([...reposByPath.values()]);
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
  state.selectedRepos = restored.length > 0 ? new Set(restored) : present;
  if (
    state.selectedId !== ALL_ID &&
    !stacks.some((s) => s.id === state.selectedId)
  ) {
    state.selectedId = ALL_ID;
    setSelected(ALL_ID);
  }
  render();
  startWatch();
}
```

- [ ] **Step 5: Add `applyRepoUpdate` and `startWatch`**

Add after `applyPayload`:

```js
// Apply one live repo update: upsert (or drop, when it has no stacks) the repo
// in the raw map, rebuild the model, preserve the current selection (adding a
// newly appeared repo so it is visible), reconcile the selected stack, render,
// and toast.
function applyRepoUpdate(status) {
  if (!status || !status.path) return;
  const hasStacks = !!(status.status && status.status.stacks &&
    status.status.stacks.length);
  const isNew = !reposByPath.has(status.path);
  if (hasStacks) reposByPath.set(status.path, status);
  else reposByPath.delete(status.path);

  buildFromRepos([...reposByPath.values()]);

  const present = new Set(allRepos.map((r) => r.path));
  const next = new Set([...state.selectedRepos].filter((p) => present.has(p)));
  if (isNew && present.has(status.path)) next.add(status.path);
  state.selectedRepos = next;
  persistRepos(next);

  if (
    state.selectedId !== ALL_ID &&
    !stacks.some((s) => s.id === state.selectedId)
  ) {
    state.selectedId = ALL_ID;
    setSelected(ALL_ID);
  }
  render();
  toast(`${status.name || status.path} updated`);
}

// Open the live watch channel once, when the server enabled it. EventSource
// reconnects automatically on a dropped connection.
function startWatch() {
  if (watching) return;
  if (!(window.__STACKED_PRS__ && window.__STACKED_PRS__.watch)) return;
  watching = true;
  const es = new EventSource("/api/watch");
  es.addEventListener("repo-updated", (e) => {
    try {
      applyRepoUpdate(JSON.parse(e.data));
    } catch {
      // Ignore malformed updates; the next event or a reload recovers.
    }
  });
}
```

- [ ] **Step 6: Add toast styles to `serve.css`**

Append to `src/commands/serve.css`:

```css
.toast-host {
  position: fixed;
  right: 18px;
  bottom: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 9999;
  pointer-events: none;
}

.toast {
  background: #161b22;
  border: 1px solid #30363d;
  border-left: 3px solid #539bf5;
  color: #e6edf3;
  font: 500 12px/1.4 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo,
    monospace;
  padding: 10px 14px;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast--show {
  opacity: 1;
  transform: translateY(0);
}
```

- [ ] **Step 7: Run the test**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "serve client watch wiring"`
Expected: PASS.

- [ ] **Step 8: Manual verification**

Run: `deno task install` then, from a repo with a stack, `stacked-prs serve`. In another terminal create or rename a branch in that repo; the browser should re-render and show a "<repo> updated" toast without a manual reload. (Note this for the user; do not block the plan on manual confirmation.)

- [ ] **Step 9: Commit**

```bash
git add src/commands/serve.client.js src/commands/serve.css src/commands/serve.test.ts
git commit -m "feat(serve): live-update the browser view with a toast"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md` (serve architecture paragraph + serve dev-rules bullet)
- Modify: `skills/stacked-prs/SKILL.md` (serve entry + flags)
- Modify: `README.md` (serve section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `CLAUDE.md`**

In the serve architecture paragraph (the long `serve` description), add a sentence describing the live channel. Insert after the sentence describing `/api/status` ("`/api/status` remains for the buffered ... `finalizeServeStatus`."):

```
When live watch is enabled (the default; disable with `--no-watch`),
`createServeApp` also serves a long-lived `/api/watch` SSE route. After the
initial load the client opens it as a second `EventSource`; the server emits a
`ready` event, then a `repo-updated` event (one repo's fresh
`ServeRepositoryStatus`) whenever that repo changes. Two triggers feed a
coalescing per-repo reload scheduler (`createReloadScheduler`): a `Deno.watchFs`
watcher per repo (`watchRepoFs`, scoped to the git dirs from
`resolveGitWatchPaths`, filtered by `isRelevantGitChange`, debounced) and a PR
poll timer (`--poll-interval`, default 60s, 0 disables) that re-triggers
GitHub-backed repos. Each connection closes its watchers and timer on disconnect.
The client upserts the changed repo into its model and shows a transient toast.
```

In the serve dev-rules bullet (under "Development rules", the `Browser UI for serve` bullet), add after the `/api/status/stream` sentence:

```
`createServeApp` also serves `/api/watch` (long-lived SSE) when watch is enabled,
emitting `ready` then `repo-updated` events driven by a `Deno.watchFs` watcher
per repo plus a PR poll timer; `serve` gains `--no-watch` and `--poll-interval`
flags, and the rendered document inlines `window.__STACKED_PRS__ = { watch }` so
the client knows whether to open the channel.
```

Also update the serve command row in the "Script roles" table invocation column:

```
`cli.ts serve [folders...] [--port] [--host] [--no-open] [--no-watch] [--poll-interval]`
```

- [ ] **Step 2: Update `SKILL.md`**

Find the `serve` entry in the Scripts section of `skills/stacked-prs/SKILL.md` and update its invocation to include the new flags, and add a one-line note that the view live-updates by default. (Match the existing entry's wording style.) Exact invocation to document:

```
${CLAUDE_PLUGIN_ROOT}/skills/stacked-prs/scripts/stacked-prs serve [folders...] [--host <host>] [--port <port>] [--no-open] [--no-watch] [--poll-interval <seconds>]
```

- [ ] **Step 3: Update `README.md`**

In the serve section of `README.md`, add a short note that the view updates live (file watch + PR polling) and document `--no-watch` and `--poll-interval`. Keep it concise and match the surrounding style.

- [ ] **Step 4: Verify docs reference real behavior**

Run: `deno run --allow-run=git,gh,open --allow-env --allow-read --allow-net src/cli.ts serve --help`
Confirm the documented flags match the actual help output.

- [ ] **Step 5: Commit**

The `SKILL.md` change ships in the plugin, so commit it separately with `feat:`; commit the non-shipped docs with `docs:`.

```bash
git add skills/stacked-prs/SKILL.md
git commit -m "feat(skill): document serve live watch flags"
git add CLAUDE.md README.md
git commit -m "docs: document serve live watch + PR polling"
```

---

### Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full check**

Run: `deno task check`
Expected: PASS (fmt, lint, type).

- [ ] **Step 2: Full test suite**

Run: `deno task test`
Expected: PASS. If the `/api/watch` integration test is flaky on the runner, confirm the `ready`-then-mutate ordering and the bounded `readUntil` timeout are in place.

- [ ] **Step 3: Reinstall the global binary**

Run: `deno task install`
Expected: succeeds (the user runs the global binary as their daily driver).

---

## Self-Review

**Spec coverage:**
- `/api/watch` route + `ready`/`repo-updated` events → Task 5.
- Filesystem watch, git-dir resolution, relevance filter, debounce → Tasks 1, 2, 4.
- Coalescing reload guard → Task 3.
- PR poll timer (GitHub repos only, default 60s, 0 disables) → Task 5 (route) + Task 6 (flag).
- Lifecycle cleanup on disconnect → Task 5 (`finally`/`onAbort`).
- Client incremental upsert/drop, selection preservation, toast → Task 7.
- Config global injection + `--no-watch`/`--poll-interval` → Tasks 5, 6.
- Tests (pure, resolution, scheduler, watcher, route, disabled route, document global, client wiring) → Tasks 1-5, 7.
- Docs → Task 8.

**Placeholder scan:** none; every code step shows complete code.

**Type consistency:** `ServeWatchConfig { enabled, pollIntervalMs, debounceMs }` is used identically in `createServeApp`, `ServeServerOptions`, `WATCH_DISABLED`, the route, and the `cli.ts` call site. `watchRepoFs(repo, onChange, debounceMs)`, `createReloadScheduler(reload).trigger(repo)`, `resolveGitWatchPaths(dir)`, and `isRelevantGitChange(path)` signatures match across producers and consumers. `getServeHtmlForTest(watchEnabled?)` and `renderServeDocument(watchEnabled)` agree.
