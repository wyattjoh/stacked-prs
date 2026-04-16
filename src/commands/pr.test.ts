import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  createTestRepo,
  makeMockDir,
} from "../lib/testdata/helpers.ts";
import { runGitCommand } from "../lib/stack.ts";
import { writeFixture } from "../lib/gh.ts";
import { findPrForBranch } from "./pr.ts";

describe("findPrForBranch", () => {
  test("returns the best PR for a branch", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");

    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 42,
        url: "https://github.com/o/r/pull/42",
        state: "OPEN",
        isDraft: false,
        createdAt: "2026-01-01T00:00:00Z",
      }],
    );

    const result = await findPrForBranch(repo.dir, "o", "r", "feat/a");
    expect(result.ok).toBe(true);
    expect(result.pr?.number).toBe(42);
    expect(result.pr?.url).toBe("https://github.com/o/r/pull/42");
  });

  test("defaults to the current branch when branch is omitted", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await addBranch(repo.dir, "feat/current", "main");
    await runGitCommand(repo.dir, "checkout", "feat/current");

    await writeFixture(
      mock.path,
      ["pr", "list", "--head", "feat/current", "--repo", "o/r"],
      [{
        number: 7,
        url: "https://github.com/o/r/pull/7",
        state: "OPEN",
        isDraft: false,
      }],
    );

    const result = await findPrForBranch(repo.dir, "o", "r");
    expect(result.ok).toBe(true);
    expect(result.branch).toBe("feat/current");
    expect(result.pr?.number).toBe(7);
  });

  test("reports an error when no PR exists", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/orphan", "main");

    const result = await findPrForBranch(repo.dir, "o", "r", "feat/orphan");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No PR found");
  });

  test("lookup on a tombstoned branch returns a clean not-found result", async () => {
    // Tombstoned branches have no local ref. findPrForBranch takes the branch
    // name as input and queries gh with it; the branch name is valid even
    // when the ref is gone. gh returns no matches and we report "No PR found"
    // rather than crashing.
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    // No fixture registered, so mock gh returns [].

    const result = await findPrForBranch(repo.dir, "o", "r", "feat/landed");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No PR found");
  });
});
