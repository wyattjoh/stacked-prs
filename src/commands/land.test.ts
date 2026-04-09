import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LandCase } from "./land.ts";
import { isShallowRepository } from "./land.ts";
import { createTestRepo } from "../lib/testdata/helpers.ts";

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
