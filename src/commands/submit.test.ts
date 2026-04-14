import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  createTestRepo,
  makeTempDir,
} from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import { setCallLog, setMockDir, writeFixture } from "../lib/gh.ts";
import { computeSubmitPlan } from "./submit-plan.ts";
import { executeSubmit, renderSubmitPlan } from "./submit.ts";

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
});
