import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  assignColors,
  DARK_PALETTE,
  detectTheme,
  fnv1a,
  LIGHT_PALETTE,
} from "./colors.ts";

describe("fnv1a", () => {
  test("is deterministic", () => {
    expect(fnv1a("alpha")).toBe(fnv1a("alpha"));
  });

  test("different inputs produce different hashes", () => {
    expect(fnv1a("alpha")).not.toBe(fnv1a("beta"));
  });
});

describe("assignColors", () => {
  test("returns empty map for no stacks", () => {
    const out = assignColors([], new Map(), "dark");
    expect(out.size).toBe(0);
  });

  test("assigns deterministic colors across runs", () => {
    const a = assignColors(["alpha", "beta", "gamma"], new Map(), "dark");
    const b = assignColors(["alpha", "beta", "gamma"], new Map(), "dark");
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  test("no two stacks share a color when palette has room", () => {
    const names = ["alpha", "beta", "gamma", "delta"];
    const out = assignColors(names, new Map(), "dark");
    const used = new Set(out.values());
    expect(used.size).toBe(names.length);
  });

  test("git-config override is respected and excluded from probe", () => {
    const overrides = new Map([["alpha", "magenta"]]);
    const out = assignColors(["alpha", "beta"], overrides, "dark");
    expect(out.get("alpha")).toBe("magenta");
    expect(out.get("beta")).not.toBe("magenta");
  });

  test("uses light palette when theme=light", () => {
    const out = assignColors(["alpha"], new Map(), "light");
    expect(LIGHT_PALETTE).toContain(out.get("alpha"));
  });

  test("palette exhaustion wraps around (9+ stacks)", () => {
    const names = Array.from({ length: 10 }, (_, i) => `stack-${i}`);
    const out = assignColors(names, new Map(), "dark");
    expect(out.size).toBe(10);
    for (const c of out.values()) {
      expect(DARK_PALETTE).toContain(c);
    }
  });
});

describe("detectTheme", () => {
  test("defaults to dark when COLORFGBG is unset", () => {
    expect(detectTheme(undefined)).toBe("dark");
  });

  test("returns light when COLORFGBG bg is in 7..15 range", () => {
    expect(detectTheme("0;15")).toBe("light");
    expect(detectTheme("0;7")).toBe("light");
  });

  test("returns dark when COLORFGBG bg is in 0..6 range", () => {
    expect(detectTheme("15;0")).toBe("dark");
    expect(detectTheme("15;6")).toBe("dark");
  });

  test("handles malformed COLORFGBG", () => {
    expect(detectTheme("garbage")).toBe("dark");
  });
});
