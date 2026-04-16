import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  createTestRepo,
  runGit,
} from "../lib/testdata/helpers.ts";
import { fold, planFold } from "./fold.ts";

/** Register a 3-branch linear stack: main <- feat/a <- feat/b <- feat/c. */
async function setupLinearStack(dir: string): Promise<void> {
  await addBranch(dir, "feat/a", "main");
  await addBranch(dir, "feat/b", "feat/a");
  await addBranch(dir, "feat/c", "feat/b");

  await runGit(dir, "config", "branch.feat/a.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/a.stack-parent", "main");
  await runGit(dir, "config", "branch.feat/b.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/b.stack-parent", "feat/a");
  await runGit(dir, "config", "branch.feat/c.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/c.stack-parent", "feat/b");
  await runGit(dir, "config", "stack.my-stack.base-branch", "main");
  await runGit(dir, "config", "stack.my-stack.merge-strategy", "merge");
}

describe("fold — plan", () => {
  test("plans ff fold with parent and children", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);

    const result = await planFold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/b",
      strategy: "ff",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.parent).toBe("feat/a");
    expect(result.plan?.children).toEqual(["feat/c"]);
    expect(result.plan?.strategy).toBe("ff");
    expect(result.plan?.commands).toEqual([
      "git checkout feat/a",
      "git merge --ff-only feat/b",
      "git config branch.feat/c.stack-parent feat/a",
      "git config --unset branch.feat/b.stack-name",
      "git config --unset branch.feat/b.stack-parent",
      "git branch -d feat/b",
    ]);
  });

  test("plans squash fold with commit step", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);

    const result = await planFold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/b",
      strategy: "squash",
      squashMessage: "squashed feat/b",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.commands[1]).toBe("git merge --squash feat/b");
    expect(result.plan?.commands[2]).toBe(
      "git commit -m 'squashed feat/b'",
    );
  });

  test("rejects fold on root branch (parent is base)", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);

    const result = await planFold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/a",
      strategy: "ff",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("parent-is-base");
  });

  test("rejects when branch not in stack", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);

    const result = await planFold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/x",
      strategy: "ff",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-in-stack");
  });

  test("rejects when only one live branch exists", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "config", "branch.feat/a.stack-name", "solo");
    await runGit(repo.dir, "config", "branch.feat/a.stack-parent", "main");
    await runGit(repo.dir, "config", "stack.solo.base-branch", "main");
    await runGit(repo.dir, "config", "stack.solo.merge-strategy", "merge");

    const result = await planFold(repo.dir, {
      stackName: "solo",
      branch: "feat/a",
      strategy: "ff",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("only-branch");
  });
});

describe("fold — execute (real git)", () => {
  test("ff-folds child into parent and reparents grandchildren", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);
    await runGit(repo.dir, "checkout", "feat/c");

    const result = await fold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/b",
      strategy: "ff",
    });
    expect(result.ok).toBe(true);

    // feat/b ref is gone.
    const probe = await runGit(
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/feat/b",
    ).catch(() => "");
    expect(probe).toBe("");

    // feat/c was reparented to feat/a.
    const parent = await runGit(
      repo.dir,
      "config",
      "branch.feat/c.stack-parent",
    );
    expect(parent).toBe("feat/a");

    // feat/a now contains feat/b's commit (fast-forward).
    const log = await runGit(repo.dir, "log", "feat/a", "--format=%s");
    expect(log).toMatch(/add feat-b\.txt/);

    // feat/b config keys are gone.
    const bName = await runGit(
      repo.dir,
      "config",
      "branch.feat/b.stack-name",
    ).catch(() => "");
    expect(bName).toBe("");
  });

  test("squash-folds child: single new commit on parent with merged file", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);

    // Move feat/a forward by one commit so ff-only would fail; forces squash path
    // to validate it independently.
    await runGit(repo.dir, "checkout", "feat/a");
    await Deno.writeTextFile(`${repo.dir}/extra.txt`, "extra\n");
    await runGit(repo.dir, "add", "extra.txt");
    await runGit(repo.dir, "commit", "-m", "extra on feat/a");

    // Rebase feat/b onto feat/a so squash is possible cleanly.
    await runGit(repo.dir, "checkout", "feat/b");
    await runGit(repo.dir, "rebase", "feat/a");

    const beforeLog = await runGit(repo.dir, "log", "feat/a", "--format=%s");
    const beforeCount = beforeLog.split("\n").length;

    const result = await fold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/b",
      strategy: "squash",
      squashMessage: "squashed",
    });
    expect(result.ok).toBe(true);

    const afterLog = await runGit(repo.dir, "log", "feat/a", "--format=%s");
    const afterCount = afterLog.split("\n").length;
    expect(afterCount).toBe(beforeCount + 1);
    expect(afterLog.split("\n")[0]).toBe("squashed");

    // feat/b.txt is now present on feat/a (the merge produced a new commit).
    const feat = await Deno.readTextFile(`${repo.dir}/feat-b.txt`);
    expect(feat).toBe("Branch: feat/b\n");
  });

  test("dry-run mutates nothing", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);

    const result = await fold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/b",
      strategy: "ff",
      dryRun: true,
    });
    expect(result.ok).toBe(true);

    // feat/b still exists with full config.
    const parent = await runGit(
      repo.dir,
      "config",
      "branch.feat/b.stack-parent",
    );
    expect(parent).toBe("feat/a");
  });

  test("refuses ff fold when parent not ancestor", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);

    // Diverge feat/a so feat/b is no longer descended from it.
    await runGit(repo.dir, "checkout", "feat/a");
    await Deno.writeTextFile(`${repo.dir}/divergent.txt`, "divergent\n");
    await runGit(repo.dir, "add", "divergent.txt");
    await runGit(repo.dir, "commit", "-m", "diverge");

    const result = await fold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/b",
      strategy: "ff",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ff-not-possible");
  });
});

describe("fold — tombstone handling", () => {
  test("rejects folding a tombstoned branch", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);
    await addTombstone(repo.dir, "my-stack", "feat/landed", { prNumber: 21 });

    const result = await planFold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/landed",
      strategy: "ff",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-in-stack");
  });

  test("folds a live branch even when a tombstone is present", async () => {
    await using repo = await createTestRepo();
    await setupLinearStack(repo.dir);
    await addTombstone(repo.dir, "my-stack", "feat/legacy", { prNumber: 22 });

    const result = await planFold(repo.dir, {
      stackName: "my-stack",
      branch: "feat/b",
      strategy: "ff",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.parent).toBe("feat/a");
    expect(result.plan?.children).toEqual(["feat/c"]);
  });
});
