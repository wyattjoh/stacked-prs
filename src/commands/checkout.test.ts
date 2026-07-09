import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as colors from "@std/fmt/colors";
import {
  addBranch,
  createTestRepo,
  makeMockDir,
  runGit,
} from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import {
  CHECKOUT_FOOTER,
  checkoutBranch,
  filterCheckoutBranches,
  fuzzyCheckoutMatch,
  moveCheckoutSelection,
  moveCheckoutSelectionForKey,
  parseCheckoutKeypress,
  renderCheckoutDisplay,
  renderCheckoutFrame,
  renderCheckoutFrameUpdate,
  visibleCheckoutBranches,
} from "./checkout.ts";
import { type AllStacksStatus, getAllStackStatuses } from "./status.ts";

function selectedRow(line: string): string {
  return colors.white(`> ${line}`);
}

describe("parseCheckoutKeypress", () => {
  test("recognizes arrow, enter, escape, and ctrl-c keys", () => {
    expect(parseCheckoutKeypress(new Uint8Array([0x1b, 0x5b, 0x41]))).toBe(
      "up",
    );
    expect(parseCheckoutKeypress(new Uint8Array([0x1b, 0x5b, 0x42]))).toBe(
      "down",
    );
    expect(parseCheckoutKeypress(new Uint8Array([0x0d]))).toBe("enter");
    expect(parseCheckoutKeypress(new Uint8Array([0x0a]))).toBe("enter");
    expect(parseCheckoutKeypress(new Uint8Array([0x1b]))).toBe("abort");
    expect(parseCheckoutKeypress(new Uint8Array([0x03]))).toBe("abort");
    expect(parseCheckoutKeypress(new Uint8Array([0x78]))).toEqual({
      type: "input",
      value: "x",
    });
  });

  test("recognizes printable search input and search editing keys", () => {
    expect(parseCheckoutKeypress(new TextEncoder().encode("q"))).toEqual({
      type: "input",
      value: "q",
    });
    expect(parseCheckoutKeypress(new TextEncoder().encode(" "))).toEqual({
      type: "input",
      value: " ",
    });
    expect(parseCheckoutKeypress(new TextEncoder().encode("ø"))).toEqual({
      type: "input",
      value: "ø",
    });
    expect(parseCheckoutKeypress(new Uint8Array([0x7f]))).toBe("backspace");
    expect(parseCheckoutKeypress(new Uint8Array([0x08]))).toBe("backspace");
    expect(parseCheckoutKeypress(new Uint8Array([0x15]))).toBe(
      "clear-search",
    );
  });

  test("recognizes page, home, and end keys", () => {
    expect(parseCheckoutKeypress(new TextEncoder().encode("\x1b[5~"))).toBe(
      "page-up",
    );
    expect(parseCheckoutKeypress(new TextEncoder().encode("\x1b[6~"))).toBe(
      "page-down",
    );
    expect(parseCheckoutKeypress(new TextEncoder().encode("\x1b[H"))).toBe(
      "home",
    );
    expect(parseCheckoutKeypress(new TextEncoder().encode("\x1bOH"))).toBe(
      "home",
    );
    expect(parseCheckoutKeypress(new TextEncoder().encode("\x1b[1~"))).toBe(
      "home",
    );
    expect(parseCheckoutKeypress(new TextEncoder().encode("\x1b[F"))).toBe(
      "end",
    );
    expect(parseCheckoutKeypress(new TextEncoder().encode("\x1bOF"))).toBe(
      "end",
    );
    expect(parseCheckoutKeypress(new TextEncoder().encode("\x1b[4~"))).toBe(
      "end",
    );
  });
});

describe("checkout fuzzy filtering", () => {
  test("matches branch text by case-insensitive ordered characters", () => {
    expect(fuzzyCheckoutMatch("feature/checkout-filter", "fcf")).toBe(true);
    expect(fuzzyCheckoutMatch("feature/checkout-filter", "CHECK")).toBe(true);
    expect(fuzzyCheckoutMatch("feature/checkout-filter", "zz")).toBe(false);
  });

  test("filters branches in display order by branch name", () => {
    const branches = [
      "feature/api",
      "feature/docs",
      "bugfix/payment",
      "main",
    ];

    expect(filterCheckoutBranches(branches, "fd")).toEqual([
      "feature/docs",
    ]);
    expect(filterCheckoutBranches(branches, "bp")).toEqual([
      "bugfix/payment",
    ]);
    expect(filterCheckoutBranches(branches, "ma")).toEqual(["main"]);
    expect(filterCheckoutBranches(branches, "draft")).toEqual([]);
    expect(filterCheckoutBranches(branches, "")).toEqual(branches);
  });
});

