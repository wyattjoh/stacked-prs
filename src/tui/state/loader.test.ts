import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  createTestRepo,
  makeTempDir,
} from "../../lib/testdata/helpers.ts";
import {
  addLandedBranch,
  addLandedPr,
  runGitCommand,
  setBaseBranch,
  setStackNode,
} from "../../lib/stack.ts";
import { setMockDir, writeFixture } from "../../lib/gh.ts";
import { loadLocal, loadPrsProgressive } from "./loader.ts";

/** Acquire a temp mock dir, register it, and reset on disposal. */
async function makeMockDir(): Promise<AsyncDisposable & { path: string }> {
  const dir = await makeTempDir("stacked-prs-mock-");
  setMockDir(dir.path);
  return {
    path: dir.path,
    [Symbol.asyncDispose]: async () => {
      setMockDir(undefined);
      await dir[Symbol.asyncDispose]();
    },
  };
}

describe("loadLocal", () => {
  test("returns trees and sync map for configured stacks", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "alpha", "main");
    await setBaseBranch(repo.dir, "alpha", "main");

    const result = await loadLocal(repo.dir);
    expect(result.trees).toHaveLength(1);
    expect(result.trees[0].stackName).toBe("alpha");
    expect(result.syncByBranch.get("feat/a")).toBeDefined();
    expect(result.allBranches).toContain("feat/a");
  });
});

describe("loadLocal with merged nodes", () => {
  test("sets 'landed' sync status for stack-merged branches", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "main");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    // Mark feature/a as historically merged; branch ref still exists in config
    await runGitCommand(
      repo.dir,
      "config",
      "branch.feature/a.stack-merged",
      "true",
    );

    const result = await loadLocal(repo.dir);
    expect(result.syncByBranch.get("feature/a")).toBe("landed");
    expect(result.syncByBranch.get("feature/b")).toBe("up-to-date");
  });

  test("seeds landedPrByBranch for tombstoned (deleted) branches", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/b", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    // Simulate a landed & deleted feature/a: tombstone + stored PR number,
    // no live ref or branch-level config.
    await addLandedBranch(repo.dir, "my-stack", "feature/a");
    await addLandedPr(repo.dir, "my-stack", "feature/a", 101);

    const result = await loadLocal(repo.dir);
    expect(result.syncByBranch.get("feature/a")).toBe("landed");
    expect(result.allBranches).toContain("feature/a");
    const pr = result.landedPrByBranch.get("feature/a");
    expect(pr).toBeDefined();
    expect(pr!.number).toBe(101);
    expect(pr!.state).toBe("MERGED");
    expect(pr!.isDraft).toBe(false);
    // Live branches are NOT in the landed map.
    expect(result.landedPrByBranch.has("feature/b")).toBe(false);
  });
});

describe("loadPrsProgressive", () => {
  test("invokes onLoaded for each branch", async () => {
    await using _repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/a"],
      [{ number: 1, url: "u", state: "OPEN", isDraft: false }],
    );
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/b"],
      [],
    );

    const loaded: Array<{ branch: string; pr: unknown }> = [];
    await loadPrsProgressive({
      branches: ["feat/a", "feat/b"],
      concurrency: 2,
      onLoaded: (branch, pr) => loaded.push({ branch, pr }),
      onError: () => {},
    });

    expect(loaded).toHaveLength(2);
    const byBranch = new Map(loaded.map((l) => [l.branch, l.pr]));
    expect(byBranch.get("feat/a")).toMatchObject({ number: 1 });
    expect(byBranch.get("feat/b")).toBe(null);
  });

  test("surfaces merged PR when no open PR exists", async () => {
    await using _repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/landed"],
      [{
        number: 117,
        url: "https://github.com/o/r/pull/117",
        state: "MERGED",
        isDraft: false,
        createdAt: "2026-04-07T00:00:00Z",
      }],
    );

    const loaded: Array<{ branch: string; pr: unknown }> = [];
    await loadPrsProgressive({
      branches: ["feat/landed"],
      concurrency: 1,
      onLoaded: (branch, pr) => loaded.push({ branch, pr }),
      onError: () => {},
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].pr).toMatchObject({ number: 117, state: "MERGED" });
  });

  test("prefers open PR over merged PR on same head ref", async () => {
    await using _repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/reopened"],
      [
        {
          number: 200,
          url: "https://github.com/o/r/pull/200",
          state: "OPEN",
          isDraft: false,
          createdAt: "2026-04-08T00:00:00Z",
        },
        {
          number: 199,
          url: "https://github.com/o/r/pull/199",
          state: "MERGED",
          isDraft: false,
          createdAt: "2026-04-01T00:00:00Z",
        },
      ],
    );

    const loaded: Array<{ branch: string; pr: unknown }> = [];
    await loadPrsProgressive({
      branches: ["feat/reopened"],
      concurrency: 1,
      onLoaded: (branch, pr) => loaded.push({ branch, pr }),
      onError: () => {},
    });

    expect(loaded[0].pr).toMatchObject({ number: 200, state: "OPEN" });
  });

  test("aborts cleanly when signal triggers", async () => {
    await using _repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/a"],
      [],
    );

    const controller = new AbortController();
    controller.abort();

    const loaded: string[] = [];
    await loadPrsProgressive({
      branches: ["feat/a"],
      concurrency: 1,
      signal: controller.signal,
      onLoaded: (b) => loaded.push(b),
      onError: () => {},
    });

    expect(loaded).toHaveLength(0);
  });
});
