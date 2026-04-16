import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  addTombstone,
  createTestRepo,
  runGit,
} from "../lib/testdata/helpers.ts";
import { move, planMove } from "./move.ts";

/** Register a stack:  main <- feat/a <- feat/b, and sibling feat/c off feat/a. */
async function setupForkStack(dir: string): Promise<void> {
  await addBranch(dir, "feat/a", "main");
  await addBranch(dir, "feat/b", "feat/a");
  await addBranch(dir, "feat/c", "feat/a");

  await runGit(dir, "config", "branch.feat/a.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/a.stack-parent", "main");
  await runGit(dir, "config", "branch.feat/b.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/b.stack-parent", "feat/a");
  await runGit(dir, "config", "branch.feat/c.stack-name", "my-stack");
  await runGit(dir, "config", "branch.feat/c.stack-parent", "feat/a");
  await runGit(dir, "config", "stack.my-stack.base-branch", "main");
  await runGit(dir, "config", "stack.my-stack.merge-strategy", "merge");
}

describe("move — plan", () => {
  test("plans reparenting feat/c under feat/b", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);

    const result = await planMove(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "feat/b",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.oldParent).toBe("feat/a");
    expect(result.plan?.newParent).toBe("feat/b");
    expect(result.plan?.commands).toEqual([
      "git config branch.feat/c.stack-parent feat/b",
      "git rebase --onto feat/b feat/a feat/c",
    ]);
  });

  test("rejects noop move", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);
    const result = await planMove(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "feat/a",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("noop");
  });

  test("rejects cycle (moving parent under its own child)", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);
    const result = await planMove(repo.dir, {
      stackName: "my-stack",
      branch: "feat/a",
      newParent: "feat/b",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("would-create-cycle");
  });

  test("rejects new parent not in stack", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);
    await addBranch(repo.dir, "random", "main");

    const result = await planMove(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "random",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("parent-not-in-stack");
  });
});

describe("move — execute (real git)", () => {
  test("moves feat/c under feat/b and rebases it", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);

    const result = await move(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "feat/b",
    });
    expect(result.ok).toBe(true);

    // Config updated.
    const parent = await runGit(
      repo.dir,
      "config",
      "branch.feat/c.stack-parent",
    );
    expect(parent).toBe("feat/b");

    // feat/b is now an ancestor of feat/c.
    const ancestor = await runGit(
      repo.dir,
      "merge-base",
      "--is-ancestor",
      "feat/b",
      "feat/c",
    ).then(() => "yes").catch(() => "no");
    expect(ancestor).toBe("yes");
  });

  test("reparents moved branch's children back to its old parent", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);
    // Add feat/d as child of feat/c.
    await addBranch(repo.dir, "feat/d", "feat/c");
    await runGit(
      repo.dir,
      "config",
      "branch.feat/d.stack-name",
      "my-stack",
    );
    await runGit(
      repo.dir,
      "config",
      "branch.feat/d.stack-parent",
      "feat/c",
    );

    await move(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "feat/b",
    });

    const dParent = await runGit(
      repo.dir,
      "config",
      "branch.feat/d.stack-parent",
    );
    // feat/d reparented to feat/c's old parent (feat/a).
    expect(dParent).toBe("feat/a");
  });

  test("reports conflict cleanly when rebase fails", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);

    // Create a conflicting write on feat/b and feat/c both touching the same file.
    await runGit(repo.dir, "checkout", "feat/b");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "from feat/b\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "add shared on b");

    await runGit(repo.dir, "checkout", "feat/c");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "from feat/c\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "add shared on c");

    const result = await move(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "feat/b",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("conflict");
    expect(result.recovery?.abort).toBe("git rebase --abort");

    // Cleanup mid-rebase state so Deno disposer can delete the temp dir.
    await runGit(repo.dir, "rebase", "--abort").catch(() => "");
  });

  test("dry-run mutates nothing", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);

    const result = await move(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "feat/b",
      dryRun: true,
    });
    expect(result.ok).toBe(true);

    const parent = await runGit(
      repo.dir,
      "config",
      "branch.feat/c.stack-parent",
    );
    expect(parent).toBe("feat/a");
  });
});

describe("move — tombstone handling", () => {
  test("rejects a tombstone root as the new parent", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);
    await addTombstone(repo.dir, "my-stack", "feat/landed", { prNumber: 11 });

    const result = await planMove(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "feat/landed",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("parent-not-in-stack");
  });

  test("rejects moving a tombstoned branch", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);
    await addTombstone(repo.dir, "my-stack", "feat/landed", { prNumber: 12 });

    const result = await planMove(repo.dir, {
      stackName: "my-stack",
      branch: "feat/landed",
      newParent: "feat/a",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-in-stack");
  });

  test("moves live branch alongside an existing tombstone", async () => {
    await using repo = await createTestRepo();
    await setupForkStack(repo.dir);
    await addTombstone(repo.dir, "my-stack", "feat/landed", { prNumber: 13 });

    const result = await planMove(repo.dir, {
      stackName: "my-stack",
      branch: "feat/c",
      newParent: "feat/b",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.oldParent).toBe("feat/a");
    expect(result.plan?.newParent).toBe("feat/b");
  });
});
