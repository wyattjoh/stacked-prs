import React from "react";
import { expect } from "@std/expect";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { addBranch, createTestRepo } from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import { runGitCommand, setBaseBranch, setStackNode } from "../lib/stack.ts";
import { setMockDir, writeFixture } from "../lib/gh.ts";
import { App } from "./app.tsx";

/**
 * Stdout shim with controllable dimensions. `ink-testing-library` hard-codes
 * columns=100 and has no `rows`, which makes narrow-terminal regressions
 * invisible there. Using Ink's own `render` with this shim lets us exercise
 * the real narrow-window scenario end-to-end.
 */
class SizedStdout extends EventEmitter {
  cols: number;
  rowsN: number;
  isTTY = true;
  frames: string[] = [];
  constructor(cols: number, rows: number) {
    super();
    this.cols = cols;
    this.rowsN = rows;
  }
  get columns() {
    return this.cols;
  }
  get rows() {
    return this.rowsN;
  }
  write = (frame: string) => {
    this.frames.push(frame);
  };
}

/**
 * Ink reads stdin via `addListener('readable', ...)` + `stdin.read()`, so
 * this shim buffers chunks and returns them from `read()`. `send()` is the
 * public helper tests call to simulate a keypress.
 */
class TestStdin extends EventEmitter {
  isTTY = true;
  #buffer: string[] = [];
  setRawMode() {}
  setEncoding() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() {
    return this.#buffer.shift() ?? null;
  }
  send(data: string) {
    this.#buffer.push(data);
    this.emit("readable");
  }
}

function latestFrame(stdout: SizedStdout): string {
  for (let i = stdout.frames.length - 1; i >= 0; i--) {
    const f = stdout.frames[i];
    if (f.length > 40) return f;
  }
  return "";
}

function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replaceAll(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Split a stripped frame into the stack-map region (between the header
 * and the detail pane) and the detail pane header line. Assertions rely
 * on plain-text presence so they pass regardless of whether chalk decided
 * to emit color escapes (varies with FORCE_COLOR + TTY detection).
 */
function regions(frame: string): { stackMap: string; detailHeader: string } {
  const lines = frame.split("\n");
  // HeaderBox uses round corners (╭/╰) so its borders don't contribute to
  // the `┌` search. That makes the first `┌` always the body wrapper's
  // top border and the last `┌` always the detail pane's top border.
  // Intermediate `┌` lines (e.g., the canopy row from initialTrunkSegments
  // in multi-stack views) live inside the body wrapper and belong to the
  // stack map region.
  const borders: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes("┌")) borders.push(i);
  }
  const bodyTop = borders[0] ?? -1;
  const detailTop = borders.at(-1) ?? lines.length;
  const stackMap = lines.slice(bodyTop + 1, detailTop).join("\n");
  const detailHeader = lines[detailTop + 1] ?? "";
  return { stackMap, detailHeader };
}

async function buildLinearStack(
  repo: TestRepo,
  mockDir: string,
  depth: number,
) {
  let parent = "main";
  for (let i = 0; i < depth; i++) {
    const branch = `feat/br-${String(i).padStart(2, "0")}`;
    await addBranch(repo.dir, branch, parent);
    await setStackNode(repo.dir, branch, "demo", parent);
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", branch],
      [{ number: 100 + i, url: `u${i}`, state: "OPEN", isDraft: false }],
    );
    parent = branch;
  }
  await setBaseBranch(repo.dir, "demo", "main");
}

async function withNarrowTestRepo(
  fn: (repo: TestRepo, mockDir: string) => Promise<void>,
) {
  const repo = await createTestRepo();
  const mockDir = await Deno.makeTempDir();
  setMockDir(mockDir);
  try {
    await fn(repo, mockDir);
  } finally {
    setMockDir(undefined);
    await repo.cleanup();
    await Deno.remove(mockDir, { recursive: true });
  }
}

// Ink's `render` uses `signal-exit` to install process-wide signal handlers
// so it can unmount on exit. Deno's default test sanitizers flag those as
// leaks even after `instance.unmount()`, so these tests opt out of op /
// resource sanitization. The assertions here are about rendered output,
// not process-lifecycle cleanup.

Deno.test({
  name:
    "App narrow nav: cursor stays visible walking up a long stack in a narrow window",
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  async fn() {
    await withNarrowTestRepo(async (repo, mockDir) => {
      await buildLinearStack(repo, mockDir, 10);
      await runGitCommand(repo.dir, "checkout", "feat/br-09");

      const stdout = new SizedStdout(50, 18);
      const stdin = new TestStdin();
      const instance = render(<App dir={repo.dir} />, {
        stdout: stdout as never,
        stdin: stdin as never,
        exitOnCtrlC: false,
      });
      try {
        await new Promise((r) => setTimeout(r, 400));

        for (let step = 0; step < 10; step++) {
          const frame = stripAnsi(latestFrame(stdout));
          const { stackMap, detailHeader } = regions(frame);
          const expected = `feat/br-${String(9 - step).padStart(2, "0")}`;
          // Ground truth for "which branch is selected" is the detail pane
          // header line, which always shows the cursor's branch name.
          expect(detailHeader).toContain(expected);
          // The core invariant the user cares about: the selected branch
          // is visible inside the stack-map viewport.
          expect(stackMap).toContain(expected);
          stdin.send("\x1b[A");
          await new Promise((r) => setTimeout(r, 60));
        }
      } finally {
        instance.unmount();
      }
    });
  },
});

