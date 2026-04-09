import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LandCase } from "./land.ts";

describe("land types", () => {
  it("LandCase supports the two expected shapes", () => {
    const a: LandCase = "root-merged";
    const b: LandCase = "all-merged";
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
  });
});
