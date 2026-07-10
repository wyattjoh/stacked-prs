import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as colors from "@std/fmt/colors";
import stringWidth from "string-width";
import {
  firstLine,
  parseInline,
  parseMarkdown,
  renderAnsiLines,
  renderHtml,
  renderInlineAnsi,
  stripInline,
  wrapMarkdown,
} from "./markdown.ts";

describe("parseInline", () => {
  test("parses bold, italic, code, and links", () => {
    expect(parseInline("a **b** *c* `d` [e](https://x.test)")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", code: true },
      { text: " " },
      { text: "e", url: "https://x.test" },
    ]);
  });

  test("unmatched markers stay literal", () => {
    expect(parseInline("2 * 3 and a ** dangler")).toEqual([
      { text: "2 * 3 and a ** dangler" },
    ]);
  });
});

describe("parseMarkdown", () => {
  test("splits paragraphs and flat bullet lists", () => {
    const blocks = parseMarkdown(
      "intro line\ncontinues here\n\n- first\n- **second**\n\noutro",
    );
    expect(blocks).toEqual([
      { kind: "paragraph", spans: [{ text: "intro line continues here" }] },
      {
        kind: "list",
        items: [[{ text: "first" }], [{ text: "second", bold: true }]],
      },
      { kind: "paragraph", spans: [{ text: "outro" }] },
    ]);
  });

  test("unsupported syntax stays literal", () => {
    expect(parseMarkdown("# not a heading")).toEqual([
      { kind: "paragraph", spans: [{ text: "# not a heading" }] },
    ]);
    expect(parseMarkdown("![alt](https://x.test/image.png)")).toEqual([
      {
        kind: "paragraph",
        spans: [{ text: "![alt](https://x.test/image.png)" }],
      },
    ]);
    expect(parseMarkdown("  - nested item")).toEqual([
      { kind: "paragraph", spans: [{ text: "- nested item" }] },
    ]);
  });
});

describe("helpers", () => {
  test("firstLine returns the first non-empty line", () => {
    expect(firstLine("\n\nreal content\nmore")).toBe("real content");
  });

  test("stripInline flattens styles to plain text", () => {
    expect(stripInline("do **the** `thing` [now](https://x.test)")).toBe(
      "do the thing now (https://x.test)",
    );
  });
});

describe("renderInlineAnsi", () => {
  test("applies bold styling", () => {
    expect(renderInlineAnsi("a **b**")).toBe(`a ${colors.bold("b")}`);
  });

  test("dim option wraps each span", () => {
    expect(renderInlineAnsi("a **b**", { dim: true })).toBe(
      `${colors.dim("a ")}${colors.dim(colors.bold("b"))}`,
    );
  });
});

describe("renderAnsiLines", () => {
  test("wraps paragraphs and prefixes bullets, blank line between blocks", () => {
    const lines = renderAnsiLines(
      "one two three four\n\n- alpha\n- beta",
      10,
    );
    expect(lines).toEqual([
      "one two",
      "three four",
      "",
      "• alpha",
      "• beta",
    ]);
  });
});

describe("wrapMarkdown", () => {
  test("returns styled span lines with bullet prefixes", () => {
    const lines = wrapMarkdown("hi **there**\n\n- item", 40);
    expect(lines).toEqual([
      [{ text: "hi " }, { text: "there", bold: true }],
      [],
      [{ text: "• " }, { text: "item" }],
    ]);
  });

  test("wraps long paragraphs at the width", () => {
    const lines = wrapMarkdown("one two three four", 9);
    expect(lines).toEqual([
      [{ text: "one two" }],
      [{ text: "three" }],
      [{ text: "four" }],
    ]);
  });

  test("wraps by terminal columns and splits overlong tokens", () => {
    const lines = wrapMarkdown("界界界 abcdef", 4);
    const textLines = lines.map((line) =>
      line.map((span) => span.text).join("")
    );

    expect(textLines).toEqual(["界界", "界", "abcd", "ef"]);
    for (const line of textLines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(4);
    }
  });
});

describe("renderHtml", () => {
  test("renders the subset with escaped text nodes", () => {
    expect(renderHtml("a **b** `c<d>`\n\n- [x](https://x.test)")).toBe(
      "<p>a <strong>b</strong> <code>c&lt;d&gt;</code></p>" +
        '<ul><li><a href="https://x.test" target="_blank" rel="noopener">x</a></li></ul>',
    );
  });

  test("XSS-shaped input stays inert", () => {
    const html = renderHtml(
      "<script>alert(1)</script> [x](javascript:alert(1))",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });
});
