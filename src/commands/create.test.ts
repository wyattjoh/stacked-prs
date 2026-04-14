import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  createTestRepo,
  makeTempDir,
  runGit,
} from "../lib/testdata/helpers.ts";
import { detectDefaultBranch } from "../lib/stack.ts";
import { create, planCreate } from "./create.ts";

/** Register `feat/a` as a stack branch on `my-stack` rooted at main. */
async function setupStackOnFeatA(dir: string): Promise<void> {
  await addBranch(dir, "feat/a", "main");
  await runGit(dir, "checkout", "feat/a");
  await runGit(dir, "config", "branch.feat/a.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/a.stack-parent", "main");
  await runGit(dir, "config", "stack.my-stack.base-branch", "main");
  await runGit(dir, "config", "stack.my-stack.merge-strategy", "merge");
}

describe("detectDefaultBranch", () => {
  test("returns main when origin/HEAD points to origin/main", async () => {
    await using repo = await createTestRepo();
    await using bare = await makeTempDir("stacked-prs-create-origin-");

    await runGit(repo.dir, "clone", "--bare", repo.dir, bare.path);
    await runGit(repo.dir, "remote", "add", "origin", bare.path);
    await runGit(repo.dir, "fetch", "origin");
    await runGit(
      repo.dir,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );

    const result = await detectDefaultBranch(repo.dir);
    expect(result).toBe("main");
  });

  test("falls back to local main when origin/HEAD is absent", async () => {
    await using repo = await createTestRepo();
    const result = await detectDefaultBranch(repo.dir);
    expect(result).toBe("main");
  });

  test("falls back to local master when main is absent", async () => {
    await using repo = await createTestRepo();
    await runGit(repo.dir, "branch", "-m", "main", "master");
    const result = await detectDefaultBranch(repo.dir);
    expect(result).toBe("master");
  });

  test("throws when neither origin/HEAD nor main/master exist", async () => {
    await using repo = await createTestRepo();
    await runGit(repo.dir, "branch", "-m", "main", "trunk");
    await expect(detectDefaultBranch(repo.dir)).rejects.toThrow(
      /default branch/i,
    );
  });
});

