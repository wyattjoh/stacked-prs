import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assignColors } from "./colors.ts";

describe("assignColors", () => {
  test("is deterministic for the same root branch name", () => {
    const a = assignColors(["feat/x"], "dark");
    const b = assignColors(["feat/x"], "dark");
    expect(a.get("feat/x")).toBe(b.get("feat/x"));
  });

  test("two different names get different colors when palette is large enough", () => {
    const result = assignColors(["feat/x", "bugfix/y"], "dark");
    expect(result.get("feat/x")).not.toBe(result.get("bugfix/y"));
  });

  test("avoids palette collisions across siblings up to palette size", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const result = assignColors(names, "dark");
    const colors = new Set(result.values());
    expect(colors.size).toBe(names.length);
  });

  test("dark and light themes use different palettes", () => {
    // "fix/x" hashes to slot 7 (yellow in dark, red in light) so this name
    // exercises the one slot where the two palettes diverge.
    const dark = assignColors(["fix/x"], "dark");
    const light = assignColors(["fix/x"], "light");
    expect(dark.get("fix/x")).not.toBe(light.get("fix/x"));
  });
});
