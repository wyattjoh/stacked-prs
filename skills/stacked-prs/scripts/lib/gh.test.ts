import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fixtureKey, gh, setMockDir, writeFixture } from "./gh.ts";

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
