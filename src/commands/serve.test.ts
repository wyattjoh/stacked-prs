import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, normalize } from "@std/path";
import {
  addBranch,
  createTestRepo,
  makeTempDir,
  runGit,
} from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackArchived, setStackNode } from "../lib/stack.ts";
import {
  buildServeBranchGraph,
  buildServeSharedStackGroups,
  buildServeStatus,
  createReloadScheduler,
  createServeApp,
  describeRelevantGitChange,
  formatServeReloadDebugMessage,
  getServeHtmlForTest,
  isRelevantGitChange,
  loadRepositoryStatuses,
  parseGitHubRemote,
  resolveGitWatchPaths,
  resolveServeRepositories,
  type ServeReloadReason,
  type ServeRepository,
  type ServeRepositoryStatus,
  watchRepoFs,
} from "./serve.ts";
import type { StackStatus } from "./status.ts";

describe("resolveServeRepositories", () => {
  test("defaults to the current directory when no folders are provided", async () => {
    await using repo = await createTestRepo();

    const repos = await resolveServeRepositories(repo.dir, []);

    expect(repos).toEqual([{
      name: repo.dir.split("/").at(-1),
      path: repo.dir,
    }]);
  });

  test("resolves explicitly provided nested repository folders", async () => {
    await using root = await makeTempDir("stacked-prs-serve-root-");
    const nestedParent = join(root.path, "nested-parent");
    const nestedRepo = join(nestedParent, "nested");

    await Deno.mkdir(nestedRepo, { recursive: true });
    await runGit(nestedRepo, "init", "--initial-branch=main");

    const repos = await resolveServeRepositories(root.path, [
      "nested-parent/nested",
    ]);

    expect(repos).toEqual([{
      name: "nested",
      path: nestedRepo,
    }]);
  });
});

describe("buildServeStatus", () => {
  test("includes CLI status metadata for each provided repository", async () => {
    await using repo = await createTestRepo();
    const repository = { name: "repo-a", path: repo.dir };

    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");
    await setStackNode(repo.dir, "feature/a", "serve-stack", "main");
    await setStackNode(repo.dir, "feature/b", "serve-stack", "feature/a");
    await setBaseBranch(repo.dir, "serve-stack", "main");

    const status = await buildServeStatus([repository]);

    expect(status.repositories).toHaveLength(1);
    expect(status.repositories[0].name).toBe("repo-a");
    expect(status.repositories[0].status?.stacks[0]).toMatchObject({
      stackName: "serve-stack",
      baseBranch: "main",
      archived: false,
      branches: [
        {
          branch: "feature/a",
          parent: "main",
          depth: 0,
          childCount: 1,
          syncStatus: "up-to-date",
        },
        {
          branch: "feature/b",
          parent: "feature/a",
          depth: 1,
          childCount: 0,
          syncStatus: "up-to-date",
        },
      ],
    });
  });

  test("surfaces the archived flag in the browser payload", async () => {
    await using repo = await createTestRepo();
    const repository = { name: "repo-a", path: repo.dir };

    await addBranch(repo.dir, "feature/a", "main");
    await setStackNode(repo.dir, "feature/a", "serve-stack", "main");
    await setBaseBranch(repo.dir, "serve-stack", "main");
    await setStackArchived(repo.dir, "serve-stack", true);

    const status = await buildServeStatus([repository]);
    const stack = status.repositories[0].status?.stacks.find(
      (s) => s.stackName === "serve-stack",
    );
    expect(stack?.archived).toBe(true);
  });

  test("excludes repositories with no stacked PR metadata", async () => {
    await using stackedRepo = await createTestRepo();
    await using plainRepo = await createTestRepo();

    await addBranch(stackedRepo.dir, "feature/a", "main");
    await setStackNode(stackedRepo.dir, "feature/a", "serve-stack", "main");
    await setBaseBranch(stackedRepo.dir, "serve-stack", "main");

    const status = await buildServeStatus([
      { name: "stacked", path: stackedRepo.dir },
      { name: "plain", path: plainRepo.dir },
    ]);

    expect(status.repositories.map((repo) => repo.name)).toEqual(["stacked"]);
  });
});

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

