import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  createTestRepo,
  runGit,
} from "./testdata/helpers.ts";
import { migrateLegacyConfig, needsMigration } from "./migration.ts";

async function setConfig(dir: string, key: string, value: string) {
  await runGit(dir, "config", key, value);
}

async function getConfig(dir: string, key: string): Promise<string | undefined> {
  try {
    const v = await runGit(dir, "config", "--get", key);
    return v;
  } catch {
    return undefined;
  }
}

async function listMatching(dir: string, pattern: string): Promise<string[]> {
  try {
    const out = await runGit(dir, "config", "--name-only", "--get-regexp", pattern);
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("needsMigration", () => {
  test("returns false on a fresh repo", async () => {
    await using repo = await createTestRepo();
    expect(await needsMigration(repo.dir)).toBe(false);
  });

  test("returns true when any legacy key exists", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setConfig(repo.dir, "branch.feat/a.stack-name", "feat/a");
    expect(await needsMigration(repo.dir)).toBe(true);
  });

  test("returns true when stack.* keys exist without any branch.stack-name", async () => {
    await using repo = await createTestRepo();
    await setConfig(repo.dir, "stack.orphan.base-branch", "main");
    expect(await needsMigration(repo.dir)).toBe(true);
  });
});

describe("migrateLegacyConfig: single stack happy path", () => {
  test("converts one stack with three branches", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/b");

    await setConfig(repo.dir, "branch.feat/a.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/a.stack-parent", "main");
    await setConfig(repo.dir, "branch.feat/b.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/b.stack-parent", "feat/a");
    await setConfig(repo.dir, "branch.feat/c.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/c.stack-parent", "feat/b");
    await setConfig(repo.dir, "stack.feat/a.base-branch", "main");
    await setConfig(repo.dir, "stack.feat/a.merge-strategy", "merge");

    const result = await migrateLegacyConfig(repo.dir);
    expect(result).toEqual({ branches: 3, stacks: 1 });

    expect(await getConfig(repo.dir, "branch.feat/a.base-branch")).toBe("main");
    expect(await getConfig(repo.dir, "branch.feat/a.merge-strategy")).toBe("merge");
    expect(await getConfig(repo.dir, "branch.feat/b.base-branch")).toBe("main");
    expect(await getConfig(repo.dir, "branch.feat/b.merge-strategy")).toBe("merge");
    expect(await getConfig(repo.dir, "branch.feat/c.base-branch")).toBe("main");
    expect(await getConfig(repo.dir, "branch.feat/c.merge-strategy")).toBe("merge");

    // Old keys all gone
    expect(await getConfig(repo.dir, "branch.feat/a.stack-name")).toBeUndefined();
    expect(await listMatching(repo.dir, "^stack\\.")).toEqual([]);
  });
});

describe("migrateLegacyConfig: multi-stack with distinct bases", () => {
  test("each branch gets its stack's base + strategy", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "bugfix/x", "main");
    await setConfig(repo.dir, "branch.feat/a.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/a.stack-parent", "main");
    await setConfig(repo.dir, "branch.bugfix/x.stack-name", "bugfix/x");
    await setConfig(repo.dir, "branch.bugfix/x.stack-parent", "main");
    await setConfig(repo.dir, "stack.feat/a.base-branch", "main");
    await setConfig(repo.dir, "stack.feat/a.merge-strategy", "merge");
    await setConfig(repo.dir, "stack.bugfix/x.base-branch", "develop");
    await setConfig(repo.dir, "stack.bugfix/x.merge-strategy", "squash");

    await migrateLegacyConfig(repo.dir);

    expect(await getConfig(repo.dir, "branch.feat/a.base-branch")).toBe("main");
    expect(await getConfig(repo.dir, "branch.feat/a.merge-strategy")).toBe("merge");
    expect(await getConfig(repo.dir, "branch.bugfix/x.base-branch")).toBe("develop");
    expect(await getConfig(repo.dir, "branch.bugfix/x.merge-strategy")).toBe("squash");
  });
});