describe("moveCheckoutSelection", () => {
  test("moves within bounds without wrapping", () => {
    expect(moveCheckoutSelection(0, -1, 3)).toBe(0);
    expect(moveCheckoutSelection(0, 1, 3)).toBe(1);
    expect(moveCheckoutSelection(2, 1, 3)).toBe(2);
  });

  test("jumps by stack and list edges", () => {
    const branch = (
      name: string,
      parent: string,
      isCurrent = false,
    ) => ({
      branch: name,
      parent,
      depth: 0,
      isLastChild: true,
      childCount: 0,
      pr: null,
      syncStatus: "up-to-date" as const,
      isCurrent,
    });
    const status: AllStacksStatus = {
      stacks: [
        {
          stackName: "stack-a",
          baseBranch: "main",
          mergeStrategy: undefined,
          archived: false,
          display: "",
          branches: [
            branch("a/leaf", "a/root"),
            branch("a/root", "main"),
          ],
        },
        {
          stackName: "stack-b",
          baseBranch: "main",
          mergeStrategy: undefined,
          archived: false,
          display: "",
          branches: [
            branch("b/leaf", "b/root"),
            branch("b/root", "main"),
          ],
        },
      ],
      display: [
        "◯      a/leaf  up-to-date",
        "◯      a/root  up-to-date",
        "◯      b/leaf  up-to-date",
        "◯      b/root  up-to-date",
        "◉      main",
      ].join("\n"),
    };
    const branches = ["a/leaf", "a/root", "b/leaf", "b/root", "main"];

    expect(moveCheckoutSelectionForKey(status, branches, 1, "page-down"))
      .toBe(2);
    expect(moveCheckoutSelectionForKey(status, branches, 3, "page-up")).toBe(
      0,
    );
    expect(moveCheckoutSelectionForKey(status, branches, 4, "page-up")).toBe(
      2,
    );
    expect(moveCheckoutSelectionForKey(status, branches, 3, "page-down"))
      .toBe(3);
    expect(moveCheckoutSelectionForKey(status, branches, 2, "home")).toBe(0);
    expect(moveCheckoutSelectionForKey(status, branches, 2, "end")).toBe(4);
  });
});

describe("visibleCheckoutBranches", () => {
  test("returns visible stack branches in status display order", async () => {
    await using repo = await createTestRepo();
    await using _mock = await makeMockDir();
    await addBranch(repo.dir, "feature/a", "main");
    await addBranch(repo.dir, "feature/b", "feature/a");
    await addBranch(repo.dir, "feature/c", "feature/a");
    await setStackNode(repo.dir, "feature/a", "my-stack", "main");
    await setStackNode(repo.dir, "feature/b", "my-stack", "feature/a");
    await setStackNode(repo.dir, "feature/c", "my-stack", "feature/a");
    await setBaseBranch(repo.dir, "my-stack", "main");

    const status = await getAllStackStatuses(repo.dir);

    expect(visibleCheckoutBranches(status, { showArchived: false })).toEqual([
      "feature/b",
      "feature/c",
      "feature/a",
      "main",
    ]);
  });
});

describe("renderCheckoutDisplay", () => {
  test("marks only the selected branch row", () => {
    const display = [
      "◯      feature/b  up-to-date",
      "◯      feature/a  up-to-date",
      "◉      main",
    ].join("\n");

    expect(
      renderCheckoutDisplay(display, ["feature/b", "feature/a"], "feature/a"),
    ).toBe([
      "  ◯      feature/b  up-to-date",
      selectedRow("◯      feature/a  up-to-date"),
      "  ◉      main",
    ].join("\n"));
  });

  test("marks the selected base branch row", () => {
    const display = [
      "◯      feature/b  up-to-date",
      "◯      feature/a  up-to-date",
      "◉      main",
    ].join("\n");

    expect(
      renderCheckoutDisplay(
        display,
        ["feature/b", "feature/a", "main"],
        "main",
      ),
    ).toBe([
      "  ◯      feature/b  up-to-date",
      "  ◯      feature/a  up-to-date",
      selectedRow("◉      main"),
    ].join("\n"));
  });

  test("overrides existing status colors on the selected row", () => {
    const display = [
      "\x1b[36m◯      feature/a\x1b[39m  \x1b[33mbehind-parent\x1b[39m",
      "◉      main",
    ].join("\n");

    expect(
      renderCheckoutDisplay(display, ["feature/a", "main"], "feature/a"),
    ).toBe([
      selectedRow("◯      feature/a  behind-parent"),
      "  ◉      main",
    ].join("\n"));
  });
});