describe("buildServeBranchGraph", () => {
  test("creates lane metadata for forked stack branches", () => {
    const stack: StackStatus = {
      stackName: "serve-stack",
      baseBranch: "main",
      mergeStrategy: "squash",
      archived: false,
      latestCommitAt: null,
      display: "",
      branches: [
        branchStatus("feature/root", "main", 0, 2),
        branchStatus("feature/goal", "feature/root", 1, 1),
        branchStatus("feature/goal-details", "feature/goal", 2, 0),
        branchStatus("feature/habit", "feature/root", 1, 0),
      ],
    };

    const graph = buildServeBranchGraph(stack);

    expect(graph.maxLane).toBe(1);
    expect(graph.rows.map((row) => ({
      branch: row.branch,
      lane: row.lane,
      isFork: row.isFork,
      forkTargets: row.forkTargets.map((target) => target.lane),
      rails: row.rails.map((rail) => ({
        lane: rail.lane,
        up: rail.up,
        down: rail.down,
      })),
    }))).toEqual([
      // Parent-first ordering: the fork parent is followed immediately by its
      // branching child (lane 1), then the primary arm continues in lane 0. The
      // lane-1 rail spans only root -> habit (root has down, habit has up), so
      // the primary arm stays a clean continuous trunk in lane 0 with no
      // crossing or fused segment passing through it.
      {
        branch: "feature/root",
        lane: 0,
        isFork: true,
        forkTargets: [1],
        rails: [
          { lane: 0, up: false, down: true },
          { lane: 1, up: false, down: true },
        ],
      },
      {
        branch: "feature/habit",
        lane: 1,
        isFork: false,
        forkTargets: [],
        rails: [
          { lane: 0, up: true, down: true },
          { lane: 1, up: true, down: false },
        ],
      },
      {
        branch: "feature/goal",
        lane: 0,
        isFork: false,
        forkTargets: [],
        rails: [
          { lane: 0, up: true, down: true },
        ],
      },
      {
        branch: "feature/goal-details",
        lane: 0,
        isFork: false,
        forkTargets: [],
        rails: [
          { lane: 0, up: true, down: false },
        ],
      },
    ]);
  });
});

describe("buildServeSharedStackGroups", () => {
  test("groups matching stack names across repositories with repository root nodes", () => {
    const repositories: ServeRepositoryStatus[] = [
      repositoryStatus("api", [
        stackStatus("checkout", [
          branchStatus("feature/api-root", "main", 0, 1),
          branchStatus("feature/api-child", "feature/api-root", 1, 0),
        ]),
        stackStatus("api-only", [
          branchStatus("feature/private", "main", 0, 0),
        ]),
      ]),
      repositoryStatus("web", [
        stackStatus("checkout", [
          branchStatus("feature/web-root", "main", 0, 0),
        ]),
      ]),
    ];

    const groups = buildServeSharedStackGroups(repositories);

    expect(groups.map((group) => group.stackName)).toEqual(["checkout"]);
    expect(groups[0].repositories.map((repo) => repo.name)).toEqual([
      "api",
      "web",
    ]);
    expect(groups[0].graph.rows.map((row) => ({
      label: row.label,
      nodeKind: row.nodeKind,
      repositoryName: row.repositoryName,
      sourceBranch: row.sourceBranch,
      lane: row.lane,
      forkTargets: row.forkTargets.map((target) => target.lane),
    }))).toEqual([
      {
        label: "api",
        nodeKind: "repository",
        repositoryName: "api",
        sourceBranch: null,
        lane: 0,
        forkTargets: [1],
      },
      {
        label: "main",
        nodeKind: "base",
        repositoryName: "api",
        sourceBranch: null,
        lane: 1,
        forkTargets: [],
      },
      {
        label: "feature/api-root",
        nodeKind: "branch",
        repositoryName: "api",
        sourceBranch: "feature/api-root",
        lane: 1,
        forkTargets: [],
      },
      {
        label: "feature/api-child",
        nodeKind: "branch",
        repositoryName: "api",
        sourceBranch: "feature/api-child",
        lane: 1,
        forkTargets: [],
      },
      {
        label: "web",
        nodeKind: "repository",
        repositoryName: "web",
        sourceBranch: null,
        lane: 0,
        forkTargets: [1],
      },
      {
        label: "main",
        nodeKind: "base",
        repositoryName: "web",
        sourceBranch: null,
        lane: 1,
        forkTargets: [],
      },
      {
        label: "feature/web-root",
        nodeKind: "branch",
        repositoryName: "web",
        sourceBranch: "feature/web-root",
        lane: 1,
        forkTargets: [],
      },
    ]);
  });
});

