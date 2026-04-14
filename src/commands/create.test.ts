import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createTestRepo, runGit } from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import { detectDefaultBranch } from "../lib/stack.ts";

describe("detectDefaultBranch", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("returns main when origin/HEAD points to origin/main", async () => {
    const bareDir = await Deno.makeTempDir({
      prefix: "stacked-prs-create-origin-",
    });
    try {
      await runGit(repo.dir, "clone", "--bare", repo.dir, bareDir);
      await runGit(repo.dir, "remote", "add", "origin", bareDir);
      await runGit(repo.dir, "fetch", "origin");
      await runGit(
        repo.dir,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );

      const result = await detectDefaultBranch(repo.dir);
      expect(result).toBe("main");
    } finally {
      await Deno.remove(bareDir, { recursive: true });
    }
  });

  test("falls back to local main when origin/HEAD is absent", async () => {
    const result = await detectDefaultBranch(repo.dir);
    expect(result).toBe("main");
  });

  test("falls back to local master when main is absent", async () => {
    await runGit(repo.dir, "branch", "-m", "main", "master");
    const result = await detectDefaultBranch(repo.dir);
    expect(result).toBe("master");
  });

  test("throws when neither origin/HEAD nor main/master exist", async () => {
    await runGit(repo.dir, "branch", "-m", "main", "trunk");
    await expect(detectDefaultBranch(repo.dir)).rejects.toThrow(
      /default branch/i,
    );
  });
});
