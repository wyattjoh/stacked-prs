# Branch Descriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render optional per-branch markdown descriptions (stored in git's
native `branch.<name>.description` config key) on `status`, the TUI detail
pane, and the `serve` web UI.

**Architecture:** Read-side feature. `gitConfigGetRegexp` becomes NUL-safe so
multi-line config values parse; the existing single-subprocess branch-config
scan also captures `description` and threads it through `StackNode` to every
consumer. A new `src/lib/markdown.ts` parses a small markdown subset once and
renders it three ways (ANSI for the CLI, styled span lines for Ink, escaped
HTML server-side for serve).

**Tech Stack:** Deno TypeScript, `@std/fmt/colors`, Ink + ink-testing-library,
Hono (serve), vanilla JS browser client.

**Spec:** `docs/superpowers/specs/2026-07-08-branch-descriptions-design.md`

## Global Constraints

- All scripts are Deno TypeScript with explicit permissions; command functions
  are pure (no `Deno.args`, `console.log`, `Deno.exit`); `cli.ts` owns all I/O.
- The stacked-prs tooling never writes `branch.<name>.description`; only stock
  git does.
- Markdown subset: bold, italic, inline code, links, paragraphs, flat bullet
  lists. Everything else renders as literal text, never an error.
- Every surface renders descriptions only when the key is set.
- Tests use real git repos via `await using repo = await createTestRepo()`
  (see `.claude/rules/testing.md`); every ink-testing-library test must
  destructure and call `unmount` before returning.
- Test command shape: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write <file>`
- No em dashes in any written output (commits, comments, docs).
- After all tasks complete, run `deno task check`, `deno task test`, and
  `deno task install`.

---

### Task 1: NUL-safe `gitConfigGetRegexp`

Multi-line config values (which `git branch --edit-description` produces)
corrupt the current line-based `--get-regexp` parser. Switch to
`git config -z --get-regexp`: records are NUL-separated, the key ends at the
first newline within a record, and the remainder is the (possibly multi-line)
value. Values must come from **raw** (untrimmed) stdout.

**Files:**
- Modify: `src/lib/stack.ts:346-362` (`gitConfigGetRegexp`)
- Test: `src/lib/stack.test.ts`

**Interfaces:**
- Consumes: `runGitCommandRaw(dir, ...args)` from `src/lib/stack.ts:19`
  (returns untrimmed `{ code, stdout, stderr }`).
- Produces: `gitConfigGetRegexp(dir: string, pattern: string): Promise<Array<[string, string]>>`
  (same signature as today, now multi-line-safe). Task 2 relies on it.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/stack.test.ts` (match the file's existing imports; it already
imports `createTestRepo` and `runGit` from `./testdata/helpers.ts` and
`gitConfigGetRegexp` may need adding to the `./stack.ts` import list):

```ts
describe("gitConfigGetRegexp", () => {
  test("round-trips multi-line config values", async () => {
    await using repo = await createTestRepo();
    const description = "first line with detail\nsecond line\n\n- a bullet";
    await runGit(
      repo.dir,
      "config",
      "branch.main.description",
      description,
    );

    const entries = await gitConfigGetRegexp(
      repo.dir,
      "^branch\\.main\\.description$",
    );
    expect(entries).toEqual([["branch.main.description", description]]);
  });

  test("parses multiple records when one value is multi-line", async () => {
    await using repo = await createTestRepo();
    await runGit(repo.dir, "config", "branch.main.stack-name", "alpha");
    await runGit(
      repo.dir,
      "config",
      "branch.main.description",
      "line one\nline two",
    );

    const entries = await gitConfigGetRegexp(repo.dir, "^branch\\.main\\.");
    const byKey = new Map(entries);
    expect(byKey.get("branch.main.stack-name")).toBe("alpha");
    expect(byKey.get("branch.main.description")).toBe("line one\nline two");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts --filter gitConfigGetRegexp`
Expected: FAIL. The multi-line value splits into separate bogus entries
(line-based parsing).

- [ ] **Step 3: Replace the implementation**

In `src/lib/stack.ts`, replace the body of `gitConfigGetRegexp`:

```ts
/**
 * Run `git config -z --get-regexp <pattern>`, return parsed [key, value]
 * pairs. NUL-separated records with the key ending at the first newline, so
 * multi-line values (e.g. branch.<name>.description) survive parsing.
 */
export async function gitConfigGetRegexp(
  dir: string,
  pattern: string,
): Promise<Array<[string, string]>> {
  const { code, stdout } = await runGitCommandRaw(
    dir,
    "config",
    "-z",
    "--get-regexp",
    pattern,
  );
  if (code !== 0 || stdout.length === 0) return [];

  return stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const newlineIndex = record.indexOf("\n");
      // A key with no value prints as a bare key record.
      if (newlineIndex === -1) return [record, ""] as [string, string];
      return [
        record.slice(0, newlineIndex),
        record.slice(newlineIndex + 1),
      ] as [string, string];
    });
}
```

- [ ] **Step 4: Run the new tests and the full stack suite**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts`
Expected: PASS (new tests plus every existing consumer of the helper).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stack.ts src/lib/stack.test.ts
git commit -m "fix(stack): parse git config --get-regexp NUL-separated for multi-line values"
```

---

### Task 2: Scan `branch.<name>.description` into `StackNode`

**Files:**
- Modify: `src/lib/stack.ts` (`BranchStackEntry` + `readAllBranchStackConfig`
  at lines 703-734, `StackNode` at line 434, `buildNode` inside `getStackTree`
  at lines 871-880)
- Test: `src/lib/stack.test.ts`