describe("parseGitHubRemote", () => {
  test("parses common GitHub origin URL forms", () => {
    expect(parseGitHubRemote("git@github.com:wyattjoh/stacked-prs.git"))
      .toEqual({
        owner: "wyattjoh",
        repo: "stacked-prs",
      });
    expect(parseGitHubRemote("https://github.com/wyattjoh/stacked-prs"))
      .toEqual({
        owner: "wyattjoh",
        repo: "stacked-prs",
      });
  });
});

describe("getServeHtmlForTest", () => {
  test("serves the stack view shell with inlined css and client", async () => {
    const html = await getServeHtmlForTest();
    expect(html).toContain('<div id="app" class="page"></div>');
    expect(html).toContain("Stacks across repositories");
    expect(html).toContain(".app-content");
    expect(html).toContain(".repo-load-row");
  });
});

describe("createServeApp", () => {
  test("serves the SPA shell at the root", async () => {
    const app = createServeApp("/tmp/root", []);

    const root = await app.request("/");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('<div id="app" class="page"></div>');
  });

  test("no longer serves stack deep-links", async () => {
    const app = createServeApp("/tmp/root", []);

    const deepLink = await app.request("/stack/wyattjoh%2Fserve-command");
    expect(deepLink.status).toBe(404);
  });

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
});

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

  test("describes the git file category that caused a relevant change", () => {
    expect(describeRelevantGitChange("/r/.git/refs/heads/feature")).toBe(
      "refs",
    );
    expect(describeRelevantGitChange("/r/.git/packed-refs")).toBe(
      "packed-refs",
    );
    expect(describeRelevantGitChange("/r/.git/config")).toBe("config");
    expect(describeRelevantGitChange("/r/.git/HEAD")).toBe("HEAD");
    expect(describeRelevantGitChange("/r/.git/ORIG_HEAD")).toBe("ORIG_HEAD");
    expect(describeRelevantGitChange("/r/.git/objects/ab/cdef")).toBeNull();
    expect(describeRelevantGitChange("/r/.git/index")).toBeNull();
  });
});

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
    const reason: ServeReloadReason = {
      kind: "pr-poll",
      intervalMs: 60000,
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    scheduler.trigger(repo, reason); // starts reload #1
    scheduler.trigger(repo, reason); // in-flight -> pending
    scheduler.trigger(repo, reason); // in-flight -> still pending (deduped)
    expect(calls).toEqual(["/a"]);

    const finishFirst = resolveCurrent!;
    finishFirst(); // completes #1 -> pending fires reload #2
    await flush();
    expect(calls).toEqual(["/a", "/a"]);

    resolveCurrent!(); // completes #2 -> no pending left
    await flush();
    expect(calls).toEqual(["/a", "/a"]);
  });

  test("passes the trigger reason into each reload", async () => {
    const reasons: ServeReloadReason[] = [];
    let resolveCurrent: (() => void) | undefined;
    const reload = (_repo: ServeRepository, reason: ServeReloadReason) => {
      reasons.push(reason);
      return new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
    };
    const scheduler = createReloadScheduler(reload);
    const repo: ServeRepository = { name: "a", path: "/a" };
    const prPoll: ServeReloadReason = {
      kind: "pr-poll",
      intervalMs: 60000,
    };
    const configChange: ServeReloadReason = {
      kind: "git-watch",
      changes: [{
        eventKind: "modify",
        path: "/a/.git/config",
        category: "config",
      }],
    };
    const headChange: ServeReloadReason = {
      kind: "git-watch",
      changes: [{
        eventKind: "modify",
        path: "/a/.git/HEAD",
        category: "HEAD",
      }],
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    scheduler.trigger(repo, prPoll);
    scheduler.trigger(repo, configChange);
    scheduler.trigger(repo, headChange);

    expect(reasons).toEqual([prPoll]);
    resolveCurrent!();
    await flush();
    expect(reasons).toEqual([prPoll, headChange]);

    resolveCurrent!();
    await flush();
  });
});

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