describe("create — case 1 (child in existing stack)", () => {
  test("plans a child branch", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    const result = await planCreate(repo.dir, { branch: "feat/b" });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("child");
    expect(result.plan?.parent).toBe("feat/a");
    expect(result.plan?.stackName).toBe("my-stack");
    expect(result.plan?.baseBranch).toBe("main");
    expect(result.plan?.willCommit).toBe(false);
  });

  test("creates a child branch and writes config", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    const result = await create(repo.dir, { branch: "feat/b" });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("child");

    const current = await runGit(repo.dir, "branch", "--show-current");
    expect(current).toBe("feat/b");

    const stackName = await runGit(
      repo.dir,
      "config",
      "branch.feat/b.stack-name",
    );
    expect(stackName).toBe("my-stack");
    const parent = await runGit(
      repo.dir,
      "config",
      "branch.feat/b.stack-parent",
    );
    expect(parent).toBe("feat/a");
  });

  test("commits staged changes when -m is passed", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    await Deno.writeTextFile(`${repo.dir}/new-file.txt`, "hello\n");
    await runGit(repo.dir, "add", "new-file.txt");

    const result = await create(repo.dir, {
      branch: "feat/b",
      message: "add new-file",
    });
    expect(result.ok).toBe(true);

    const log = await runGit(repo.dir, "log", "--format=%s", "-n", "1");
    expect(log).toBe("add new-file");
  });

  test("rejects invalid branch names", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    const result = await create(repo.dir, { branch: "has spaces" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-branch-name");
  });

  test("rejects collision with existing branch", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    await addBranch(repo.dir, "existing", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await create(repo.dir, { branch: "existing" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("branch-exists");
  });

  test("rejects flag misuse (--stack-name on child)", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    const result = await create(repo.dir, {
      branch: "feat/b",
      stackName: "other",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("flag-misuse");
  });

  test("rejects --create-worktree on child", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    const result = await create(repo.dir, {
      branch: "feat/b",
      createWorktree: "/tmp/should-not-be-used",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("worktree-requires-base");
  });

  test("rejects -m when nothing is staged", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    const result = await create(repo.dir, {
      branch: "feat/b",
      message: "noop",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("nothing-staged");
  });

  test("errors when on untracked non-base branch", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    await runGit(repo.dir, "checkout", "-b", "random");
    const result = await create(repo.dir, { branch: "feat/c" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-on-stack");
  });

  test("dry-run does not mutate", async () => {
    await using repo = await createTestRepo();
    await setupStackOnFeatA(repo.dir);

    const result = await create(repo.dir, {
      branch: "feat/b",
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("child");

    const probe = await runGit(
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/feat/b",
    ).catch(() => "");
    expect(probe).toBe("");
  });
});

describe("create — case 2 (auto-init in-repo)", () => {
  test("plans auto-init with defaulted stack name", async () => {
    await using repo = await createTestRepo();

    const result = await planCreate(repo.dir, { branch: "feat/a" });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("auto-init");
    expect(result.plan?.stackName).toBe("feat/a");
    expect(result.plan?.parent).toBe("main");
    expect(result.plan?.baseBranch).toBe("main");
    expect(result.plan?.mergeStrategy).toBe("merge");
  });

  test("creates a new stack from main", async () => {
    await using repo = await createTestRepo();

    const result = await create(repo.dir, { branch: "feat/a" });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("auto-init");

    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-name"),
    ).toBe("feat/a");
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-parent"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "stack.feat/a.base-branch"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "stack.feat/a.merge-strategy"),
    ).toBe("merge");
  });

  test("honors explicit --stack-name and --merge-strategy", async () => {
    await using repo = await createTestRepo();

    const result = await create(repo.dir, {
      branch: "feat/a",
      stackName: "my-stack",
      mergeStrategy: "squash",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.stackName).toBe("my-stack");
    expect(result.plan?.mergeStrategy).toBe("squash");
    expect(
      await runGit(repo.dir, "config", "stack.my-stack.merge-strategy"),
    ).toBe("squash");
  });

  test("rejects when stack-name already exists", async () => {
    await using repo = await createTestRepo();

    await runGit(repo.dir, "config", "stack.taken.base-branch", "main");

    const result = await create(repo.dir, {
      branch: "feat/a",
      stackName: "taken",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stack-exists");
  });

  test("commits staged changes when -m is passed", async () => {
    await using repo = await createTestRepo();

    await Deno.writeTextFile(`${repo.dir}/file.txt`, "hi\n");
    await runGit(repo.dir, "add", "file.txt");

    const result = await create(repo.dir, {
      branch: "feat/a",
      message: "add file",
    });
    expect(result.ok).toBe(true);

    const log = await runGit(repo.dir, "log", "--format=%s", "-n", "1");
    expect(log).toBe("add file");
  });

  test("rejects -m when nothing is staged", async () => {
    await using repo = await createTestRepo();

    const result = await create(repo.dir, {
      branch: "feat/a",
      message: "noop",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("nothing-staged");
  });

  test("pre-check: rejects stack names with regex metacharacters that would collide", async () => {
    await using repo = await createTestRepo();

    // Write a stack named "foo"; then try to create with --stack-name "f.o"
    // which previously would have regex-matched "foo".
    await runGit(repo.dir, "config", "stack.foo.base-branch", "main");

    const result = await create(repo.dir, {
      branch: "feat/a",
      stackName: "f.o",
    });
    // With regex escape, "f.o" is a distinct literal name and succeeds.
    expect(result.ok).toBe(true);
    expect(result.plan?.stackName).toBe("f.o");
  });
});

describe("create — case 3 (auto-init worktree)", () => {
  test("creates worktree without -m; main stays checked out", async () => {
    await using repo = await createTestRepo();
    await using wt = await makeTempDir("stacked-prs-wt-");

    const result = await create(repo.dir, {
      branch: "feat/a",
      createWorktree: wt.path,
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("auto-init-worktree");
    expect(result.plan?.worktreePath).toBe(`${wt.path}/feat/a`);

    expect(await runGit(repo.dir, "branch", "--show-current")).toBe("main");

    const worktreeBranch = await runGit(
      `${wt.path}/feat/a`,
      "branch",
      "--show-current",
    );
    expect(worktreeBranch).toBe("feat/a");

    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-name"),
    ).toBe("feat/a");
  });

  test("creates worktree with -m; commit lands on new branch", async () => {
    await using repo = await createTestRepo();
    await using wt = await makeTempDir("stacked-prs-wt-");

    await Deno.writeTextFile(`${repo.dir}/staged.txt`, "hi\n");
    await runGit(repo.dir, "add", "staged.txt");

    const result = await create(repo.dir, {
      branch: "feat/a",
      message: "add staged",
      createWorktree: wt.path,
    });
    expect(result.ok).toBe(true);

    expect(await runGit(repo.dir, "branch", "--show-current")).toBe("main");

    const log = await runGit(
      `${wt.path}/feat/a`,
      "log",
      "--format=%s",
      "-n",
      "1",
    );
    expect(log).toBe("add staged");

    // main never picked up the commit.
    const mainLog = await runGit(
      repo.dir,
      "log",
      "main",
      "--format=%s",
      "-n",
      "1",
    );
    expect(mainLog).not.toBe("add staged");
  });

  test("supports branch names with slashes", async () => {
    await using repo = await createTestRepo();
    await using wt = await makeTempDir("stacked-prs-wt-");

    const result = await create(repo.dir, {
      branch: "wyattjoh/feat/colors",
      createWorktree: wt.path,
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.worktreePath).toBe(
      `${wt.path}/wyattjoh/feat/colors`,
    );

    const stat = await Deno.stat(
      `${wt.path}/wyattjoh/feat/colors/README.md`,
    );
    expect(stat.isFile).toBe(true);
  });

  test("rejects when worktree target already exists (non-empty dir)", async () => {
    await using repo = await createTestRepo();
    await using wt = await makeTempDir("stacked-prs-wt-");

    // git worktree add accepts an empty directory but rejects a non-empty one
    // with "already exists". Pre-populate so git itself fires the conflict.
    await Deno.mkdir(`${wt.path}/feat/a`, { recursive: true });
    await Deno.writeTextFile(`${wt.path}/feat/a/conflict.txt`, "oops\n");

    const result = await create(repo.dir, {
      branch: "feat/a",
      createWorktree: wt.path,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("worktree-exists");
  });

  test("pre-check rejects existing worktree path before any git mutation", async () => {
    await using repo = await createTestRepo();
    await using wt = await makeTempDir("stacked-prs-wt-");

    await Deno.mkdir(`${wt.path}/feat/a`, { recursive: true });

    const result = await create(repo.dir, {
      branch: "feat/a",
      createWorktree: wt.path,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("worktree-exists");

    // No new branch created.
    const probe = await runGit(
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/feat/a",
    ).catch(() => "");
    expect(probe).toBe("");
  });

  test("rejects -m when nothing is staged (leaves repo on base, no new branch)", async () => {
    await using repo = await createTestRepo();
    await using wt = await makeTempDir("stacked-prs-wt-");

    const result = await create(repo.dir, {
      branch: "feat/a",
      message: "noop",
      createWorktree: wt.path,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("nothing-staged");

    // Rollback verification: current repo still on main, no orphan branch.
    expect(await runGit(repo.dir, "branch", "--show-current")).toBe("main");
    const probe = await runGit(
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/feat/a",
    ).catch(() => "");
    expect(probe).toBe("");
  });
});
