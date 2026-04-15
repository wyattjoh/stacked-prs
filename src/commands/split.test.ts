import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createTestRepo, runGit } from "../lib/testdata/helpers.ts";
import { planSplit, split } from "./split.ts";

/**
 * Build a linear stack where feat/a has multiple commits touching multiple
 * files. Returns the map of commit messages -> SHA for predictable `at` refs.
 */
async function setupMultiCommitStack(dir: string): Promise<string[]> {
  await runGit(dir, "checkout", "-b", "feat/a");
  await Deno.writeTextFile(`${dir}/file1.txt`, "v1\n");
  await runGit(dir, "add", "file1.txt");
  await runGit(dir, "commit", "-m", "c1");
  const c1 = await runGit(dir, "rev-parse", "HEAD");

  await Deno.writeTextFile(`${dir}/file2.txt`, "v1\n");
  await runGit(dir, "add", "file2.txt");
  await runGit(dir, "commit", "-m", "c2");
  const c2 = await runGit(dir, "rev-parse", "HEAD");

  await Deno.writeTextFile(`${dir}/file3.txt`, "v1\n");
  await runGit(dir, "add", "file3.txt");
  await runGit(dir, "commit", "-m", "c3");
  const c3 = await runGit(dir, "rev-parse", "HEAD");

  await runGit(dir, "config", "branch.feat/a.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/a.stack-parent", "main");
  await runGit(dir, "config", "stack.my-stack.base-branch", "main");
  await runGit(dir, "config", "stack.my-stack.merge-strategy", "merge");

  return [c1, c2, c3];
}