describe("formatServeReloadDebugMessage", () => {
  test("formats git watch refresh reasons", () => {
    const repo: ServeRepository = { name: "repo-a", path: "/repo/a" };
    const reason: ServeReloadReason = {
      kind: "git-watch",
      changes: [
        {
          eventKind: "modify",
          path: "/repo/a/.git/config",
          category: "config",
        },
        {
          eventKind: "create",
          path: "/repo/a/.git/refs/heads/feature",
          category: "refs",
        },
      ],
    };

    expect(formatServeReloadDebugMessage(repo, reason)).toBe(
      "[stacked-prs:debug] refresh repo-a (/repo/a): git watch changed config via modify at /repo/a/.git/config; refs via create at /repo/a/.git/refs/heads/feature",
    );
  });

  test("formats PR poll refresh reasons", () => {
    const repo: ServeRepository = { name: "repo-a", path: "/repo/a" };
    const reason: ServeReloadReason = {
      kind: "pr-poll",
      intervalMs: 60000,
    };

    expect(formatServeReloadDebugMessage(repo, reason)).toBe(
      "[stacked-prs:debug] refresh repo-a (/repo/a): PR poll interval elapsed (60s)",
    );
  });
});

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

describe("serve client watch wiring", () => {
  test("client subscribes to repo-updated on the watch channel", async () => {
    const html = await getServeHtmlForTest(true);
    expect(html).toContain('new EventSource("/api/watch")');
    expect(html).toContain('"repo-updated"');
    expect(html).toContain("toast-host");
  });

  test("client includes muted branch and stack name actions", async () => {
    const html = await getServeHtmlForTest(true);

    expect(html).toContain("copy-name-button");
    expect(html).toContain("filter-stack-button");
    expect(html).toContain("stack-header-row");
    expect(html).toContain("navigator.clipboard.writeText");
    expect(html).toContain("Copy branch name");
    expect(html).toContain("Copy stack name");
    expect(html).toContain("Show only this stack");
    expect(html).toContain(".name-action-button");
    expect(html).toContain(".name-action-group");
    expect(html).toContain(".branch-row:hover .name-action-group");
    expect(html).toContain(".stack-header-row:hover .name-action-group");
    expect(html).toContain("btn.blur()");
    expect(html).toContain(".name-action-button:focus-visible");
    expect(html).not.toContain(".branch-row:focus-within .name-action-group");
    expect(html).not.toContain(
      ".stack-header-row:focus-within .name-action-group",
    );
    expect(html).not.toContain("name-actions-dismissed");
    expect(html).toContain("selectStack(stackId)");
  });
});

function branchStatus(
  branch: string,
  parent: string,
  depth: number,
  childCount: number,
) {
  return {
    branch,
    parent,
    depth,
    isLastChild: childCount === 0,
    childCount,
    pr: null,
    syncStatus: "up-to-date" as const,
    isCurrent: false,
  };
}

function stackStatus(
  stackName: string,
  branches: StackStatus["branches"],
): StackStatus {
  return {
    stackName,
    baseBranch: "main",
    mergeStrategy: "squash",
    archived: false,
    latestCommitAt: null,
    branches,
    display: "",
  };
}

function repositoryStatus(
  name: string,
  stacks: StackStatus[],
): ServeRepositoryStatus {
  return {
    name,
    path: "/tmp/" + name,
    github: null,
    status: {
      stacks: stacks.map((stack) => ({
        ...stack,
        graph: buildServeBranchGraph(stack),
      })),
      display: "",
    },
    prMetadata: "not-github",
    error: null,
  };
}