describe("inline checkout frame rendering", () => {
  const display = [
    "◯      feature/b  up-to-date",
    "◯      feature/a  up-to-date",
    "◉      main",
  ].join("\n");
  const branches = ["feature/b", "feature/a"];

  test("renders the initial picker without alternate-screen sequences", () => {
    const frame = renderCheckoutFrame(display, branches, "feature/b");

    expect(frame).toEqual({
      text: [
        selectedRow("◯      feature/b  up-to-date"),
        "  ◯      feature/a  up-to-date",
        "  ◉      main",
        "",
        "Search:",
        CHECKOUT_FOOTER,
        "",
      ].join("\n"),
      lineCount: 6,
    });
    expect(frame.text).not.toContain("\x1b[?1049h");
    expect(frame.text).not.toContain("\x1b[?1049l");
    expect(frame.text).not.toContain("\x1b[2J");
  });

  test("redraws by moving to the top of the previous inline frame", () => {
    const frame = renderCheckoutFrameUpdate(6, display, branches, "feature/a");

    expect(frame).toEqual({
      text: [
        "\x1b[6A\x1b[J  ◯      feature/b  up-to-date",
        selectedRow("◯      feature/a  up-to-date"),
        "  ◉      main",
        "",
        "Search:",
        CHECKOUT_FOOTER,
        "",
      ].join("\n"),
      lineCount: 6,
    });
    expect(frame.text).not.toContain("\x1b[?1049h");
    expect(frame.text).not.toContain("\x1b[?1049l");
    expect(frame.text).not.toContain("\x1b[2J");
  });

  test("counts wrapped physical rows for narrow-terminal redraws", () => {
    const narrowOptions = {
      viewportRows: 24,
      viewportColumns: 20,
    };
    const initial = renderCheckoutFrame(
      display,
      branches,
      "feature/b",
      narrowOptions,
    );
    const update = renderCheckoutFrameUpdate(
      initial.lineCount,
      display,
      branches,
      "feature/a",
      narrowOptions,
    );

    expect(initial.lineCount).toBe(10);
    expect(update.text.startsWith("\x1b[10A\x1b[J")).toBe(true);
    expect(update.lineCount).toBe(10);
  });

  test("limits tall picker frames to the terminal viewport around the selected branch", () => {
    const tallDisplay = [
      "◯      feature/01  up-to-date",
      "◯      feature/02  up-to-date",
      "◯      feature/03  up-to-date",
      "◯      feature/04  up-to-date",
      "◯      feature/05  up-to-date",
      "◯      feature/06  up-to-date",
      "◯      feature/07  up-to-date",
      "◯      feature/08  up-to-date",
      "◉      main",
    ].join("\n");
    const tallBranches = [
      "feature/01",
      "feature/02",
      "feature/03",
      "feature/04",
      "feature/05",
      "feature/06",
      "feature/07",
      "feature/08",
      "main",
    ];

    const frame = renderCheckoutFrame(
      tallDisplay,
      tallBranches,
      "feature/06",
      { viewportRows: 7, viewportColumns: undefined },
    );

    expect(frame).toEqual({
      text: [
        "  ◯      feature/05  up-to-date",
        selectedRow("◯      feature/06  up-to-date"),
        "  ◯      feature/07  up-to-date",
        "",
        "Search:",
        CHECKOUT_FOOTER,
        "",
      ].join("\n"),
      lineCount: 6,
    });
  });

  test("redraws tall picker updates within the current viewport", () => {
    const tallDisplay = [
      "◯      feature/01  up-to-date",
      "◯      feature/02  up-to-date",
      "◯      feature/03  up-to-date",
      "◯      feature/04  up-to-date",
      "◯      feature/05  up-to-date",
      "◉      main",
    ].join("\n");
    const tallBranches = [
      "feature/01",
      "feature/02",
      "feature/03",
      "feature/04",
      "feature/05",
      "main",
    ];

    const frame = renderCheckoutFrameUpdate(
      6,
      tallDisplay,
      tallBranches,
      "main",
      { viewportRows: 6, viewportColumns: undefined },
    );

    expect(frame).toEqual({
      text: [
        "\x1b[6A\x1b[J  ◯      feature/05  up-to-date",
        selectedRow("◉      main"),
        "",
        "Search:",
        CHECKOUT_FOOTER,
        "",
      ].join("\n"),
      lineCount: 5,
    });
  });

  test("renders filtered matches with search counts", () => {
    const frame = renderCheckoutFrame(
      display,
      ["feature/a"],
      "feature/a",
      {
        viewportRows: 10,
        viewportColumns: undefined,
        query: "fa",
        matchCount: 1,
        totalCount: 3,
      },
    );

    expect(frame).toEqual({
      text: [
        selectedRow("◯      feature/a  up-to-date"),
        "",
        "Search: fa  1/3",
        CHECKOUT_FOOTER,
        "",
      ].join("\n"),
      lineCount: 4,
    });
  });

  test("renders an empty filtered state", () => {
    const frame = renderCheckoutFrame(display, [], undefined, {
      viewportRows: 10,
      viewportColumns: undefined,
      query: "zzz",
      matchCount: 0,
      totalCount: 3,
    });

    expect(frame).toEqual({
      text: [
        colors.dim("No matches"),
        "",
        "Search: zzz  0/3",
        CHECKOUT_FOOTER,
        "",
      ].join("\n"),
      lineCount: 4,
    });
  });
});

describe("checkoutBranch", () => {
  test("checks out the selected branch", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feature/a", "main");

    const result = await checkoutBranch(repo.dir, "feature/a");
    const current = await runGit(repo.dir, "branch", "--show-current");

    expect(result.ok).toBe(true);
    expect(current).toBe("feature/a");
  });
});
