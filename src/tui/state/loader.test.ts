import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo } from "../../lib/testdata/helpers.ts";
import type { TestRepo } from "../../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../../lib/stack.ts";
import { setMockDir, writeFixture } from "../../lib/gh.ts";
import { loadLocal, loadPrsProgressive } from "./loader.ts";

describe("loadLocal", () => {
  let repo: TestRepo;
  let mockDir: string;

  beforeEach(async () => {
    repo = await createTestRepo();
    mockDir = await Deno.makeTempDir();
    setMockDir(mockDir);
  });

  afterEach(async () => {
    setMockDir(undefined);
    await repo.cleanup();
    await Deno.remove(mockDir, { recursive: true });
  });

  test("returns trees and sync map for configured stacks", async () => {
    await addBranch(repo.dir, "feat/a", "main");
    await setStackNode(repo.dir, "feat/a", "alpha", "main");
    await setBaseBranch(repo.dir, "alpha", "main");

    const result = await loadLocal(repo.dir);
    expect(result.trees).toHaveLength(1);
    expect(result.trees[0].stackName).toBe("alpha");
    expect(result.syncByBranch.get("feat/a")).toBeDefined();
    expect(result.allBranches).toContain("feat/a");
  });
});

describe("loadPrsProgressive", () => {
  let repo: TestRepo;
  let mockDir: string;

  beforeEach(async () => {
    repo = await createTestRepo();
    mockDir = await Deno.makeTempDir();
    setMockDir(mockDir);
  });

  afterEach(async () => {
    setMockDir(undefined);
    await repo.cleanup();
    await Deno.remove(mockDir, { recursive: true });
  });

  test("invokes onLoaded for each branch", async () => {
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/a"],
      [{ number: 1, url: "u", state: "OPEN", isDraft: false }],
    );
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/b"],
      [],
    );

    const loaded: Array<{ branch: string; pr: unknown }> = [];
    await loadPrsProgressive({
      branches: ["feat/a", "feat/b"],
      concurrency: 2,
      onLoaded: (branch, pr) => loaded.push({ branch, pr }),
      onError: () => {},
    });

    expect(loaded).toHaveLength(2);
    const byBranch = new Map(loaded.map((l) => [l.branch, l.pr]));
    expect(byBranch.get("feat/a")).toMatchObject({ number: 1 });
    expect(byBranch.get("feat/b")).toBe(null);
  });

  test("aborts cleanly when signal triggers", async () => {
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/a"],
      [],
    );

    const controller = new AbortController();
    controller.abort();

    const loaded: string[] = [];
    await loadPrsProgressive({
      branches: ["feat/a"],
      concurrency: 1,
      signal: controller.signal,
      onLoaded: (b) => loaded.push(b),
      onError: () => {},
    });

    expect(loaded).toHaveLength(0);
  });
});
