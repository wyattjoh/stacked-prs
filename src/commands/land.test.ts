import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LandCase } from "./land.ts";
import { isShallowRepository, runLandPreflight } from "./land.ts";
import { addBranch, createTestRepo, runGit } from "../lib/testdata/helpers.ts";

describe("land types", () => {
  it("LandCase supports the two expected shapes", () => {
    const a: LandCase = "root-merged";
    const b: LandCase = "all-merged";
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
  });
});

describe("isShallowRepository", () => {
  it("returns false for a fresh non-shallow repo", async () => {
    const repo = await createTestRepo();
    try {
      expect(await isShallowRepository(repo.dir)).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("runLandPreflight", () => {
  it("returns no blockers for a clean repo", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      const report = await runLandPreflight(repo.dir, ["feat/a"]);
      expect(report.blockers).toEqual([]);
      expect(report.isShallow).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("reports a dirty worktree as a blocker", async () => {
    const repo = await createTestRepo();
    try {
      await addBranch(repo.dir, "feat/a", "main");
      await runGit(repo.dir, "checkout", "feat/a");
      await Deno.writeTextFile(`${repo.dir}/dirty.txt`, "untracked\n");
      const report = await runLandPreflight(repo.dir, ["feat/a"]);
      expect(report.blockers.length).toBeGreaterThanOrEqual(1);
      expect(
        report.blockers.some((b) => b.kind === "dirty-worktree"),
      ).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