describe("migrateLegacyConfig: resume-state", () => {
  test("moves single in-flight resume-state to repo-level", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setConfig(repo.dir, "branch.feat/a.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/a.stack-parent", "main");
    await setConfig(repo.dir, "stack.feat/a.base-branch", "main");
    const stateJson = '{"completed":[],"opts":{}}';
    await setConfig(repo.dir, "stack.feat/a.resume-state", stateJson);

    await migrateLegacyConfig(repo.dir);

    expect(await getConfig(repo.dir, "stacked-prs.resume-state")).toBe(stateJson);
  });

  test("refuses when more than one stack has resume-state", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "main");
    await setConfig(repo.dir, "branch.feat/a.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/a.stack-parent", "main");
    await setConfig(repo.dir, "stack.feat/a.base-branch", "main");
    await setConfig(repo.dir, "stack.feat/a.resume-state", "{}");
    await setConfig(repo.dir, "branch.feat/b.stack-name", "feat/b");
    await setConfig(repo.dir, "branch.feat/b.stack-parent", "main");
    await setConfig(repo.dir, "stack.feat/b.base-branch", "main");
    await setConfig(repo.dir, "stack.feat/b.resume-state", "{}");

    await expect(migrateLegacyConfig(repo.dir)).rejects.toThrow(
      /multiple stacks have an in-progress resume-state/i,
    );
  });
});

describe("migrateLegacyConfig: default-merge-strategy", () => {
  test("renames stack.default-merge-strategy to stacked-prs.default-merge-strategy", async () => {
    await using repo = await createTestRepo();
    await setConfig(repo.dir, "stack.default-merge-strategy", "merge");
    await migrateLegacyConfig(repo.dir);
    expect(await getConfig(repo.dir, "stacked-prs.default-merge-strategy")).toBe("merge");
    expect(await getConfig(repo.dir, "stack.default-merge-strategy")).toBeUndefined();
  });
});

describe("migrateLegacyConfig: orphans and tombstones", () => {
  test("branch with stack-name pointing at a missing stack is left untracked", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setConfig(repo.dir, "branch.feat/a.stack-name", "ghost");
    await setConfig(repo.dir, "branch.feat/a.stack-parent", "main");
    await migrateLegacyConfig(repo.dir);
    expect(await getConfig(repo.dir, "branch.feat/a.stack-name")).toBeUndefined();
    expect(await getConfig(repo.dir, "branch.feat/a.stack-parent")).toBe("main");
    expect(await getConfig(repo.dir, "branch.feat/a.base-branch")).toBeUndefined();
  });

  test("orphan stack.* keys (no branch references them) are deleted", async () => {
    await using repo = await createTestRepo();
    await setConfig(repo.dir, "stack.orphan.base-branch", "main");
    await setConfig(repo.dir, "stack.orphan.merge-strategy", "merge");
    await migrateLegacyConfig(repo.dir);
    expect(await listMatching(repo.dir, "^stack\\.")).toEqual([]);
  });

  test("landed-* multi-values are dropped silently", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setConfig(repo.dir, "branch.feat/a.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/a.stack-parent", "main");
    await setConfig(repo.dir, "stack.feat/a.base-branch", "main");
    await runGit(repo.dir, "config", "--add", "stack.feat/a.landed-branches", "old-feat");
    await runGit(repo.dir, "config", "--add", "stack.feat/a.landed-pr", "old-feat:42");
    await migrateLegacyConfig(repo.dir);
    expect(await listMatching(repo.dir, "^stack\\.")).toEqual([]);
  });
});

describe("migrateLegacyConfig: idempotency", () => {
  test("re-running on already-migrated repo is a no-op", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setConfig(repo.dir, "branch.feat/a.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/a.stack-parent", "main");
    await setConfig(repo.dir, "stack.feat/a.base-branch", "main");
    await migrateLegacyConfig(repo.dir);
    // Second run: needsMigration is false, returns null
    expect(await needsMigration(repo.dir)).toBe(false);
  });
});

describe("migration auto-runs on getStackTree read", () => {
  test("a legacy repo becomes a v3 repo after the first getStackTree call", async () => {
    const { getStackTree } = await import("./stack.ts");
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setConfig(repo.dir, "branch.feat/a.stack-name", "feat/a");
    await setConfig(repo.dir, "branch.feat/a.stack-parent", "main");
    await setConfig(repo.dir, "stack.feat/a.base-branch", "main");
    await setConfig(repo.dir, "stack.feat/a.merge-strategy", "squash");

    const tree = await getStackTree(repo.dir, "feat/a");
    expect(tree.roots[0].branch).toBe("feat/a");

    // After read, new keys exist and old ones are gone
    expect(await getConfig(repo.dir, "branch.feat/a.base-branch")).toBe("main");
    expect(await listMatching(repo.dir, "^stack\\.")).toEqual([]);
  });
});
