import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  createTestRepo,
  makeMockDir,
  runGit,
} from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import {
  checkoutBranch,
  moveCheckoutSelection,
  parseCheckoutKeypress,
  renderCheckoutDisplay,
  visibleCheckoutBranches,
} from "./checkout.ts";
import { getAllStackStatuses } from "./status.ts";

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
    expect(parseCheckoutKeypress(new Uint8Array([0x78]))).toBe("other");
  });
});

describe("moveCheckoutSelection", () => {
  test("moves within bounds without wrapping", () => {
    expect(moveCheckoutSelection(0, -1, 3)).toBe(0);
    expect(moveCheckoutSelection(0, 1, 3)).toBe(1);
    expect(moveCheckoutSelection(2, 1, 3)).toBe(2);
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
      "> ◯      feature/a  up-to-date",
      "  ◉      main",
    ].join("\n"));
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