describe("split --by-commit — plan", () => {
  test("plans commit split with kept/moved lists", async () => {
    await using repo = await createTestRepo();
    const [c1, c2, c3] = await setupMultiCommitStack(repo.dir);

    const result = await planSplit(repo.dir, {
      mode: "by-commit",
      stackName: "my-stack",
      branch: "feat/a",
      at: c1,
      newBranch: "feat/b",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.keep).toEqual([c1]);
    expect(result.plan?.moved).toEqual([c2, c3]);
  });

  test("rejects splitting at branch tip", async () => {
    await using repo = await createTestRepo();
    const [, , c3] = await setupMultiCommitStack(repo.dir);

    const result = await planSplit(repo.dir, {
      mode: "by-commit",
      stackName: "my-stack",
      branch: "feat/a",
      at: c3,
      newBranch: "feat/b",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("at-is-tip");
  });

  test("rejects single-commit branches", async () => {
    await using repo = await createTestRepo();

    await runGit(repo.dir, "checkout", "-b", "feat/solo");
    await Deno.writeTextFile(`${repo.dir}/one.txt`, "v\n");
    await runGit(repo.dir, "add", "one.txt");
    await runGit(repo.dir, "commit", "-m", "only");
    await runGit(repo.dir, "config", "branch.feat/solo.stack-name", "s");
    await runGit(repo.dir, "config", "branch.feat/solo.stack-parent", "main");
    await runGit(repo.dir, "config", "stack.s.base-branch", "main");
    await runGit(repo.dir, "config", "stack.s.merge-strategy", "merge");

    const result = await planSplit(repo.dir, {
      mode: "by-commit",
      stackName: "s",
      branch: "feat/solo",
      at: "HEAD",
      newBranch: "feat/x",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("only-one-commit");
  });

  test("rejects existing new-branch name", async () => {
    await using repo = await createTestRepo();
    const [c1] = await setupMultiCommitStack(repo.dir);

    const result = await planSplit(repo.dir, {
      mode: "by-commit",
      stackName: "my-stack",
      branch: "feat/a",
      at: c1,
      newBranch: "feat/a",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("branch-exists");
  });
});

describe("split --by-commit — execute (real git)", () => {
  test("splits at c1: feat/a keeps c1, feat/b gets c2+c3", async () => {
    await using repo = await createTestRepo();
    const [c1, c2, c3] = await setupMultiCommitStack(repo.dir);

    const result = await split(repo.dir, {
      mode: "by-commit",
      stackName: "my-stack",
      branch: "feat/a",
      at: c1,
      newBranch: "feat/b",
    });
    expect(result.ok).toBe(true);

    // feat/a tip is c1
    const aTip = await runGit(repo.dir, "rev-parse", "feat/a");
    expect(aTip).toBe(c1);

    // feat/b tip is c3
    const bTip = await runGit(repo.dir, "rev-parse", "feat/b");
    expect(bTip).toBe(c3);

    // feat/b's second-to-last commit is c2 (a.k.a. rev-list --count c1..feat/b == 2)
    const countOut = await runGit(
      repo.dir,
      "rev-list",
      "--count",
      `${c1}..feat/b`,
    );
    expect(countOut).toBe("2");
    void c2;

    // Config wired up
    expect(
      await runGit(repo.dir, "config", "branch.feat/b.stack-name"),
    ).toBe("my-stack");
    expect(
      await runGit(repo.dir, "config", "branch.feat/b.stack-parent"),
    ).toBe("feat/a");
  });

  test("reparents existing children of original onto new upper", async () => {
    await using repo = await createTestRepo();
    const [c1] = await setupMultiCommitStack(repo.dir);

    // Add a child feat/c off feat/a.
    await runGit(repo.dir, "checkout", "-b", "feat/c", "feat/a");
    await Deno.writeTextFile(`${repo.dir}/ctop.txt`, "c\n");
    await runGit(repo.dir, "add", "ctop.txt");
    await runGit(repo.dir, "commit", "-m", "on feat/c");
    await runGit(repo.dir, "config", "branch.feat/c.stack-name", "my-stack");
    await runGit(repo.dir, "config", "branch.feat/c.stack-parent", "feat/a");

    await split(repo.dir, {
      mode: "by-commit",
      stackName: "my-stack",
      branch: "feat/a",
      at: c1,
      newBranch: "feat/b",
    });

    const cParent = await runGit(
      repo.dir,
      "config",
      "branch.feat/c.stack-parent",
    );
    expect(cParent).toBe("feat/b");
  });
});

describe("split --by-file — execute (real git)", () => {
  test("extracts file1.txt into feat/new below feat/a", async () => {
    await using repo = await createTestRepo();
    await setupMultiCommitStack(repo.dir);

    const result = await split(repo.dir, {
      mode: "by-file",
      stackName: "my-stack",
      branch: "feat/a",
      files: ["file1.txt"],
      newBranch: "feat/new",
      extractMessage: "extract file1",
      remainderMessage: "remainder",
    });
    expect(result.ok).toBe(true);

    // feat/new has file1.txt but not file2/3
    expect(
      await runGit(repo.dir, "cat-file", "-e", "feat/new:file1.txt").then(() =>
        "ok"
      ).catch(() => "no"),
    ).toBe("ok");
    expect(
      await runGit(repo.dir, "cat-file", "-e", "feat/new:file2.txt").then(() =>
        "ok"
      ).catch(() => "no"),
    ).toBe("no");

    // feat/a has all three files (it's rebased on feat/new which already has file1)
    expect(
      await runGit(repo.dir, "cat-file", "-e", "feat/a:file1.txt").then(() =>
        "ok"
      ).catch(() => "no"),
    ).toBe("ok");
    expect(
      await runGit(repo.dir, "cat-file", "-e", "feat/a:file2.txt").then(() =>
        "ok"
      ).catch(() => "no"),
    ).toBe("ok");
    expect(
      await runGit(repo.dir, "cat-file", "-e", "feat/a:file3.txt").then(() =>
        "ok"
      ).catch(() => "no"),
    ).toBe("ok");

    // Config
    expect(
      await runGit(repo.dir, "config", "branch.feat/new.stack-parent"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-parent"),
    ).toBe("feat/new");
  });

  test("rejects file not in branch's changes", async () => {
    await using repo = await createTestRepo();
    await setupMultiCommitStack(repo.dir);

    const result = await split(repo.dir, {
      mode: "by-file",
      stackName: "my-stack",
      branch: "feat/a",
      files: ["not-there.txt"],
      newBranch: "feat/new",
      extractMessage: "x",
      remainderMessage: "r",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("file-not-in-branch");
  });
});
