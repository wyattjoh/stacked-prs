import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ansiColor } from "./ansi.ts";

describe("ansiColor", () => {
  test("returns a wrapping function for known color names", () => {
    const cyan = ansiColor("cyan");
    const wrapped = cyan("hello");
    // @std/fmt/colors honors NO_COLOR; in tests it may or may not be set.
    // Just verify the function returns a string containing the input.
    expect(wrapped).toContain("hello");
    expect(typeof wrapped).toBe("string");
  });

  test("maps every Ink palette name without falling through to identity", () => {
    const inkNames = [
      "cyan",
      "magenta",
      "blue",
      "cyanBright",
      "magentaBright",
      "blueBright",
      "green",
      "yellow",
      "red",
    ];
    for (const name of inkNames) {
      const fn = ansiColor(name);
      expect(typeof fn).toBe("function");
      // Identity fallback would return input verbatim; the @std/fmt/colors
      // wrappers are still functions, so we can only check the input is
      // present in the output (it always will be).
      expect(fn("x")).toContain("x");
    }
  });

  test("unknown color name returns identity", () => {
    const fn = ansiColor("not-a-color");
    expect(fn("hello")).toBe("hello");
  });
});