async function buildMultipleStacks(
  repo: TestRepo,
  mockDir: string,
) {
  // Mirrors the user-reported layout: several stacks of varying depths that
  // all share `main`. Alphabetical stack name ordering matches the TUI's
  // render order so test expectations line up with the visible grid.
  const specs: Array<{ stack: string; branches: string[] }> = [
    {
      stack: "deps-injection-foundation",
      branches: [
        "feat/di-init",
        "feat/di-docs",
        "feat/di-container",
        "feat/di-tests",
      ],
    },
    { stack: "e2e-stack", branches: ["wyattjoh/refresh-fixtures-cron"] },
    {
      stack: "init-already-set-up",
      branches: ["refactor/init-already-set-up"],
    },
    {
      stack: "init-skills",
      branches: [
        "feat/lib-runners",
        "refactor/format-uses-runners",
        "feat/lib-non-empty-array",
      ],
    },
  ];
  for (const { stack, branches } of specs) {
    let parent = "main";
    for (const b of branches) {
      await addBranch(repo.dir, b, parent);
      await setStackNode(repo.dir, b, stack, parent);
      await writeFixture(
        mockDir,
        ["pr", "list", "--head", b],
        [{ number: 1, url: "u", state: "OPEN", isDraft: false }],
      );
      parent = b;
    }
    await setBaseBranch(repo.dir, stack, "main");
  }
}

Deno.test({
  name:
    "App narrow nav: cursor stays visible when walking across multiple stacks in a narrow window",
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  async fn() {
    await withNarrowTestRepo(async (repo, mockDir) => {
      await buildMultipleStacks(repo, mockDir);
      await runGitCommand(repo.dir, "checkout", "feat/lib-non-empty-array");

      // Narrow width + modest height = similar to the user's screenshot.
      const stdout = new SizedStdout(50, 20);
      const stdin = new TestStdin();
      const instance = render(<App dir={repo.dir} />, {
        stdout: stdout as never,
        stdin: stdin as never,
        exitOnCtrlC: false,
      });
      try {
        await new Promise((r) => setTimeout(r, 500));

        // Walk upward through every branch in render order. The ordered
        // list is reverse-DFS across all stacks; construct it from the
        // same alphabetical stack ordering the TUI uses.
        const walk: string[] = [
          "feat/lib-non-empty-array",
          "refactor/format-uses-runners",
          "feat/lib-runners",
          "refactor/init-already-set-up",
          "wyattjoh/refresh-fixtures-cron",
          "feat/di-tests",
          "feat/di-container",
          "feat/di-docs",
          "feat/di-init",
        ];
        for (const expected of walk) {
          const frame = stripAnsi(latestFrame(stdout));
          const { stackMap, detailHeader } = regions(frame);
          expect(detailHeader).toContain(expected);
          expect(stackMap).toContain(expected);
          stdin.send("\x1b[A");
          await new Promise((r) => setTimeout(r, 60));
        }
      } finally {
        instance.unmount();
      }
    });
  },
});

Deno.test({
  name:
    "App narrow nav: chrome rows (tab bar + status bar) never wrap in narrow widths",
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  async fn() {
    await withNarrowTestRepo(async (repo, mockDir) => {
      await buildMultipleStacks(repo, mockDir);

      const stdout = new SizedStdout(45, 24);
      const stdin = new TestStdin();
      const instance = render(<App dir={repo.dir} />, {
        stdout: stdout as never,
        stdin: stdin as never,
        exitOnCtrlC: false,
      });
      try {
        await new Promise((r) => setTimeout(r, 400));
        const frame = stripAnsi(latestFrame(stdout));
        const lines = frame.split("\n");
        // The HeaderBox spans rows 0-2 (top border, content, bottom border).
        // The content row (line 1) must contain both the "stacked-prs" label and
        // the "All stacks" text (active tab is All after initial load). If any
        // header row wrapped, these assertions would shift.
        expect(lines[1]).toContain("stacked-prs");
        expect(lines[1]).toContain("All stacks");
        // Chrome: HeaderBox (3) + body border (2) + detail pane (10) + status
        // bar (1) = 16. The body wrapper's top border is the first `┌` in the
        // frame. The HeaderBox uses round corners (╭/╰) so its borders are not
        // captured. The HeaderBox occupies rows 0-2, so the body wrapper's `┌`
        // is at row 3. The detail pane's `┌` sits immediately after the body
        // wrapper's bottom border; the body wrapper is `stackMapHeight + 2`
        // rows tall, where stackMapHeight = 24 - 16 = 8, giving a wrapper of
        // 10 rows (rows 3..12) and the detail pane's `┌` at row 13. Note: the
        // canopy row inside the body wrapper also starts with `┌`, so we use
        // the first and last `┌` lines to identify the body wrapper and detail
        // pane borders respectively.
        const borderLines: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes("┌")) borderLines.push(i);
        }
        expect(borderLines[0]).toBe(3); // body wrapper top border
        expect(borderLines.at(-1)).toBe(13); // detail pane top border
      } finally {
        instance.unmount();
      }
    });
  },
});

