import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fixtureKey,
  gh,
  selectBestPr,
  setMockDir,
  writeFixture,
} from "./gh.ts";

describe("fixtureKey", () => {
  test("normalizes slashes in branch names", () => {
    const key = fixtureKey([
      "pr",
      "list",
      "--head",
      "feat/auth-tests",
      "--json",
      "number,url",
    ]);
    expect(key).toBe("pr-list--head-feat-auth-tests");
  });

  test("handles api commands with repo paths", () => {
    const key = fixtureKey(["api", "repos/owner/repo/issues/101/comments"]);
    expect(key).toBe("api-repos-owner-repo-issues-101-comments");
  });

  test("strips --state and its value so fixtures match regardless", () => {
    const withState = fixtureKey([
      "pr",
      "list",
      "--head",
      "feat/x",
      "--state",
      "all",
      "--json",
      "number",
    ]);
    const without = fixtureKey(["pr", "list", "--head", "feat/x"]);
    expect(withState).toBe(without);
  });
});

describe("selectBestPr", () => {
  test("returns null for empty list", () => {
    expect(selectBestPr([])).toBeNull();
  });

  test("prefers OPEN over MERGED over CLOSED", () => {
    const prs = [
      { number: 1, state: "CLOSED", createdAt: "2026-04-01T00:00:00Z" },
      { number: 2, state: "MERGED", createdAt: "2026-03-01T00:00:00Z" },
      { number: 3, state: "OPEN", createdAt: "2026-01-01T00:00:00Z" },
    ];
    expect(selectBestPr(prs)?.number).toBe(3);
  });

  test("picks newest MERGED when no OPEN exists", () => {
    const prs = [
      { number: 1, state: "MERGED", createdAt: "2026-01-01T00:00:00Z" },
      { number: 2, state: "MERGED", createdAt: "2026-04-01T00:00:00Z" },
      { number: 3, state: "CLOSED", createdAt: "2026-05-01T00:00:00Z" },
    ];
    expect(selectBestPr(prs)?.number).toBe(2);
  });

  test("surfaces lone MERGED PR", () => {
    const prs = [
      { number: 117, state: "MERGED", createdAt: "2026-04-07T00:00:00Z" },
    ];
    expect(selectBestPr(prs)?.number).toBe(117);
  });
});

describe("gh mock mode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir();
    setMockDir(tmpDir);
  });

  afterEach(async () => {
    setMockDir(undefined);
    await Deno.remove(tmpDir, { recursive: true });
  });

  test("reads fixture file for pr-list command", async () => {
    const fixture = [{
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    }];
    await writeFixture(tmpDir, [
      "pr",
      "list",
      "--head",
      "feature/auth",
      "--json",
      "number,url",
    ], fixture);

    const result = await gh(
      "pr",
      "list",
      "--head",
      "feature/auth",
      "--json",
      "number,url",
    );
    expect(JSON.parse(result)).toEqual(fixture);
  });

  test("returns empty array for missing fixture", async () => {
    const result = await gh(
      "pr",
      "list",
      "--head",
      "no-such-branch",
      "--json",
      "number,url",
    );
    expect(result).toBe("[]");
  });

  test("reads fixture for api commands", async () => {
    const fixture = [{ id: 1, body: "test comment" }];
    await writeFixture(
      tmpDir,
      ["api", "repos/owner/repo/issues/101/comments"],
      fixture,
    );

    const result = await gh("api", "repos/owner/repo/issues/101/comments");
    expect(JSON.parse(result)).toEqual(fixture);
  });
});

describe("gh with AbortSignal", () => {
  test("throws AbortError when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    let threw = false;
    try {
      await gh({ signal: controller.signal }, "repo", "view");
    } catch (err) {
      threw = true;
      expect((err as Error).name).toBe("AbortError");
    }
    expect(threw).toBe(true);
  });
});
