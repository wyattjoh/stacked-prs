import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  createTestRepo,
  makeMockDir,
  makeTempDir,
} from "../lib/testdata/helpers.ts";
import { runGitCommand, setBaseBranch, setStackNode } from "../lib/stack.ts";
import { setCallLog, writeErrorFixture, writeFixture } from "../lib/gh.ts";
import { computeSubmitPlan } from "../lib/submit-plan.ts";
import { executeSubmit, renderSubmitPlan } from "./submit.ts";

function makeCallLog(): AsyncDisposable & { calls: string[][] } {
  const calls: string[][] = [];
  setCallLog(calls);
  return {
    calls,
    [Symbol.asyncDispose]: () => {
      setCallLog(undefined);
      return Promise.resolve();
    },
  };
}

describe("executeSubmit", () => {
  test("creates PRs with correct base and draft flags", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await using log = makeCallLog();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setStackNode(repo.dir, "feat/b", "my-stack", "feat/a");

    // Return a URL string from `gh pr create` so number parsing succeeds.
    await writeFixture(
      mock.path,
      [
        "pr",
        "create",
        "--repo",
        "o/r",
        "--base",
        "main",
        "--head",
        "feat/a",
        "--fill",
      ],
      "https://github.com/o/r/pull/101",
    );
    await writeFixture(
      mock.path,
      [
        "pr",
        "create",
        "--repo",
        "o/r",
        "--base",
        "feat/a",
        "--head",
        "feat/b",
        "--fill",
        "--draft",
      ],
      "https://github.com/o/r/pull/102",
    );

    // Stub the push with a noop remote so git push can't actually reach
    // anywhere. executeSubmit invokes `git push --force-with-lease origin ...`;
    // createTestRepo doesn't configure a remote, so the push will fail. We
    // sidestep that by wiring up a bare origin.
    const bare = await makeTempDir("bare-");
    await (await import("../lib/stack.ts")).runGitCommand(
      repo.dir,
      "init",
      "--bare",
      "-q",
      bare.path,
    );
    await (await import("../lib/stack.ts")).runGitCommand(
      repo.dir,
      "remote",
      "add",
      "origin",
      bare.path,
    );

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");
    const result = await executeSubmit(repo.dir, plan, "o", "r");

    expect(result.ok).toBe(true);
    expect(result.pushedBranches).toEqual(["feat/a", "feat/b"]);
    expect(result.prsCreated.map((p) => p.branch)).toEqual([
      "feat/a",
      "feat/b",
    ]);

    const createCalls = log.calls.filter((c) =>
      c[0] === "pr" && c[1] === "create"
    );
    // Root branch is ready-for-review (parent === base), child is draft.
    expect(createCalls[0]).not.toContain("--draft");
    expect(createCalls[1]).toContain("--draft");

    await bare[Symbol.asyncDispose]();
  });

  test("retargets PR base when parent changes", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await using log = makeCallLog();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setStackNode(repo.dir, "feat/b", "my-stack", "feat/a");

    // Existing PR for feat/b has a stale baseRefName (still "main").
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 101,
        url: "https://github.com/o/r/pull/101",
        title: "a",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
      }],
    );
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/b", "--repo", "o/r"],
      [{
        number: 102,
        url: "https://github.com/o/r/pull/102",
        title: "b",
        state: "OPEN",
        isDraft: true,
        baseRefName: "main", // stale — should be feat/a after submit
      }],
    );

    const bare = await makeTempDir("bare-");
    await runGitCommand(repo.dir, "init", "--bare", "-q", bare.path);
    await runGitCommand(repo.dir, "remote", "add", "origin", bare.path);

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");
    const result = await executeSubmit(repo.dir, plan, "o", "r");
    expect(result.ok).toBe(true);
    expect(result.prsBaseUpdated).toEqual([
      { branch: "feat/b", number: 102, newBase: "feat/a" },
    ]);
    const editCalls = log.calls.filter((c) => c[0] === "pr" && c[1] === "edit");
    expect(editCalls[0]).toEqual([
      "pr",
      "edit",
      "102",
      "--repo",
      "o/r",
      "--base",
      "feat/a",
    ]);

    await bare[Symbol.asyncDispose]();
  });

  test("flips root PR from draft to ready when parent is base", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await using log = makeCallLog();
    await addBranch(repo.dir, "feat/a", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");

    // Existing draft PR on root; desiredDraft=false so it should flip to ready.
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 101,
        url: "https://github.com/o/r/pull/101",
        title: "a",
        state: "OPEN",
        isDraft: true,
        baseRefName: "main",
      }],
    );

    const bare = await makeTempDir("bare-");
    await runGitCommand(repo.dir, "init", "--bare", "-q", bare.path);
    await runGitCommand(repo.dir, "remote", "add", "origin", bare.path);

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");
    const result = await executeSubmit(repo.dir, plan, "o", "r");
    expect(result.ok).toBe(true);
    expect(result.draftTransitions).toEqual([
      { branch: "feat/a", number: 101, to: "ready" },
    ]);
    const readyCalls = log.calls.filter((c) =>
      c[0] === "pr" && c[1] === "ready"
    );
    expect(readyCalls[0]).not.toContain("--undo");

    await bare[Symbol.asyncDispose]();
  });

  test("surfaces gh create failures as thrown errors", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");

    await writeErrorFixture(
      mock.path,
      [
        "pr",
        "create",
        "--repo",
        "o/r",
        "--base",
        "main",
        "--head",
        "feat/a",
        "--fill",
      ],
      "API rate limit exceeded for installation 12345",
    );

    const bare = await makeTempDir("bare-");
    await runGitCommand(repo.dir, "init", "--bare", "-q", bare.path);
    await runGitCommand(repo.dir, "remote", "add", "origin", bare.path);

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");
    await expect(executeSubmit(repo.dir, plan, "o", "r")).rejects.toThrow(
      /rate limit/i,
    );

    await bare[Symbol.asyncDispose]();
  });

  test("posts nav comments for freshly-created PRs", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await using log = makeCallLog();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setStackNode(repo.dir, "feat/b", "my-stack", "feat/a");

    // No existing PRs at plan time — the initial nav plan will be empty.
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [],
    );
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/b", "--repo", "o/r"],
      [],
    );

    // gh pr create returns URLs so executeSubmit can record PR numbers.
    await writeFixture(
      mock.path,
      [
        "pr",
        "create",
        "--repo",
        "o/r",
        "--base",
        "main",
        "--head",
        "feat/a",
        "--fill",
      ],
      "https://github.com/o/r/pull/101",
    );
    await writeFixture(
      mock.path,
      [
        "pr",
        "create",
        "--repo",
        "o/r",
        "--base",
        "feat/a",
        "--head",
        "feat/b",
        "--fill",
        "--draft",
      ],
      "https://github.com/o/r/pull/102",
    );

    // After creation, a second nav-plan pass re-queries pr list and sees the
    // PRs, then fetches existing comments (none yet).
    await writeFixture(
      mock.path,
      ["api", "repos/o/r/issues/101/comments"],
      [],
    );
    await writeFixture(
      mock.path,
      ["api", "repos/o/r/issues/102/comments"],
      [],
    );

    const bare = await makeTempDir("bare-");
    await runGitCommand(repo.dir, "init", "--bare", "-q", bare.path);
    await runGitCommand(repo.dir, "remote", "add", "origin", bare.path);

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");
    expect(plan.navComments).toEqual([]);

    // After creating PRs, update the pr-list fixture so the post-create nav
    // rebuild sees them. writeFixture overwrites any prior fixture at the
    // same key.
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 101,
        url: "https://github.com/o/r/pull/101",
        title: "a",
        state: "OPEN",
        isDraft: false,
      }],
    );
    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/b", "--repo", "o/r"],
      [{
        number: 102,
        url: "https://github.com/o/r/pull/102",
        title: "b",
        state: "OPEN",
        isDraft: true,
      }],
    );

    const result = await executeSubmit(repo.dir, plan, "o", "r");
    expect(result.ok).toBe(true);
    expect(result.navCommentsApplied).toBe(2);
    const commentCalls = log.calls.filter((c) =>
      c[0] === "pr" && c[1] === "comment"
    );
    expect(commentCalls.map((c) => c[2]).sort()).toEqual(["101", "102"]);

    await bare[Symbol.asyncDispose]();
  });

  test("renderSubmitPlan handles the no-op case", () => {
    const plan = {
      stackName: "s",
      mergeStrategy: "merge" as const,
      branches: [],
      navComments: [],
      isNoOp: true,
    };
    expect(renderSubmitPlan(plan)).toContain("All PRs are up to date");
  });

  test("computeSubmitPlan with a tombstone present produces no work for the tombstone", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feat/live", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/live", "my-stack", "main");
    await addTombstone(repo.dir, "my-stack", "feat/landed", { prNumber: 121 });

    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/live", "--repo", "o/r"],
      [{
        number: 121,
        url: "https://github.com/o/r/pull/121",
        title: "live",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
      }],
    );

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");
    expect(plan.branches.map((b) => b.branch)).toEqual(["feat/live"]);
    expect(plan.branches.find((b) => b.branch === "feat/landed"))
      .toBeUndefined();
  });
});