Deno.test({
  name:
    "App narrow nav: cursor stays visible walking down a multi-stack tree in a narrow window",
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  async fn() {
    await withNarrowTestRepo(async (repo, mockDir) => {
      await buildMultipleStacks(repo, mockDir);
      await runGitCommand(repo.dir, "checkout", "feat/di-init");

      const stdout = new SizedStdout(45, 22);
      const stdin = new TestStdin();
      const instance = render(<App dir={repo.dir} />, {
        stdout: stdout as never,
        stdin: stdin as never,
        exitOnCtrlC: false,
      });
      try {
        await new Promise((r) => setTimeout(r, 500));
        const walk: string[] = [
          "feat/di-init",
          "feat/di-docs",
          "feat/di-container",
          "feat/di-tests",
          "wyattjoh/refresh-fixtures-cron",
          "refactor/init-already-set-up",
          "feat/lib-runners",
          "refactor/format-uses-runners",
          "feat/lib-non-empty-array",
        ];
        for (const expected of walk) {
          const frame = stripAnsi(latestFrame(stdout));
          const { stackMap, detailHeader } = regions(frame);
          expect(detailHeader).toContain(expected);
          expect(stackMap).toContain(expected);
          stdin.send("\x1b[B"); // down-arrow
          await new Promise((r) => setTimeout(r, 60));
        }
      } finally {
        instance.unmount();
      }
    });
  },
});

Deno.test({
  name:
    "App narrow nav: cursor branch name is fully visible at every depth in a deep stack at 50x44",
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  async fn() {
    await withNarrowTestRepo(async (repo, mockDir) => {
      // Deep linear chain: the deepest branch's row is wider than 50 cols
      // once every level adds 3 characters of ladder prefix. That exercises
      // the horizontal scroll and is the exact shape the user reported.
      await buildLinearStack(repo, mockDir, 20);
      await runGitCommand(repo.dir, "checkout", "feat/br-19");

      const stdout = new SizedStdout(50, 44);
      const stdin = new TestStdin();
      const instance = render(<App dir={repo.dir} />, {
        stdout: stdout as never,
        stdin: stdin as never,
        exitOnCtrlC: false,
      });
      try {
        await new Promise((r) => setTimeout(r, 500));
        for (let step = 0; step < 20; step++) {
          const frame = stripAnsi(latestFrame(stdout));
          const { stackMap, detailHeader } = regions(frame);
          const expected = `feat/br-${String(19 - step).padStart(2, "0")}`;
          // Ground truth: the detail pane shows which branch is selected.
          expect(detailHeader).toContain(expected);
          // The user-visible invariant: the full branch name must be
          // present in the stack-map region, not clipped by horizontal
          // scroll. A substring check catches "feat/br-1" missing the
          // trailing "9" when scrollX is off-by-3.
          expect(stackMap).toContain(expected);
          stdin.send("\x1b[A");
          await new Promise((r) => setTimeout(r, 60));
        }
      } finally {
        instance.unmount();
      }
    });
  },
});

Deno.test({
  name: "App narrow nav: cursor stays visible after a shrink-to-small resize",
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  async fn() {
    await withNarrowTestRepo(async (repo, mockDir) => {
      await buildLinearStack(repo, mockDir, 8);
      await runGitCommand(repo.dir, "checkout", "feat/br-07");

      const stdout = new SizedStdout(60, 30);
      const stdin = new TestStdin();
      const instance = render(<App dir={repo.dir} />, {
        stdout: stdout as never,
        stdin: stdin as never,
        exitOnCtrlC: false,
      });
      try {
        await new Promise((r) => setTimeout(r, 400));
        {
          const { stackMap, detailHeader } = regions(
            stripAnsi(latestFrame(stdout)),
          );
          expect(detailHeader).toContain("feat/br-07");
          expect(stackMap).toContain("feat/br-07");
        }

        stdout.cols = 50;
        stdout.rowsN = 18;
        stdout.emit("resize");
        await new Promise((r) => setTimeout(r, 100));

        const { stackMap, detailHeader } = regions(
          stripAnsi(latestFrame(stdout)),
        );
        expect(detailHeader).toContain("feat/br-07");
        expect(stackMap).toContain("feat/br-07");
      } finally {
        instance.unmount();
      }
    });
  },
});
