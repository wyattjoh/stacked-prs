import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { commitFile, createTestRepo, runGit } from "./testdata/helpers.ts";
import type { TestRepo } from "./testdata/helpers.ts";
import { checkWorktreeSafety } from "./worktrees.ts";

describe("checkWorktreeSafety", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("single clean worktree, in-scope branch returns empty", async () => {
    await runGit(repo.dir, "checkout", "-b", "feat/a");
    await commitFile(repo.dir, "a.txt", "a\n");

    const result = await checkWorktreeSafety(repo.dir, ["feat/a"]);

    expect(result).toEqual([]);
  });

  test("single worktree dirty on in-scope branch returns one entry", async () => {
    await runGit(repo.dir, "checkout", "-b", "feat/a");
    await commitFile(repo.dir, "a.txt", "a\n");
    await Deno.writeTextFile(`${repo.dir}/a.txt`, "dirty\n");

    const result = await checkWorktreeSafety(repo.dir, ["feat/a"]);

    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("feat/a");
    expect(result[0].dirtyFiles).toContain("a.txt");
  });

  test("secondary worktree dirty on in-scope branch returns it", async () => {
    await runGit(repo.dir, "checkout", "-b", "feat/a");
    await commitFile(repo.dir, "a.txt", "a\n");
    await runGit(repo.dir, "checkout", "main");

    const wt2Raw = await Deno.makeTempDir({ prefix: "stacked-prs-wt-" });
    // macOS /var is a symlink to /private/var; git canonicalizes worktree
    // paths, so resolve symlinks before comparing.
    const wt2 = await Deno.realPath(wt2Raw);
    try {
      await runGit(repo.dir, "worktree", "add", wt2, "feat/a");
      await Deno.writeTextFile(`${wt2}/a.txt`, "dirty from wt2\n");

      const result = await checkWorktreeSafety(repo.dir, ["feat/a"]);

      expect(result).toHaveLength(1);
      expect(result[0].branch).toBe("feat/a");
      expect(result[0].path).toBe(wt2);
    } finally {
      await runGit(repo.dir, "worktree", "remove", "--force", wt2).catch(
        () => {},
      );
      await Deno.remove(wt2, { recursive: true }).catch(() => {});
    }
  });

  test("secondary worktree dirty on out-of-scope branch is ignored", async () => {
    await runGit(repo.dir, "checkout", "-b", "feat/a");
    await commitFile(repo.dir, "a.txt", "a\n");
    await runGit(repo.dir, "checkout", "-b", "feat/b");
    await commitFile(repo.dir, "b.txt", "b\n");
    await runGit(repo.dir, "checkout", "main");

    const wt2 = await Deno.makeTempDir({ prefix: "stacked-prs-wt-" });
    try {
      await runGit(repo.dir, "worktree", "add", wt2, "feat/b");
      await Deno.writeTextFile(`${wt2}/b.txt`, "dirty\n");

      // feat/b is dirty but we only care about feat/a
      const result = await checkWorktreeSafety(repo.dir, ["feat/a"]);

      expect(result).toEqual([]);
    } finally {
      await runGit(repo.dir, "worktree", "remove", "--force", wt2).catch(
        () => {},
      );
      await Deno.remove(wt2, { recursive: true }).catch(() => {});
    }
  });

  test("untracked files count as dirty", async () => {
    await runGit(repo.dir, "checkout", "-b", "feat/a");
    await commitFile(repo.dir, "a.txt", "a\n");
    await Deno.writeTextFile(`${repo.dir}/untracked.txt`, "new\n");

    const result = await checkWorktreeSafety(repo.dir, ["feat/a"]);

    expect(result).toHaveLength(1);
    expect(result[0].dirtyFiles).toContain("untracked.txt");
  });

  test("staged rename reports only the new path", async () => {
    await runGit(repo.dir, "checkout", "-b", "feat/a");
    await commitFile(repo.dir, "old-name.txt", "content\n");
    await runGit(repo.dir, "mv", "old-name.txt", "new-name.txt");

    const result = await checkWorktreeSafety(repo.dir, ["feat/a"]);

    expect(result).toHaveLength(1);
    expect(result[0].dirtyFiles).toEqual(["new-name.txt"]);
  });

  test("file with leading space in name is parsed correctly", async () => {
    await runGit(repo.dir, "checkout", "-b", "feat/a");
    await commitFile(repo.dir, "a.txt", "a\n");
    await Deno.writeTextFile(`${repo.dir}/ leading.txt`, "x\n");

    const result = await checkWorktreeSafety(repo.dir, ["feat/a"]);

    expect(result).toHaveLength(1);
    expect(result[0].dirtyFiles).toContain(" leading.txt");
  });
});