**Interfaces:**
- Consumes: `gitConfigGetRegexp` from Task 1.
- Produces: `BranchStackEntry.description?: string`;
  `StackNode.description?: string` populated by `getStackTree`. Tasks 4, 5,
  and 6 read `node.description`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/stack.test.ts` (inside or alongside existing `getStackTree`
describes; reuse the file's existing helpers for registering a stack, e.g.
config writes via `runGit(repo.dir, "config", ...)` or the file's setter
helpers if present):

```ts
describe("branch descriptions", () => {
  test("readAllBranchStackConfig captures description", async () => {
    await using repo = await createTestRepo();
    await runGit(repo.dir, "config", "branch.main.stack-name", "alpha");
    await runGit(repo.dir, "config", "branch.main.stack-parent", "base");
    await runGit(
      repo.dir,
      "config",
      "branch.main.description",
      "does the thing\nwith **detail**",
    );

    const entries = await readAllBranchStackConfig(repo.dir);
    expect(entries.get("main")?.description).toBe(
      "does the thing\nwith **detail**",
    );
  });

  test("getStackTree populates StackNode.description", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "config", "branch.feat/a.stack-name", "alpha");
    await runGit(repo.dir, "config", "branch.feat/a.stack-parent", "main");
    await runGit(repo.dir, "config", "stack.alpha.base-branch", "main");
    await runGit(
      repo.dir,
      "config",
      "branch.feat/a.description",
      "adds the api client",
    );

    const tree = await getStackTree(repo.dir, "alpha");
    expect(tree.roots[0].description).toBe("adds the api client");
  });

  test("a description on a non-stack branch creates no phantom membership", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "loose", "main");
    await runGit(repo.dir, "config", "branch.feat/a.stack-name", "alpha");
    await runGit(repo.dir, "config", "branch.feat/a.stack-parent", "main");
    await runGit(repo.dir, "config", "stack.alpha.base-branch", "main");
    await runGit(repo.dir, "config", "branch.loose.description", "not in a stack");

    const tree = await getStackTree(repo.dir, "alpha");
    const branches = getAllNodes(tree).map((n) => n.branch);
    expect(branches).toEqual(["feat/a"]);
  });

  test("undescribed branches carry no description field", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "config", "branch.feat/a.stack-name", "alpha");
    await runGit(repo.dir, "config", "branch.feat/a.stack-parent", "main");
    await runGit(repo.dir, "config", "stack.alpha.base-branch", "main");

    const tree = await getStackTree(repo.dir, "alpha");
    expect("description" in tree.roots[0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts --filter "branch descriptions"`
Expected: FAIL (`description` is `undefined` on the entry / node).

- [ ] **Step 3: Implement**

In `src/lib/stack.ts`:

1. `BranchStackEntry` gains the field:

```ts
export interface BranchStackEntry {
  stackName?: string;
  parent?: string;
  merged?: boolean;
  order?: number;
  /** Raw markdown from git's native branch.<name>.description key. */
  description?: string;
}
```

2. `readAllBranchStackConfig` widens the scan and the key match:

```ts
export async function readAllBranchStackConfig(
  dir: string,
): Promise<Map<string, BranchStackEntry>> {
  const entries = await gitConfigGetRegexp(
    dir,
    "^branch\\..*\\.(stack-|description)",
  );
  const out = new Map<string, BranchStackEntry>();
  for (const [key, value] of entries) {
    const match = key.match(
      /^branch\.(.+)\.(?:stack-(name|parent|merged|order)|(description))$/,
    );
    if (!match) continue;
    const [, branch, field, descriptionKey] = match;
    const entry = out.get(branch) ?? {};
    if (descriptionKey) entry.description = value;
    else if (field === "name") entry.stackName = value;
    else if (field === "parent") entry.parent = value;
    else if (field === "merged") entry.merged = value === "true";
    else if (field === "order") entry.order = Number(value);
    out.set(branch, entry);
  }
  return out;
}
```

3. `StackNode` gains the field:

```ts
export interface StackNode {
  branch: string;
  stackName: string;
  parent: string;
  children: StackNode[];
  /** True when this branch has been landed. Source: stack.<stackName>.landed-branches or legacy branch.<name>.stack-merged. */
  merged?: boolean;
  /** Raw markdown from git's native branch.<name>.description key. */
  description?: string;
}
```

4. `buildNode` inside `getStackTree` populates it (empty string counts as
   unset):

```ts
  const buildNode = (branch: string): StackNode => {
    const children = (childrenMap.get(branch) ?? []).map(buildNode);
    const description = branchConfig.get(branch)?.description;
    return {
      branch,
      stackName: resolvedStackName!,
      parent: branchParents.get(branch)!,
      children,
      ...(mergedFlags.get(branch) ? { merged: true } : {}),
      ...(description ? { description } : {}),
    };
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stack.ts src/lib/stack.test.ts
git commit -m "feat(stack): read native branch descriptions into StackNode"
```

---

### Task 3: `src/lib/markdown.ts` (parser + ANSI/HTML renderers + wrapping)

New shared library (no CLI mapping, per the `src/lib/` rule). Subset only:
bold `**x**`, italic `*x*`, inline code `` `x` ``, links `[t](u)`, paragraphs,
flat `-`/`*` bullet lists. Unrecognized syntax stays literal text.

**Files:**
- Create: `src/lib/markdown.ts`
- Test: `src/lib/markdown.test.ts`

**Interfaces:**
- Consumes: `@std/fmt/colors` (already an import elsewhere in the repo).
- Produces (used by Tasks 4, 5, 6):
  - `interface MdSpan { text: string; bold?: boolean; italic?: boolean; code?: boolean; underline?: boolean; url?: string }`
  - `type MdBlock = { kind: "paragraph"; spans: MdSpan[] } | { kind: "list"; items: MdSpan[][] }`
  - `parseMarkdown(source: string): MdBlock[]`
  - `parseInline(text: string): MdSpan[]`
  - `firstLine(source: string): string`
  - `stripInline(text: string): string`
  - `renderInlineAnsi(text: string, opts?: { dim?: boolean }): string`
  - `renderAnsiLines(source: string, width: number, opts?: { dim?: boolean }): string[]`
  - `wrapMarkdown(source: string, width: number): MdSpan[][]` (styled lines
    for Ink; blank line between blocks is `[]`, bullet prefix is a span)
  - `renderHtml(source: string): string` (text nodes escaped; only
    http(s) hrefs become anchors)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/markdown.test.ts`:

```ts
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as colors from "@std/fmt/colors";
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
});

describe("renderHtml", () => {
  test("renders the subset with escaped text nodes", () => {
    expect(renderHtml("a **b** `c<d>`\n\n- [x](https://x.test)")).toBe(
      "<p>a <strong>b</strong> <code>c&lt;d&gt;</code></p>" +
        '<ul><li><a href="https://x.test" target="_blank" rel="noopener">x</a></li></ul>',
    );
  });

  test("XSS-shaped input stays inert", () => {
    const html = renderHtml('<script>alert(1)</script> [x](javascript:alert(1))');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read src/lib/markdown.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/markdown.ts`**

```ts
import * as colors from "@std/fmt/colors";

/** One styled run of inline text. `url` marks a link span. */
export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  underline?: boolean;
  url?: string;
}

export type MdBlock =
  | { kind: "paragraph"; spans: MdSpan[] }
  | { kind: "list"; items: MdSpan[][] };

// One alternation per supported inline form. Non-greedy inner matches keep
// unmatched markers literal (no match, no consumption).
const INLINE_RE =
  /(\*\*([^*\n]+)\*\*)|(\*([^*\s][^*\n]*?)\*)|(`([^`\n]+)`)|(\[([^\]\n]+)\]\(([^)\s]+)\))/;

export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let rest = text;
  while (rest.length > 0) {
    const m = rest.match(INLINE_RE);
    if (!m || m.index === undefined) {
      spans.push({ text: rest });
      break;
    }
    if (m.index > 0) spans.push({ text: rest.slice(0, m.index) });
    if (m[2] !== undefined) spans.push({ text: m[2], bold: true });
    else if (m[4] !== undefined) spans.push({ text: m[4], italic: true });
    else if (m[6] !== undefined) spans.push({ text: m[6], code: true });
    else spans.push({ text: m[8], url: m[9] });
    rest = rest.slice(m.index + m[0].length);
  }
  return spans;
}

export function parseMarkdown(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: MdSpan[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({
        kind: "paragraph",
        spans: parseInline(paragraph.join(" ")),
      });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list !== null) {
      blocks.push({ kind: "list", items: list });
      list = null;
    }
  };

  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else if (bullet) {
      flushParagraph();
      list = list ?? [];
      list.push(parseInline(bullet[1]));
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** First non-empty line of the raw source (compact-surface summary). */
export function firstLine(source: string): string {
  for (const line of source.split("\n")) {
    if (line.trim() !== "") return line.trim();
  }
  return "";
}

/** Flatten inline markdown to plain text; links become `text (url)`. */
export function stripInline(text: string): string {
  return parseInline(text)
    .map((s) => (s.url !== undefined ? `${s.text} (${s.url})` : s.text))
    .join("");
}

function spanToAnsi(span: MdSpan, dim: boolean): string {
  let text = span.text;
  if (span.url !== undefined) text = `${colors.underline(text)} (${span.url})`;
  if (span.underline) text = colors.underline(text);
  if (span.code) text = colors.cyan(text);
  if (span.bold) text = colors.bold(text);
  if (span.italic) text = colors.italic(text);
  // Dim outermost per span so inner style resets can't cancel it early.
  return dim ? colors.dim(text) : text;
}

export function renderInlineAnsi(
  text: string,
  opts: { dim?: boolean } = {},
): string {
  return parseInline(text)
    .map((span) => spanToAnsi(span, opts.dim === true))
    .join("");
}

function sameStyle(a: MdSpan, b: MdSpan): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code &&
    a.underline === b.underline && a.url === b.url;
}

/** Greedy word-wrap of inline spans to `width` columns, preserving styles. */
function wrapSpans(spans: MdSpan[], width: number): MdSpan[][] {
  const words: MdSpan[] = [];
  for (const span of spans) {
    if (span.url !== undefined) {
      // Flatten links for wrapping: underlined text plus a plain (url) word.
      for (const w of span.text.split(/\s+/)) {
        if (w) words.push({ text: w, underline: true });
      }
      words.push({ text: `(${span.url})` });
      continue;
    }
    const { text: _text, ...style } = span;
    for (const w of span.text.split(/\s+/)) {
      if (w) words.push({ ...style, text: w });
    }
  }

  const lines: MdSpan[][] = [];
  let line: MdSpan[] = [];
  let used = 0;
  for (const word of words) {
    const needed = line.length === 0
      ? word.text.length
      : used + 1 + word.text.length;
    if (line.length > 0 && needed > width) {
      lines.push(line);
      line = [{ ...word }];
      used = word.text.length;
      continue;
    }
    if (line.length > 0) {
      const prev = line[line.length - 1];
      if (sameStyle(prev, word)) prev.text += ` ${word.text}`;
      else line.push({ ...word, text: ` ${word.text}` });
    } else {
      line.push({ ...word });
    }
    used = needed;
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [[{ text: "" }]];
}

/**
 * Layout the whole document as styled span lines wrapped to `width`.
 * Blank line between blocks is an empty array; bullet prefixes are spans.
 */
export function wrapMarkdown(source: string, width: number): MdSpan[][] {
  const lines: MdSpan[][] = [];
  const blocks = parseMarkdown(source);
  blocks.forEach((block, i) => {
    if (i > 0) lines.push([]);
    if (block.kind === "paragraph") {
      lines.push(...wrapSpans(block.spans, width));
    } else {
      for (const item of block.items) {
        wrapSpans(item, Math.max(1, width - 2)).forEach((wrapped, idx) => {
          lines.push([{ text: idx === 0 ? "• " : "  " }, ...wrapped]);
        });
      }
    }
  });
  return lines;
}

/** ANSI-rendered document lines wrapped to `width`. */
export function renderAnsiLines(
  source: string,
  width: number,
  opts: { dim?: boolean } = {},
): string[] {
  const dim = opts.dim === true;
  return wrapMarkdown(source, width).map((line) =>
    line.map((span) => spanToAnsi(span, dim)).join("")
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function spanToHtml(span: MdSpan): string {
  let html = escapeHtml(span.text);
  if (span.code) html = `<code>${html}</code>`;
  if (span.bold) html = `<strong>${html}</strong>`;
  if (span.italic) html = `<em>${html}</em>`;
  if (span.url !== undefined) {
    // Only http(s) links become anchors; anything else renders inert.
    if (/^https?:\/\//i.test(span.url)) {
      html =
        `<a href="${escapeHtml(span.url)}" target="_blank" rel="noopener">${html}</a>`;
    } else {
      html = `${html} (${escapeHtml(span.url)})`;
    }
  }
  return html;
}

/** Escaped HTML for the serve client (server-side rendered). */
export function renderHtml(source: string): string {
  return parseMarkdown(source)
    .map((block) =>
      block.kind === "paragraph"
        ? `<p>${block.spans.map(spanToHtml).join("")}</p>`
        : `<ul>${
          block.items
            .map((item) => `<li>${item.map(spanToHtml).join("")}</li>`)
            .join("")
        }</ul>`
    )
    .join("");
}
```

- [ ] **Step 4: Run tests, iterate until green**

Run: `deno test --allow-env --allow-read src/lib/markdown.test.ts`
Expected: PASS. If the wrap/inline expectations mismatch on exact span
boundaries, fix the implementation (not the intent of the tests: literal
fallback, style preservation, width limits, escaping are the contract).

- [ ] **Step 5: Commit**

```bash
git add src/lib/markdown.ts src/lib/markdown.test.ts
git commit -m "feat(lib): add markdown subset parser with ANSI and HTML renderers"
```

---

### Task 4: `status` ladder rendering + `--description` flag

**Files:**
- Modify: `src/commands/status.ts` (`BranchStatus` at line 36, `RenderRow` at
  line 67, `StatusOptions` at line 92, `renderRow`/`renderStackDisplay` at
  lines 286-395, `buildStackStatus` at line 397)
- Modify: `src/cli.ts` (status command options around line 283 and the
  `runStatus` closure around line 476)
- Test: `src/commands/status.test.ts`

**Interfaces:**
- Consumes: `StackNode.description` (Task 2); `firstLine`, `renderInlineAnsi`,
  `renderAnsiLines` from `src/lib/markdown.ts` (Task 3);
  `renderPrefixColumns`, `ansiColor`, `colors` already in `status.ts`.
- Produces: `BranchStatus.description?: string` (raw markdown; Task 6's serve
  payload relies on this); `StatusOptions.fullDescriptions?: boolean`;
  `cli.ts status --description`.

- [ ] **Step 1: Write the failing tests**

Add to `src/commands/status.test.ts` (the file already has `stripAnsi`,
`createTestRepo`, `addBranch`, `setStackNode`, `setBaseBranch`,
`makeMockDir`, `runGit`):

```ts
describe("branch descriptions in status", () => {
  test("ladder shows a dimmed first line under a described branch", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await runGit(
      repo.dir,
      "config",
      "branch.feat/a.description",
      "adds the **api** client\nsecond line detail",
    );

    const status = await getStackStatus(repo.dir, "my-stack");
    const lines = stripAnsi(status.display).split("\n");
    expect(status.branches[0].description).toBe(
      "adds the **api** client\nsecond line detail",
    );
    // Line 0: the branch row. Line 1: rail + first description line only.
    expect(lines[1]).toContain("adds the api client");
    expect(lines[1].trimStart().startsWith("│")).toBe(true);
    expect(status.display).not.toContain("second line detail");
  });

  test("no description means no extra line", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");

    const status = await getStackStatus(repo.dir, "my-stack");
    expect(stripAnsi(status.display).split("\n")).toHaveLength(2);
    expect(status.branches[0].description).toBeUndefined();
  });

  test("fullDescriptions renders the whole markdown body with rails", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setBaseBranch(repo.dir, "my-stack", "main");
    await runGit(
      repo.dir,
      "config",
      "branch.feat/a.description",
      "summary line\n\n- cache reads\n- invalidate on submit",
    );

    const status = await getStackStatus(
      repo.dir,
      "my-stack",
      undefined,
      undefined,
      { fullDescriptions: true },
    );
    const display = stripAnsi(status.display);
    expect(display).toContain("summary line");
    expect(display).toContain("• cache reads");
    expect(display).toContain("• invalidate on submit");
    // Every description line is rail-prefixed.
    for (const line of display.split("\n").slice(1, -1)) {
      expect(line.trimStart().startsWith("│")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/status.test.ts --filter "branch descriptions in status"`
Expected: FAIL (no `description` field, no extra lines).

- [ ] **Step 3: Implement in `src/commands/status.ts`**

1. Import from the markdown lib:

```ts
import {
  firstLine,
  renderAnsiLines,
  renderInlineAnsi,
} from "../lib/markdown.ts";
```

2. `BranchStatus` and `RenderRow` gain `description?: string`.
   `StatusOptions` gains:

```ts
  /**
   * Render each branch's full markdown description in the ladder instead of
   * the dimmed first line. Set by `status --description`.
   */
  fullDescriptions?: boolean;
```

3. `buildStackStatus`: inside the `nodes.map` that builds each
   `BranchStatus`, spread the node's description into the result object:

```ts
        ...(node.description ? { description: node.description } : {}),
```

4. Add the continuation-line renderer next to `renderRow` (wrap width is a
   module constant `const DESCRIPTION_WRAP_WIDTH = 72;`):

```ts
function renderDescriptionLines(
  row: RenderRow,
  colorMap: Map<string, string>,
  rootStackNames: string[],
  graphWidth: number,
  fullDescriptions: boolean,
): string[] {
  if (!row.description) return [];
  const stackColor = ansiColor(colorMap.get(row.stackName) ?? "cyan");
  const trunk = renderPrefixColumns(
    row.pipeCount,
    row.rootIndex,
    row.stackName,
    rootStackNames,
    colorMap,
    row.merged,
  );
  const rail = stackColor(row.merged ? colors.dim("│") : "│");
  // Pad past the marker column to the branch-label column, plus a 2-space
  // inset so the description reads as subordinate to the branch name.
  const pad = " ".repeat(
    Math.max(0, graphWidth - row.pipeCount * 2 - 1) + 2,
  );
  const body = fullDescriptions
    ? renderAnsiLines(row.description, DESCRIPTION_WRAP_WIDTH, { dim: true })
    : [renderInlineAnsi(firstLine(row.description), { dim: true })];
  return body.map((text) => `${trunk}${rail}${pad}${text}`);
}
```

5. `renderStackDisplay` gains a final `fullDescriptions: boolean` parameter.
   Populate `description: branch.description` when building each `RenderRow`,
   and replace the `const lines = rows.map(...)` with:

```ts
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(renderRow(row, colorMap, rootStackNames, graphWidth, branchWidth));
    lines.push(
      ...renderDescriptionLines(
        row,
        colorMap,
        rootStackNames,
        graphWidth,
        fullDescriptions,
      ),
    );
  }
```

6. Both `renderStackDisplay` call sites (in `buildStackStatus` and, if it is
   called separately in `getAllStackStatuses`, there too) pass
   `opts.fullDescriptions === true`.

- [ ] **Step 4: Wire the CLI flag in `src/cli.ts`**

After the `--archived` option on the status command:

```ts
  .option(
    "--description",
    "Show full branch descriptions in the ladder output",
  )
```

In the `runStatus` closure, add `fullDescriptions: options.description === true`
to both the `getAllStackStatuses` and `getStackStatus` options objects
(alongside the existing `loadPrs` / `fetch` entries). The TUI launch path does
not receive it (the detail pane always shows the description).

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/status.test.ts`
Expected: PASS (new and existing).

- [ ] **Step 6: Eyeball the real output**

Run (in this repo, after setting a throwaway description):
```bash
git config branch.wyattjoh/serve-command.description "test **description** line"
deno run --allow-run=git,gh --allow-env --allow-read --allow-net src/cli.ts status --all
deno run --allow-run=git,gh --allow-env --allow-read --allow-net src/cli.ts status --all --description
git config --unset branch.wyattjoh/serve-command.description
```
Expected: dimmed styled line under the branch; full block with `--description`;
rails continuous; alignment matches the spec mockups.

- [ ] **Step 7: Commit**

```bash
git add src/commands/status.ts src/commands/status.test.ts src/cli.ts
git commit -m "feat(status): render branch descriptions in the ladder with --description flag"
```

---

### Task 5: TUI detail pane (markdown body, j/k scrolling, hint)

**Files:**
- Modify: `src/tui/components/detail-pane.tsx` (body restructure)
- Modify: `src/tui/app.tsx` (description prop at the `DetailPane` render site
  ~line 857; `j`/`k` aliases in the detail-focused `useInput` branch at lines
  666-690)
- Modify: `src/tui/components/help-overlay.tsx` (key binding row)
- Test: `src/tui/components/detail-pane.test.tsx`

**Interfaces:**
- Consumes: `StackNode.description` via `state.allTrees` (reducer state);
  `wrapMarkdown`, `MdSpan` from `src/lib/markdown.ts`; `getAllNodes` from
  `src/lib/stack.ts`.
- Produces: `DetailPaneProps.description?: string` and
  `DetailPaneProps.width?: number`. No reducer changes (`DETAIL_SCROLL`
  already exists).

- [ ] **Step 1: Write the failing component tests**

Add to `src/tui/components/detail-pane.test.tsx` (follow the file's existing
render/props patterns; every test destructures and calls `unmount`):

```tsx
test("renders the markdown description between worktree and commits", () => {
  const { lastFrame, unmount } = render(
    <DetailPane
      branch="feat/a"
      prCell={undefined}
      syncStatus="up-to-date"
      commitsCell={{
        status: "loaded",
        commits: [{ sha: "abc1234", subject: "Add cache" }],
      }}
      worktree={undefined}
      description={"reduce upstream calls\n\n- cache reads"}
      width={60}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("reduce upstream calls");
  expect(frame).toContain("• cache reads");
  expect(frame).toContain("abc1234 Add cache");
  unmount();
});

test("overflow marker row carries the j/k navigation hint", () => {
  const commits = Array.from({ length: 12 }, (_, i) => ({
    sha: `sha${i}00`,
    subject: `commit ${i}`,
  }));
  const { lastFrame, unmount } = render(
    <DetailPane
      branch="feat/a"
      prCell={undefined}
      syncStatus="up-to-date"
      commitsCell={{ status: "loaded", commits }}
      worktree={undefined}
      description="a description line"
      width={60}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("more");
  expect(frame).toContain("j/k for navigation");
  unmount();
});

test("scrollY reaches description rows pushed out of the viewport", () => {
  const commits = Array.from({ length: 12 }, (_, i) => ({
    sha: `sha${i}00`,
    subject: `commit ${i}`,
  }));
  const { lastFrame, unmount } = render(
    <DetailPane
      branch="feat/a"
      prCell={undefined}
      syncStatus="up-to-date"
      commitsCell={{ status: "loaded", commits }}
      worktree={undefined}
      description="the description"
      width={60}
      scrollY={3}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("↑");
  expect(frame).toContain("commit");
  unmount();
});

test("no description leaves the pane unchanged", () => {
  const { lastFrame, unmount } = render(
    <DetailPane
      branch="feat/a"
      prCell={undefined}
      syncStatus="up-to-date"
      commitsCell={{ status: "loaded", commits: [] }}
      worktree={undefined}
      width={60}
    />,
  );
  expect(lastFrame() ?? "").not.toContain("j/k");
  unmount();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read src/tui/components/detail-pane.test.tsx`
Expected: FAIL (unknown `description` / `width` props).

- [ ] **Step 3: Restructure `detail-pane.tsx`**

Replace the commits-only body with a unified scrollable body. Key changes:

1. Imports and constants:

```tsx
import { type MdSpan, wrapMarkdown } from "../../lib/markdown.ts";
```

Replace the `BODY_BUDGET` computation and its comment: the blank separator is
now a body row itself, so

```tsx
/**
 * Row budget for the scrollable body (description + separator + commits).
 * The fixed pane height of 10 gives an inner content area of 8 rows; we
 * reserve 2 for the header + worktree metadata, leaving 6 body rows. When
 * both scroll markers are visible the shown-row count drops so the markers
 * still fit inside the box. Keep `CHROME_HEIGHT_BASE` in `app.tsx` in sync
 * with `PANE_HEIGHT`.
 */
const PANE_HEIGHT = 10;
const BODY_BUDGET = PANE_HEIGHT - 2 /* border */ - 2 /* header + worktree */;
```

2. Props gain:

```tsx
  /** Raw markdown description for the focused branch, when set. */
  description?: string;
  /** Inner content width in columns; used to wrap the description. */
  width?: number;
```

3. Body assembly (replace the current `body` construction):

```tsx
  type BodyLine =
    | { kind: "md"; spans: MdSpan[] }
    | { kind: "text"; text: string; dim?: boolean }
    | { kind: "blank" };

  const contentWidth = Math.max(10, (props.width ?? 80) - 2);
  const bodyLines: BodyLine[] = [];
  if (props.description) {
    for (const spans of wrapMarkdown(props.description, contentWidth)) {
      bodyLines.push(
        spans.length === 0 ? { kind: "blank" } : { kind: "md", spans },
      );
    }
  }
  bodyLines.push({ kind: "blank" });
  if (!props.commitsCell || props.commitsCell.status === "loading") {
    bodyLines.push({ kind: "text", text: "loading commits...", dim: true });
  } else if (props.commitsCell.status === "error") {
    bodyLines.push({ kind: "text", text: "error loading commits", dim: true });
  } else {
    for (const c of props.commitsCell.commits) {
      bodyLines.push({ kind: "text", text: `${c.sha} ${c.subject}` });
    }
  }

  const fitsInBudget = bodyLines.length <= BODY_BUDGET;
  const cap = fitsInBudget ? BODY_BUDGET : Math.max(1, BODY_BUDGET - 2);
  const start = Math.min(scrollY, Math.max(0, bodyLines.length - cap));
  const shown = bodyLines.slice(start, start + cap);
  const above = start;
  const below = Math.max(0, bodyLines.length - (start + shown.length));

  const body = (
    <Box flexDirection="column">
      {above > 0 && <Text dimColor>↑ {above} more</Text>}
      {shown.map((line, i) => {
        if (line.kind === "blank") return <Box key={i} height={1} />;
        if (line.kind === "md") {
          return (
            <Box key={i}>
              <Text dimColor>
                {line.spans.map((span, j) => (
                  <React.Fragment key={j}>
                    <Text
                      bold={span.bold}
                      italic={span.italic}
                      underline={span.underline || span.url !== undefined}
                      color={span.code ? "cyan" : undefined}
                      dimColor
                    >
                      {span.url !== undefined
                        ? `${span.text} (${span.url})`
                        : span.text}
                    </Text>
                  </React.Fragment>
                ))}
              </Text>
            </Box>
          );
        }
        const clipped = scrollX > 0 ? line.text.slice(scrollX) : line.text;
        return (
          <Box key={i}>
            <Text dimColor={line.dim}>{clipped}</Text>
          </Box>
        );
      })}
      {below > 0 && (
        <Box justifyContent="space-between">
          <Text dimColor>↓ {below} more</Text>
          <Text dimColor>j/k for navigation</Text>
        </Box>
      )}
      {below === 0 && above > 0 && (
        <Box justifyContent="flex-end">
          <Text dimColor>j/k for navigation</Text>
        </Box>
      )}
    </Box>
  );
```

Remove the old blank-separator `<Box height={1} />` between worktree row and
body (the separator is a body row now) and render `{body}` directly after the
worktree row. Note the Ink gotcha: `key` goes on `<Box>` / `<React.Fragment>`
wrappers, never on `<Text>`.

Drop the hint block for `below === 0 && above > 0` if it pushes the pane past
its height budget in practice; the spec only requires the hint on a visible
marker row (`↓ N more` line). Verify with the tests.

- [ ] **Step 4: Wire `app.tsx`**

1. Import `getAllNodes` (extend the existing `../lib/stack.ts` import if
   present, otherwise add it) and derive the focused description near the
   other `focusedBranch` lookups:

```tsx
  const focusedDescription = React.useMemo(() => {
    if (!focusedBranch) return undefined;
    for (const tree of state.allTrees) {
      for (const node of getAllNodes(tree)) {
        if (node.branch === focusedBranch) return node.description;
      }
    }
    return undefined;
  }, [focusedBranch, state.allTrees]);
```

2. Pass it to the pane:

```tsx
            <DetailPane
              branch={focusedBranch}
              ...
              description={focusedDescription}
              width={termSize.cols - 2}
              ...
            />
```

3. `j`/`k` aliases in the detail-focused input branch (lines 666-690): change

```ts
      if (key.upArrow) {
```
to
```ts
      if (key.upArrow || input === "k") {
```
and
```ts
      } else if (key.downArrow) {
```
to
```ts
      } else if (key.downArrow || input === "j") {
```

- [ ] **Step 5: Add the help-overlay binding**

In `src/tui/components/help-overlay.tsx`, in the Navigation section's bindings
after the `tab / shift-tab` row:

```ts
      { keys: "j / k", action: "scroll detail pane (when focused)" },
```

- [ ] **Step 6: Run the TUI test suites**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/tui/`
Expected: PASS (new detail-pane tests plus existing app integration test).

- [ ] **Step 7: Eyeball the TUI**

```bash
git config branch.wyattjoh/serve-command.description "test **description**\n\n- with a bullet"
deno task tui
git config --unset branch.wyattjoh/serve-command.description
```
Expected: description renders dimmed with styles in the pane; `tab` to the
detail pane, `j`/`k` scroll; marker row shows the right-aligned hint.

- [ ] **Step 8: Commit**

```bash
git add src/tui/components/detail-pane.tsx src/tui/components/detail-pane.test.tsx src/tui/app.tsx src/tui/components/help-overlay.tsx
git commit -m "feat(tui): render markdown branch descriptions in the detail pane with j/k scrolling"
```

---

### Task 6: serve payload + client expand/collapse

**Files:**
- Modify: `src/commands/serve.ts` (`ServeBranchGraphRow.branchStatus` type at
  line 70, `ServeStackStatus`/`ServeAllStacksStatus` at lines 92-101,
  `buildServeBranchGraph` at line 509, `stripStatusAnsi` at line 524)
- Modify: `src/commands/serve.client.js` (`renderGraphRows` at lines 588-672;
  module-level expansion state; `render()` at line 1150 is the re-render
  entry)
- Modify: `src/commands/serve.css` (`.branch-desc` rules)
- Test: `src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `BranchStatus.description` (Task 4); `renderHtml`, `stripInline`,
  `firstLine` from `src/lib/markdown.ts` (Task 3).
- Produces: `ServeBranchStatus = BranchStatus & { descriptionHtml?: string; descriptionSummary?: string }`
  exported from `serve.ts`; branch entries in `/api/status` (and the graph
  rows' `branchStatus`) carry both fields when a description is set.

- [ ] **Step 1: Write the failing server test**

Add to `src/commands/serve.test.ts`, following the file's existing
`buildServeStatus` test pattern (temp repo + configured stack; reuse its
setup helpers):

```ts
test("branch descriptions ship as escaped html and plain summary", async () => {
  await using repo = await createTestRepo();
  await using _mock = await makeMockDir();
  await addBranch(repo.dir, "feat/a", "main");
  await setStackNode(repo.dir, "feat/a", "alpha", "main");
  await setBaseBranch(repo.dir, "alpha", "main");
  await runGit(
    repo.dir,
    "config",
    "branch.feat/a.description",
    "adds the **api** client\nsecond line",
  );

  const status = await buildServeStatus([
    { name: "repo", path: repo.dir },
  ]);
  const branch = status.repositories[0].status!.stacks[0].branches[0];
  expect(branch.description).toBe("adds the **api** client\nsecond line");
  expect(branch.descriptionHtml).toBe(
    "<p>adds the <strong>api</strong> client second line</p>",
  );
  expect(branch.descriptionSummary).toBe("adds the api client");
  const row = status.repositories[0].status!.stacks[0].graph.rows.find(
    (r) => r.branch === "feat/a",
  );
  expect(row?.branchStatus?.descriptionHtml).toContain("<strong>api</strong>");
});
```

Adjust the exact `buildServeStatus` invocation to match the existing tests in
the file (repository argument shape and any required options); the assertions
are the contract. Note the paragraph joins the two source lines with a space
(markdown soft-wrap).

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts --filter "descriptions"`
Expected: FAIL (`descriptionHtml` undefined).

- [ ] **Step 3: Implement the server side in `serve.ts`**

1. Import:

```ts
import { firstLine, renderHtml, stripInline } from "../lib/markdown.ts";
```

2. New type next to the other Serve types; switch `branchStatus` (line 70)
   and the graph builder to it:

```ts
/** Branch status enriched with server-rendered description variants. */
export type ServeBranchStatus = BranchStatus & {
  /** Escaped HTML of the full markdown description. */
  descriptionHtml?: string;
  /** Plain-text first line for the collapsed row. */
  descriptionSummary?: string;
};
```

`ServeBranchGraphRow.branchStatus: ServeBranchStatus | null;` and
`ServeStackStatus` overrides branches:

```ts
export interface ServeStackStatus extends Omit<StackStatus, "branches"> {
  branches: ServeBranchStatus[];
  graph: ServeBranchGraph;
}
```

3. Augment in `stripStatusAnsi` so both `stack.branches` and the graph rows
   built from them carry the fields:

```ts
function withDescriptionVariants(branch: BranchStatus): ServeBranchStatus {
  if (!branch.description) return branch;
  return {
    ...branch,
    descriptionHtml: renderHtml(branch.description),
    descriptionSummary: stripInline(firstLine(branch.description)),
  };
}

function stripStatusAnsi(status: AllStacksStatus): ServeAllStacksStatus {
  return {
    ...status,
    display: stripAnsi(status.display),
    stacks: status.stacks.map((stack) => {
      const branches = stack.branches.map(withDescriptionVariants);
      return {
        ...stack,
        branches,
        display: stripAnsi(stack.display),
        graph: buildServeBranchGraph({ ...stack, branches }),
      };
    }),
  };
}
```

`buildServeBranchGraph`'s parameter type widens to accept
`StackStatus | (Omit<StackStatus, "branches"> & { branches: ServeBranchStatus[] })`;
simplest is changing its signature to take
`{ branches: ServeBranchStatus[] } & Pick<StackStatus, never>` style or just
`{ branches: ServeBranchStatus[] }` since it only reads `branches`. Follow
the compiler.

- [ ] **Step 4: Run the server test**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts`
Expected: PASS (new test plus all existing serve tests).

- [ ] **Step 5: Implement the client in `serve.client.js`**

1. Module-level expansion state near the other view-state helpers (this is
   transient per page load, deliberately not persisted):

```js
// Branch-description rows expanded by click. Keyed by repo path + branch so
// the same branch name in two repos expands independently.
const expandedDescriptions = new Set();
```

2. `renderGraphRows` currently returns a flat flex `.branch-row`. Restructure
   so the lane div stretches the full (possibly expanded) row height and the
   text content stacks vertically. Replace the tail of the row construction
   (from `const nm = splitName(row.branch);` through the final `return`) with:

```js
    const nm = splitName(row.branch);
    const mainChildren = [
      branchLabel(nm.prefix, nm.mainName, "#e6edf3", ctx.font),
    ];
    mainChildren.push(inlineStatus(status));
    if (co) mainChildren.push(checkedOutBadge(ctx.color));
    mainChildren.push(el("span", {
      class: "name-action-group branch-name-action-group",
    }, [
      copyNameButton("branch", row.branch),
    ]));
    mainChildren.push(prRail(status ? status.pr : null));
    const mainLine = el("div", {
      style: `display:flex;align-items:center;min-height:${ctx.row}px;`,
    }, mainChildren);

    const contentChildren = [mainLine];
    if (status && status.descriptionHtml) {
      const key = `${ctx.repoPath || ""}:${row.branch}`;
      const expanded = expandedDescriptions.has(key);
      const desc = el("div", {
        class: "branch-desc" + (expanded ? " expanded" : ""),
        title: expanded ? "Click to collapse" : "Click to expand",
      });
      if (expanded) {
        // Server-rendered, text-node-escaped HTML (see renderHtml in
        // src/lib/markdown.ts). The client never parses markdown itself.
        desc.innerHTML = status.descriptionHtml;
      } else {
        desc.textContent = status.descriptionSummary || "";
      }
      desc.addEventListener("click", (event) => {
        event.stopPropagation();
        if (expanded) expandedDescriptions.delete(key);
        else expandedDescriptions.add(key);
        render();
      });
      contentChildren.push(desc);
    }
    const content = el("div", {
      style:
        "flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;",
    }, contentChildren);

    let rowStyle =
      `display:flex;align-items:stretch;min-height:${ctx.row}px;position:relative;` +
      `margin-left:-${CARD_PAD_X}px;margin-right:-${CARD_PAD_X}px;` +
      `padding-left:${CARD_PAD_X}px;padding-right:${CARD_PAD_X}px;`;
    const tintAlpha = co ? 0.13 : (i % 2 === 0 ? 0.045 : 0.028);
    const hoverAlpha = co ? 0.2 : 0.1;
    rowStyle += `--row-tint:${hexToRgba(ctx.color, tintAlpha)};` +
      `--row-tint-hover:${hexToRgba(ctx.color, hoverAlpha)};` +
      `--node-ring:${hexToRgba(ctx.color, 0.5)};`;
    return el("div", { class: "branch-row", style: rowStyle }, [lane, content]);
```

Preserve the existing zebra/tint comments where they still apply. Two
alignment notes for the implementer: (a) the row's `align-items` changes from
`center` to `stretch` so the lane rails span an expanded row; the node dot and
rail positions inside the lane are absolutely positioned so they are
unaffected, but verify the node dot stays vertically centered on the FIRST
line by checking `nodeEl`'s positioning (if it centers at 50% of the lane,
anchor it instead to `top:${Math.round(ctx.row / 2)}px` when descriptions can
expand). (b) `ctx.repoPath`: thread the repository path into `ctx` at the
`renderGraphRows` call sites (grep for `renderGraphRows(` in
`serve.client.js`; each caller builds `ctx` and has the repo in scope as
`repo.path` or equivalent). If a call site truly has no repo, omit it; the
key degrades to `:branch` which is still stable within that view.

3. `render()` (line 1150) is the full re-render entry; the click handler
   calls it after toggling, which rebuilds rows from the current model and
   the updated `expandedDescriptions`.

- [ ] **Step 6: Style `.branch-desc` in `serve.css`**

Add alongside the other `.branch-row` rules:

```css
/* Collapsed branch description: one muted ellipsis line under the branch
   name; click toggles the expanded markdown block. */
.branch-desc {
  color: #8b949e;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 0 6px;
}
.branch-desc.expanded {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
}
.branch-desc p {
  margin: 0 0 4px;
}
.branch-desc ul {
  margin: 0 0 4px;
  padding-left: 18px;
}
.branch-desc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  background: rgba(110, 118, 129, 0.2);
  border-radius: 3px;
  padding: 0 3px;
}
.branch-desc a {
  color: #58a6ff;
}
```

- [ ] **Step 7: Verify in the browser**

```bash
git config branch.wyattjoh/serve-command.description "reduce **calls** with a cache\n\n- cache reads\n- invalidate on submit"
deno run --allow-run=git,gh,open --allow-env --allow-read --allow-net src/cli.ts serve
```
Expected: muted truncated line under the described branch; click expands to
the rendered markdown (bold, bullets) and stretches the lane rails; click
collapses; other rows unaffected. Check both the all-stacks overview and the
single-stack view. Then:
```bash
git config --unset branch.wyattjoh/serve-command.description
```

- [ ] **Step 8: Run the serve suite and full checks**

Run: `deno task check && deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/commands/serve.ts src/commands/serve.test.ts src/commands/serve.client.js src/commands/serve.css
git commit -m "feat(serve): render branch descriptions with click-to-expand markdown"
```

---

### Task 7: Documentation + final verification

**Files:**
- Modify: `skills/stacked-prs/SKILL.md` (status section + status invocation
  block)
- Modify: `README.md` (status docs + subcommand table)
- Modify: `CLAUDE.md` (git config schema, shared-library list, command table)

**Interfaces:**
- Consumes: everything above. Produces: docs only.

- [ ] **Step 1: SKILL.md**

In the `status` section (near the sync-status numbered list), add a numbered
point:

```markdown
5. Branch descriptions: when `branch.<name>.description` is set (markdown,
   written with `git branch --edit-description <branch>` or
   `git config branch.<name>.description "..."`), `status` shows the dimmed
   first line under the branch; add `--description` to print descriptions in
   full. Setting a description is a plain metadata config write and needs no
   confirmation gate. The tooling itself never writes this key unprompted.
```

Add `[--description]` to the status invocation block:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/stacked-prs/scripts/stacked-prs status \
  [--stack-name=<name>] [--owner=<owner> --repo=<repo>] [--json] [--pr|-p] [--all] [--archived] [--fetch] [--description] [--interactive|-i] [--theme <theme>]
```

And extend the prose after the invocation with one sentence: descriptions are
markdown from the native `branch.<name>.description` key, shown first-line by
default, in full with `--description`, and always raw in `--json`.

- [ ] **Step 2: README.md**

In the status section, add a short subsection:

```markdown
### Branch descriptions

Give any stack branch an optional markdown description of what it is supposed
to accomplish:

```bash
git branch --edit-description feat/api-cache
```

When set, `status` shows the dimmed first line under the branch
(`--description` prints it in full), the TUI detail pane renders it for the
focused branch (scroll with `j`/`k`), and the `serve` view shows a muted
summary line you can click to expand. Descriptions are stored in git's native
`branch.<name>.description` config key: repo-local, cleaned up automatically
when the branch is deleted.
```

Update the subcommand table's status row to
`cli.ts status [--json] [--all] [--fetch] [--description]`.

- [ ] **Step 3: CLAUDE.md**

1. Git config schema block: add a line under the branch keys:

```
branch.<name>.description          # (Optional, native git key) markdown description; read-only for this tooling, rendered by status/TUI/serve
```

2. The layout tree and the "Scripts" table: update `status.ts`'s invocation to
   `cli.ts status [--fetch] [--description] [--json]`; add
   `markdown.ts  # Markdown subset parser + ANSI/Ink-span/HTML renderers`
   to the `src/lib/` listing; add `markdown.ts` to the Development rules
   shared-library list.

3. In the prose about `status`, add two sentences: descriptions come from the
   native key via `readAllBranchStackConfig` (whose `--get-regexp` parsing is
   now NUL-separated to survive multi-line values) and render first-line by
   default, fully with `--description`; serve ships server-rendered
   `descriptionHtml`/`descriptionSummary` so the browser client stays
   parser-free.

- [ ] **Step 4: Full verification**

```bash
deno task check
deno task test
deno task install
```
Expected: check green; test green except the pre-existing
`cli.signal-shim.test.ts` baseline failure on Deno 2.9.1 (unrelated, fails at
HEAD too); install succeeds.

- [ ] **Step 5: Commit**

```bash
git add skills/stacked-prs/SKILL.md README.md CLAUDE.md
git commit -m "feat: document branch descriptions across SKILL.md, README, and CLAUDE.md"
```

---

## Self-review notes

- Spec coverage: NUL-safe parsing (Task 1), scanner/types (Task 2), markdown
  subset + three renderers (Task 3), ladder + `--description` (Task 4), TUI
  markdown body + j/k + hint (Task 5), serve payload + click-to-expand
  (Task 6), docs (Task 7). The spec's `descriptionSummary` is a payload
  addition beyond the spec's named fields, chosen so the browser client stays
  parser-free for the collapsed line too.
- Types: `MdSpan`/`wrapMarkdown` (Task 3) are consumed by name in Tasks 4-6;
  `ServeBranchStatus` extends `BranchStatus` with the two serve-only fields.
- Tombstoned branches never render descriptions (their config is gone;
  `buildNode` reads only live `branchConfig` entries).
