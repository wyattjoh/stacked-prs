# Drop Stack-Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `stackName` concept from the data model and CLI surface. Stacks become topology-only (set of branches reachable from a root via `branch.<n>.stack-parent`), stack-level metadata is replicated per branch, resume state is a single repo-level slot, color derives from the root branch name, and tombstones go away. Auto-migrate legacy configs on first run.

**Architecture:** Land changes in three phases. **Phase A** is purely additive: add cascade-lookup helpers, switch color to a deterministic hash of the root branch name, write the migration module, and wire it into `getStackTree` / `getAllStackTrees`. After phase A the legacy schema still works, the new schema is being written, and migration converts old to new on first read.

**Phase B** migrates each command file (init, import, create, restack, land, etc.) to write the new schema and stop reading the old. Within each task, the command, its CLI definition in `cli.ts`, and its tests change together; `StackTree.stackName` stays in the type during phase B so unmigrated commands keep compiling, populated from the root branch name.

**Phase C** renames the `stackName` field to `rootBranch` across all types, deletes the now-unused legacy helpers (tombstone multi-values, `clearStackConfig`, legacy `setStackBranch`), and updates the TUI state shape. **Phase D** updates docs and runs the final integration pass.

**Tech Stack:** Deno 2.x, TypeScript, `@cliffy/command` for CLI, `@std/testing/bdd` + `@std/expect` for tests. Tests use real git repos in temp directories via `src/lib/testdata/helpers.ts`. GitHub CLI calls are mocked via `src/lib/gh.ts`'s `setMockDir` fixture system.

**Spec:** `docs/superpowers/specs/2026-05-21-drop-stack-name-design.md`

---

## Conventions used in every task

- **Run a single test file:** `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/<path>/<file>.test.ts`
- **Run the full suite:** `deno task test`
- **Run the type/lint/fmt gate:** `deno task check`
- **Commit format:** Conventional Commits per `CLAUDE.md`. Use `feat:` / `fix:` for any file under `skills/**`, `docs:` for in-repo dev docs, `refactor:` for internal restructures with no user-visible change yet.
- **Em dashes:** None. Use commas, parentheses, or separate sentences. (User-level rule in `~/.claude/CLAUDE.md`.)
- **After every code change:** the harness formatter hook runs `deno fmt`. If a commit fails because of a hook, fix the underlying issue and create a new commit.
- **Do not run `deno task install` between tasks unless the user is testing as their daily driver.** It's safe to defer until phase D.

---

## Phase A: Foundation (additive)

### Task 1: Add per-branch config helpers in `src/lib/stack.ts`

Adds writers and readers for `branch.<n>.base-branch` and `branch.<n>.merge-strategy`. Does not yet remove the `stack.<sn>.*` equivalents. Existing helpers (`getBaseBranch(dir, stackName)`, `getMergeStrategy(dir, stackName)`) stay untouched in this task.

**Files:**
- Modify: `src/lib/stack.ts`
- Test: `src/lib/stack.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/stack.test.ts`:

```ts
describe("per-branch base-branch and merge-strategy helpers", () => {
  test("setBranchBaseBranch + getBranchBaseBranch round-trip", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBranchBaseBranch(repo.dir, "feat/a", "main");
    expect(await getBranchBaseBranch(repo.dir, "feat/a")).toBe("main");
    expect(await getBranchBaseBranch(repo.dir, "feat/b")).toBeUndefined();
  });

  test("setBranchMergeStrategy + getBranchMergeStrategy round-trip", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBranchMergeStrategy(repo.dir, "feat/a", "squash");
    expect(await getBranchMergeStrategy(repo.dir, "feat/a")).toBe("squash");
    await setBranchMergeStrategy(repo.dir, "feat/a", "merge");
    expect(await getBranchMergeStrategy(repo.dir, "feat/a")).toBe("merge");
  });

  test("getBranchMergeStrategy returns undefined for unknown branch", async () => {
    await using repo = await createTestRepo();
    expect(await getBranchMergeStrategy(repo.dir, "nope")).toBeUndefined();
  });
});
```

Make sure the import block at the top of `stack.test.ts` includes the four new symbols:

```ts
import {
  // ...existing imports...
  getBranchBaseBranch,
  getBranchMergeStrategy,
  setBranchBaseBranch,
  setBranchMergeStrategy,
} from "./stack.ts";
```

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts
```

Expected: type error / "not exported" for the four new symbols.

- [ ] **Step 3: Implement the helpers**

In `src/lib/stack.ts`, near `getMergeStrategy` / `setMergeStrategy` (around line 309), add:

```ts
/** Read this branch's own base-branch config, ignoring ancestors. */
export async function getBranchBaseBranch(
  dir: string,
  branch: string,
): Promise<string | undefined> {
  return await gitConfig(dir, `branch.${branch}.base-branch`);
}

/** Write `branch.<branch>.base-branch`. */
export async function setBranchBaseBranch(
  dir: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  await gitConfigSet(dir, `branch.${branch}.base-branch`, baseBranch);
}

/** Read this branch's own merge-strategy config, ignoring ancestors. */
export async function getBranchMergeStrategy(
  dir: string,
  branch: string,
): Promise<MergeStrategy | undefined> {
  const value = await gitConfig(dir, `branch.${branch}.merge-strategy`);
  if (value === "merge" || value === "squash") return value;
  return undefined;
}

/** Write `branch.<branch>.merge-strategy`. */
export async function setBranchMergeStrategy(
  dir: string,
  branch: string,
  strategy: MergeStrategy,
): Promise<void> {
  await gitConfigSet(dir, `branch.${branch}.merge-strategy`, strategy);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```
git add src/lib/stack.ts src/lib/stack.test.ts
git commit -m "refactor(stack): add per-branch base-branch and merge-strategy helpers"
```

---

### Task 2: Add cascade-lookup helpers + repo-level merge-strategy default

`getEffectiveBaseBranch(branch)` and `getEffectiveMergeStrategy(branch)` walk parent pointers from `branch` upward, returning the first ancestor with a value, falling back to repo-level defaults. Also adds the repo-level `stacked-prs.default-merge-strategy` (under a new namespace) that replaces `stack.default-merge-strategy` going forward. The legacy key is still read by `getDefaultMergeStrategy` for now (removed in Task 5 once migration writes both).

**Files:**
- Modify: `src/lib/stack.ts`
- Test: `src/lib/stack.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/stack.test.ts`:

```ts
describe("cascade lookup helpers", () => {
  test("getEffectiveBaseBranch returns the branch's own value when set", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBranchBaseBranch(repo.dir, "feat/a", "main");
    await gitConfigSet(repo.dir, "branch.feat/a.stack-parent", "main");
    expect(await getEffectiveBaseBranch(repo.dir, "feat/a")).toBe("main");
  });

  test("getEffectiveBaseBranch walks parent chain when missing", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await gitConfigSet(repo.dir, "branch.feat/a.stack-parent", "main");
    await gitConfigSet(repo.dir, "branch.feat/b.stack-parent", "feat/a");
    await setBranchBaseBranch(repo.dir, "feat/a", "main");
    // feat/b has no own base-branch, must inherit from feat/a
    expect(await getEffectiveBaseBranch(repo.dir, "feat/b")).toBe("main");
  });

  test("getEffectiveMergeStrategy falls back to repo default when no ancestor sets it", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await gitConfigSet(repo.dir, "branch.feat/a.stack-parent", "main");
    await gitConfigSet(repo.dir, "stacked-prs.default-merge-strategy", "merge");
    expect(await getEffectiveMergeStrategy(repo.dir, "feat/a")).toBe("merge");
  });

  test("getEffectiveMergeStrategy falls back to hardcoded squash when no default set", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await gitConfigSet(repo.dir, "branch.feat/a.stack-parent", "main");
    expect(await getEffectiveMergeStrategy(repo.dir, "feat/a")).toBe("squash");
  });

  test("getEffectiveBaseBranch throws when chain has no base", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await gitConfigSet(repo.dir, "branch.feat/a.stack-parent", "main");
    // no base-branch anywhere
    await expect(getEffectiveBaseBranch(repo.dir, "feat/a")).rejects.toThrow(
      /no base-branch/i,
    );
  });
});
```

Add to the import block:

```ts
import {
  // ...
  getEffectiveBaseBranch,
  getEffectiveMergeStrategy,
} from "./stack.ts";
```

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts
```

- [ ] **Step 3: Implement the cascade helpers**

In `src/lib/stack.ts`, after the helpers from Task 1, add:

```ts
/**
 * Walk parent pointers from `branch` upward, returning the first ancestor
 * with a `branch.<n>.base-branch` value set. Throws if no ancestor has one.
 */
export async function getEffectiveBaseBranch(
  dir: string,
  branch: string,
): Promise<string> {
  let current: string | undefined = branch;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const own = await getBranchBaseBranch(dir, current);
    if (own) return own;
    current = await gitConfig(dir, `branch.${current}.stack-parent`);
  }
  throw new Error(
    `no base-branch found on ${branch} or any of its ancestors`,
  );
}

/**
 * Walk parent pointers from `branch` upward, returning the first ancestor
 * with a `branch.<n>.merge-strategy` value set. Falls back to the repo
 * default (`stacked-prs.default-merge-strategy`) or "squash".
 */
export async function getEffectiveMergeStrategy(
  dir: string,
  branch: string,
): Promise<MergeStrategy> {
  let current: string | undefined = branch;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const own = await getBranchMergeStrategy(dir, current);
    if (own) return own;
    current = await gitConfig(dir, `branch.${current}.stack-parent`);
  }
  const repoDefault = await gitConfig(
    dir,
    "stacked-prs.default-merge-strategy",
  );
  if (repoDefault === "merge" || repoDefault === "squash") return repoDefault;
  return "squash";
}
```

Also export a new repo-default setter (used by migration in Task 5):

```ts
export async function setRepoDefaultMergeStrategy(
  dir: string,
  strategy: MergeStrategy,
): Promise<void> {
  await gitConfigSet(dir, "stacked-prs.default-merge-strategy", strategy);
}
```

Leave `getDefaultMergeStrategy` (which reads `stack.default-merge-strategy`) alone for now. Task 5's migration writes the new key; Task 14 removes the old reader.

- [ ] **Step 4: Run tests to verify they pass**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts
```

- [ ] **Step 5: Commit**

```
git add src/lib/stack.ts src/lib/stack.test.ts
git commit -m "refactor(stack): add cascade lookup helpers and stacked-prs.default-merge-strategy"
```

---

### Task 3: Switch color assignment to derive from root branch name

`assignColors` takes a list of names and a palette and picks colors via FNV-1a hash. Today the input is stack names; after this task it's still strings, but the call sites switch to passing root branch names. The function body does not change behavior, only its inputs (semantically: "color identity is the root branch name, not a stack name"). The `readColorOverrides` function is removed: with no `stack.<name>.color` override surface remaining, every color is hash-derived.

**Files:**
- Modify: `src/lib/colors.ts`
- Modify: `src/cli.ts` (call site)
- Modify: `src/tui/state/loader.ts` (call site)
- Test: `src/lib/colors.test.ts`

- [ ] **Step 1: Update the tests for the new contract**

Replace the contents of `src/lib/colors.test.ts` with:

```ts
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assignColors } from "./colors.ts";

describe("assignColors", () => {
  test("is deterministic for the same root branch name", () => {
    const a = assignColors(["feat/x"], "dark");
    const b = assignColors(["feat/x"], "dark");
    expect(a.get("feat/x")).toBe(b.get("feat/x"));
  });

  test("two different names get different colors when palette is large enough", () => {
    const result = assignColors(["feat/x", "bugfix/y"], "dark");
    expect(result.get("feat/x")).not.toBe(result.get("bugfix/y"));
  });

  test("avoids palette collisions across siblings up to palette size", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const result = assignColors(names, "dark");
    const colors = new Set(result.values());
    expect(colors.size).toBe(names.length);
  });

  test("dark and light themes use different palettes", () => {
    const dark = assignColors(["feat/x"], "dark");
    const light = assignColors(["feat/x"], "light");
    expect(dark.get("feat/x")).not.toBe(light.get("feat/x"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/colors.test.ts
```

Expected: failure because the current `assignColors` signature takes a third `overrides` argument.

- [ ] **Step 3: Update `assignColors` and remove `readColorOverrides`**

In `src/lib/colors.ts`:

1. Change `assignColors` to drop the `overrides` parameter. The body keeps the same FNV-1a-then-collision-avoidance loop. Final shape:

```ts
export function assignColors(
  names: string[],
  theme: ThemeName,
): Map<string, string> {
  const palette = theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const result = new Map<string, string>();
  const used = new Set<string>();

  const sorted = names.slice().sort();
  for (const name of sorted) {
    const start = fnv1a(name) % palette.length;
    let picked: string | undefined;
    for (let i = 0; i < palette.length; i++) {
      const candidate = palette[(start + i) % palette.length];
      if (!used.has(candidate)) {
        picked = candidate;
        break;
      }
    }
    if (picked === undefined) {
      picked = palette[start % palette.length];
    } else {
      used.add(picked);
    }
    result.set(name, picked);
  }

  return result;
}
```

2. Delete the entire `readColorOverrides` function (lines ~93-124).

3. Update the call sites:
   - `src/cli.ts` import at top: remove `readColorOverrides` from the import.
   - `src/cli.ts`: wherever `readColorOverrides` is called, drop the call. Change `assignColors(names, overrides, theme)` to `assignColors(names, theme)`. (One call site, likely inside the `status` command around the `--pr` path. Search with `grep -n readColorOverrides src/cli.ts`.)
   - `src/tui/state/loader.ts`: same treatment. Search with `grep -n readColorOverrides src/tui/state/loader.ts`.

- [ ] **Step 4: Run tests to verify they pass**

```
deno task check
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/colors.test.ts
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/tui/
```

Expected: pass. If a TUI snapshot test depends on a specific color, update its expectation to the new hash-derived value (run the test, read the actual value from the diff, update the expected).

- [ ] **Step 5: Commit**

```
git add src/lib/colors.ts src/lib/colors.test.ts src/cli.ts src/tui/state/loader.ts
git commit -m "refactor(colors): derive stack color from root branch name only"
```

---

### Task 4: Add test helpers for the new schema in `testdata/helpers.ts`

The existing `addBranch(dir, name, parent)` creates a branch but does not write any stack metadata. Tests today layer `setStackBranch` or direct `gitConfigSet` on top. The new schema needs two new helpers used by every later test: `trackBranch` (writes the per-branch trio) and `markBranchMerged` (replaces `addTombstone` for tests that need a "this branch was merged and deleted" state).

`addTombstone` stays in place for now (it's still used by tests of the legacy migration in Task 5).

**Files:**
- Modify: `src/lib/testdata/helpers.ts`
- Test: `src/lib/testdata/helpers.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `src/lib/testdata/helpers.test.ts`:

```ts
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  createTestRepo,
  markBranchMerged,
  runGit,
  trackBranch,
} from "./helpers.ts";

describe("trackBranch", () => {
  test("writes the per-branch trio", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await trackBranch(repo.dir, "feat/a", {
      parent: "main",
      baseBranch: "main",
      mergeStrategy: "squash",
    });
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-parent"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.base-branch"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.merge-strategy"),
    ).toBe("squash");
    // The legacy key must not be written
    const { code } = await runGit(
      repo.dir,
      "config",
      "branch.feat/a.stack-name",
    ).then(() => ({ code: 0 }), () => ({ code: 1 }));
    // Allow either: depending on shell wrapper; assert the key is unset via raw read
  });
});

describe("markBranchMerged", () => {
  test("simulates a PR-merged branch by deleting the ref + config", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await trackBranch(repo.dir, "feat/a", {
      parent: "main",
      baseBranch: "main",
      mergeStrategy: "squash",
    });
    await markBranchMerged(repo.dir, "feat/a");
    // branch ref is gone
    const refs = await runGit(repo.dir, "branch", "--list", "feat/a");
    expect(refs.trim()).toBe("");
    // config is gone with the branch
    const { code } = await Deno.run({
      cmd: ["git", "config", "branch.feat/a.stack-parent"],
      cwd: repo.dir,
      stdout: "null",
      stderr: "null",
    } as Deno.RunOptions).then((p) => p.status());
    expect(code).not.toBe(0);
  });
});
```

Note: `runGit` returns just stdout (per the helper's signature at `helpers.ts:51`); use a small try/catch for the unset-check or read with `git config --get` whose non-zero exit throws.

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/testdata/helpers.test.ts
```

Expected: `trackBranch is not exported`.

- [ ] **Step 3: Implement the helpers**

Append to `src/lib/testdata/helpers.ts`:

```ts
import type { MergeStrategy } from "../stack.ts";

export interface TrackBranchOptions {
  parent: string;
  baseBranch?: string;
  mergeStrategy?: MergeStrategy;
}

/**
 * Write the per-branch trio (`stack-parent`, optional `base-branch`,
 * optional `merge-strategy`) without going through any production helper.
 * Used by tests that need to set up tracked branches under the new schema.
 */
export async function trackBranch(
  dir: string,
  branch: string,
  opts: TrackBranchOptions,
): Promise<void> {
  await runGit(dir, "config", `branch.${branch}.stack-parent`, opts.parent);
  if (opts.baseBranch !== undefined) {
    await runGit(
      dir,
      "config",
      `branch.${branch}.base-branch`,
      opts.baseBranch,
    );
  }
  if (opts.mergeStrategy !== undefined) {
    await runGit(
      dir,
      "config",
      `branch.${branch}.merge-strategy`,
      opts.mergeStrategy,
    );
  }
}

/**
 * Simulate a PR-merged branch: delete the ref. Git removes
 * `branch.<n>.*` config keys with the ref. Use this in tests that need
 * "this branch was landed and is gone" without invoking the full `land`
 * command.
 */
export async function markBranchMerged(
  dir: string,
  branch: string,
): Promise<void> {
  await runGit(dir, "branch", "-D", branch);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/testdata/helpers.test.ts
```

- [ ] **Step 5: Commit**

```
git add src/lib/testdata/helpers.ts src/lib/testdata/helpers.test.ts
git commit -m "test(helpers): add trackBranch and markBranchMerged for v3 schema"
```

---

### Task 5: Write the migration module

`src/lib/migration.ts` detects legacy schema and converts to the new schema. Idempotent. Refuses only when more than one legacy stack has a non-empty `resume-state`. Emits a single stderr line on success. Independent of the rest of the codebase: it shells out to git config directly so it cannot be confused by other helpers' bookkeeping.

**Files:**
- Create: `src/lib/migration.ts`
- Test: `src/lib/migration.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/migration.test.ts`:

```ts
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

describe("migrateLegacyConfig — single stack happy path", () => {
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

describe("migrateLegacyConfig — multi-stack with distinct bases", () => {
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

describe("migrateLegacyConfig — resume-state", () => {
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

describe("migrateLegacyConfig — default-merge-strategy", () => {
  test("renames stack.default-merge-strategy to stacked-prs.default-merge-strategy", async () => {
    await using repo = await createTestRepo();
    await setConfig(repo.dir, "stack.default-merge-strategy", "merge");
    await migrateLegacyConfig(repo.dir);
    expect(await getConfig(repo.dir, "stacked-prs.default-merge-strategy")).toBe("merge");
    expect(await getConfig(repo.dir, "stack.default-merge-strategy")).toBeUndefined();
  });
});

describe("migrateLegacyConfig — orphans and tombstones", () => {
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

describe("migrateLegacyConfig — idempotency", () => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/migration.test.ts
```

Expected: import errors (the module does not exist yet).

- [ ] **Step 3: Implement `src/lib/migration.ts`**

Create the file:

```ts
/**
 * Auto-migration from v2 (stack-name) to v3 (per-branch + repo-level) schema.
 *
 * v2 keys:
 *   branch.<n>.stack-name
 *   branch.<n>.stack-parent           (kept in v3)
 *   stack.<sn>.base-branch
 *   stack.<sn>.merge-strategy
 *   stack.<sn>.resume-state           (at most one in flight)
 *   stack.<sn>.land-resume-state      (at most one in flight)
 *   stack.<sn>.color                  (dropped, derived from root branch in v3)
 *   stack.<sn>.landed-branches        (dropped; no tombstones in v3)
 *   stack.<sn>.landed-pr              (dropped)
 *   stack.<sn>.landed-parent          (dropped)
 *   stack.default-merge-strategy      (renamed to stacked-prs.default-merge-strategy)
 *
 * v3 keys this writes:
 *   branch.<n>.base-branch
 *   branch.<n>.merge-strategy
 *   stacked-prs.resume-state          (at most one)
 *   stacked-prs.land-resume-state     (at most one)
 *   stacked-prs.default-merge-strategy
 */

import { runGitCommand } from "./stack.ts";

const LEGACY_PROBE_REGEX =
  "^(branch\\.[^.]+\\.stack-name|stack\\.)";

export interface MigrationResult {
  branches: number;
  stacks: number;
}

export async function needsMigration(dir: string): Promise<boolean> {
  const { code, stdout } = await runGitCommand(
    dir,
    "config",
    "--name-only",
    "--get-regexp",
    LEGACY_PROBE_REGEX,
  );
  if (code !== 0) return false;
  return stdout.trim().length > 0;
}

interface LegacySnapshot {
  // branch -> { stackName, parent }
  branches: Map<string, { stackName: string; parent?: string }>;
  // stackName -> single-value fields
  stacks: Map<
    string,
    {
      baseBranch?: string;
      mergeStrategy?: string;
      resumeState?: string;
      landResumeState?: string;
    }
  >;
  defaultMergeStrategy?: string;
}

async function snapshot(dir: string): Promise<LegacySnapshot> {
  const branches = new Map<string, { stackName: string; parent?: string }>();
  const stacks = new Map<
    string,
    {
      baseBranch?: string;
      mergeStrategy?: string;
      resumeState?: string;
      landResumeState?: string;
    }
  >();
  let defaultMergeStrategy: string | undefined;

  const { stdout: legacyDump } = await runGitCommand(
    dir,
    "config",
    "--get-regexp",
    LEGACY_PROBE_REGEX,
  );

  for (const line of legacyDump.split("\n")) {
    if (!line) continue;
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) continue;
    const key = line.slice(0, spaceIndex);
    const value = line.slice(spaceIndex + 1);

    let m = /^branch\.(.+)\.stack-name$/.exec(key);
    if (m) {
      const branch = m[1];
      const existing = branches.get(branch) ?? { stackName: value };
      existing.stackName = value;
      branches.set(branch, existing);
      continue;
    }
    m = /^branch\.(.+)\.stack-parent$/.exec(key);
    if (m) {
      const branch = m[1];
      const existing = branches.get(branch) ?? { stackName: "" };
      existing.parent = value;
      branches.set(branch, existing);
      continue;
    }
    if (key === "stack.default-merge-strategy") {
      defaultMergeStrategy = value;
      continue;
    }
    m = /^stack\.(.+)\.(base-branch|merge-strategy|resume-state|land-resume-state)$/
      .exec(key);
    if (m) {
      const [, sn, field] = m;
      const existing = stacks.get(sn) ?? {};
      if (field === "base-branch") existing.baseBranch = value;
      else if (field === "merge-strategy") existing.mergeStrategy = value;
      else if (field === "resume-state") existing.resumeState = value;
      else if (field === "land-resume-state") existing.landResumeState = value;
      stacks.set(sn, existing);
      continue;
    }
    // landed-*, color, and any other stack.<sn>.* key: ignore (will be deleted)
  }

  // Strip entries that exist only because of a stack-parent without stack-name
  // (those branches aren't in any stack; leave their parent pointer alone).
  for (const [b, entry] of branches) {
    if (!entry.stackName) branches.delete(b);
  }

  return { branches, stacks, defaultMergeStrategy };
}

export async function migrateLegacyConfig(
  dir: string,
): Promise<MigrationResult | null> {
  if (!(await needsMigration(dir))) return null;

  const snap = await snapshot(dir);

  const resumeOwners = [...snap.stacks.entries()].filter(
    ([, s]) => s.resumeState !== undefined,
  );
  if (resumeOwners.length > 1) {
    throw new Error(
      "stacked-prs migration: multiple stacks have an in-progress resume-state " +
        `(${resumeOwners.map(([n]) => n).join(", ")}). Finish or abort the ` +
        "rebase using the prior version, then upgrade again.",
    );
  }
  const landResumeOwners = [...snap.stacks.entries()].filter(
    ([, s]) => s.landResumeState !== undefined,
  );
  if (landResumeOwners.length > 1) {
    throw new Error(
      "stacked-prs migration: multiple stacks have an in-progress " +
        "land-resume-state. Finish or abort the in-flight land using the prior " +
        "version, then upgrade again.",
    );
  }

  // Step 3: write new keys.
  for (const [branch, entry] of snap.branches) {
    const stack = snap.stacks.get(entry.stackName);
    if (!stack) {
      // Orphan branch: pointed at a missing stack. Leave parent pointer
      // alone; do not write per-branch trio. It is now "untracked".
      continue;
    }
    if (stack.baseBranch) {
      await runGitCommand(
        dir,
        "config",
        `branch.${branch}.base-branch`,
        stack.baseBranch,
      );
    }
    if (stack.mergeStrategy) {
      await runGitCommand(
        dir,
        "config",
        `branch.${branch}.merge-strategy`,
        stack.mergeStrategy,
      );
    }
  }

  if (resumeOwners.length === 1) {
    await runGitCommand(
      dir,
      "config",
      "stacked-prs.resume-state",
      resumeOwners[0][1].resumeState!,
    );
  }
  if (landResumeOwners.length === 1) {
    await runGitCommand(
      dir,
      "config",
      "stacked-prs.land-resume-state",
      landResumeOwners[0][1].landResumeState!,
    );
  }
  if (snap.defaultMergeStrategy) {
    await runGitCommand(
      dir,
      "config",
      "stacked-prs.default-merge-strategy",
      snap.defaultMergeStrategy,
    );
  }

  // Step 4: delete every legacy key.
  await deleteSection(dir, "stack");
  // branch.<n>.stack-name only (not stack-parent)
  await deleteKeysMatching(dir, "^branch\\..*\\.stack-name$");

  // Step 5: emit one stderr line.
  const branchesCount = [...snap.branches.values()].filter((e) =>
    snap.stacks.has(e.stackName)
  ).length;
  const stacksCount = snap.stacks.size;
  console.error(
    `stacked-prs: migrated git config to v3 schema (${branchesCount} branches across ${stacksCount} stacks)`,
  );

  return { branches: branchesCount, stacks: stacksCount };
}

async function deleteKeysMatching(
  dir: string,
  pattern: string,
): Promise<void> {
  const { code, stdout } = await runGitCommand(
    dir,
    "config",
    "--name-only",
    "--get-regexp",
    pattern,
  );
  if (code !== 0 || !stdout.trim()) return;
  // Snapshot the keys; deletion may include multi-value keys which we
  // unset-all individually.
  const keys = new Set(stdout.split("\n").filter(Boolean));
  for (const key of keys) {
    await runGitCommand(dir, "config", "--unset-all", key);
  }
}

async function deleteSection(dir: string, section: string): Promise<void> {
  // Use --remove-section repeatedly; if it fails (no such section), we are done.
  // Subsection names may contain dots, so we iterate over distinct subsections
  // first, then unset top-level keys.
  const { stdout } = await runGitCommand(
    dir,
    "config",
    "--name-only",
    "--get-regexp",
    `^${section}\\.`,
  );
  const keys = stdout.split("\n").filter(Boolean);
  const subsections = new Set<string>();
  const topLevel = new Set<string>();
  for (const key of keys) {
    // stack.<sn>.<field> -> subsection is everything between the first and last dot
    const firstDot = key.indexOf(".");
    const lastDot = key.lastIndexOf(".");
    if (firstDot === lastDot) {
      topLevel.add(key);
    } else {
      subsections.add(key.slice(0, lastDot));
    }
  }
  for (const sub of subsections) {
    await runGitCommand(dir, "config", "--remove-section", sub);
  }
  for (const key of topLevel) {
    await runGitCommand(dir, "config", "--unset", key);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/migration.test.ts
```

Iterate until all migration tests pass. If a test fails on the `--remove-section` path (some test cases have a `.` in the stack name like `feat/a`), the subsection logic above handles `feat/a` correctly because git config quotes subsection names with dots. Verify with a one-off `git config --remove-section "stack.feat/a"` in a test repo if needed.

- [ ] **Step 5: Commit**

```
git add src/lib/migration.ts src/lib/migration.test.ts
git commit -m "feat(migration): add v2 to v3 legacy config migration"
```

---

### Task 6: Wire migration into `getStackTree` / `getAllStackTrees`

Migration runs lazily at the top of every read. The probe is cheap (one `git config --get-regexp`). On fresh repos, it returns no rows and we proceed immediately.

**Files:**
- Modify: `src/lib/stack.ts`
- Test: `src/lib/migration.test.ts` (add integration test)

- [ ] **Step 1: Write the failing integration test**

Append to `src/lib/migration.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the integration test to verify it fails**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/migration.test.ts --filter "auto-runs"
```

Expected: the `branch.feat/a.base-branch` assertion fails because nothing has migrated yet.

- [ ] **Step 3: Add the migration probe to `getStackTree` and `getAllStackTrees`**

In `src/lib/stack.ts`:

1. Add an import at the top of the file (near the other relative imports):

```ts
import { migrateLegacyConfig, needsMigration } from "./migration.ts";
```

2. Add a single-shot guard so we never call `needsMigration` twice in the same process for the same dir:

```ts
const migrationDone = new Set<string>();

async function ensureMigrated(dir: string): Promise<void> {
  if (migrationDone.has(dir)) return;
  if (await needsMigration(dir)) {
    await migrateLegacyConfig(dir);
  }
  migrationDone.add(dir);
}
```

3. Call `ensureMigrated(dir)` as the first line of `getStackTree` (before the `gitConfigGetRegexp` read inside `readAllBranchStackConfig` — easiest place is the top of `getStackTree`, which is the public entry point):

```ts
export async function getStackTree(
  dir: string,
  stackName?: string,
  preScan?: Map<string, BranchStackEntry>,
): Promise<StackTree> {
  await ensureMigrated(dir);
  // ...rest unchanged for now...
}
```

4. Also call it in `getAllStackTrees`:

```ts
export async function getAllStackTrees(dir: string): Promise<StackTree[]> {
  await ensureMigrated(dir);
  // ...rest unchanged...
}
```

5. Also call it at the top of `listAllStacks`.

- [ ] **Step 4: Run the integration test + full suite to verify they pass**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/migration.test.ts
deno task test
```

Expected: all migration tests pass. Existing tests still pass because the migration probe returns nothing on test repos using the legacy `setStackBranch` helper (because they go through helper functions that already write the new keys, OR they use the `addTombstone` helper which writes legacy keys — those tests will exercise migration unintentionally, which is fine).

If existing tests break because migration runs on them and changes their setup, that's expected. Update those tests in subsequent tasks; do not patch them here.

- [ ] **Step 5: Commit**

```
git add src/lib/stack.ts src/lib/migration.test.ts
git commit -m "feat(migration): auto-run migration probe on every stack read"
```

---

## Phase B: Per-command migration

### Task 7: `init` command — drop `--stack-name`, write new schema

`init` registers the current branch as a stack root. The new behavior writes only per-branch keys: `branch.<n>.stack-parent`, `branch.<n>.base-branch`, `branch.<n>.merge-strategy`. No `stack.<sn>.*` writes. The CLI flag `--stack-name` is removed. `InitPlan.stackName` stays on the type and is set to the branch name (kept until Task 17 sweeps the rename).

**Files:**
- Modify: `src/commands/init.ts`
- Modify: `src/cli.ts` (init cliffy block, lines ~1272-1338)
- Test: `src/commands/init.test.ts`

- [ ] **Step 1: Update the tests**

Open `src/commands/init.test.ts`. For every test that asserts the legacy `plan.commands` array shape:

```ts
expect(result.plan?.commands).toEqual([
  "git config branch.feat/a.stack-name feat/a",
  "git config branch.feat/a.stack-parent main",
  "git config stack.feat/a.base-branch main",
  "git config stack.feat/a.merge-strategy squash",
]);
```

Rewrite the expectation to the new shape:

```ts
expect(result.plan?.commands).toEqual([
  "git config branch.feat/a.stack-parent main",
  "git config branch.feat/a.base-branch main",
  "git config branch.feat/a.merge-strategy squash",
]);
```

For every test that passes `{ stackName: "..." }` in options, remove that field. Any test that asserts `stack-exists` (the error code returned when `stack.<sn>.base-branch` already exists) becomes invalid; replace with an equivalent "branch already tracked" check by using `branch.<branch>.stack-parent` as the guard.

For the test "rejects when an explicit stack name conflicts with an existing stack", delete it entirely.

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/init.test.ts
```

- [ ] **Step 3: Update `src/commands/init.ts`**

1. Remove `stackName` from `InitOptions`:

```ts
export interface InitOptions {
  branch?: string;
  mergeStrategy?: MergeStrategy;
  baseBranch?: string;
  dryRun?: boolean;
}
```

2. Keep `InitPlan.stackName` for now (it carries the root branch name, used by the printer). Document it as transitional:

```ts
export interface InitPlan {
  branch: string;
  /** @deprecated kept for printer compatibility; equals `branch`. Renamed to `rootBranch` in Task 17. */
  stackName: string;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
  commands: string[];
}
```

3. Remove the `InitError = "stack-exists"` variant. Replace the "stack already exists" guard in `planInit` with a branch-tracked guard: read `branch.<branch>.stack-parent` directly; if present and not equal to a base-branch fallback, return `"already-in-stack"`.

4. Change the `commands` array constructor to the new three-line form. Inside the function that builds `plan.commands`:

```ts
const commands: string[] = [
  gitCmd("config", `branch.${branch}.stack-parent`, baseBranch),
  gitCmd("config", `branch.${branch}.base-branch`, baseBranch),
  gitCmd("config", `branch.${branch}.merge-strategy`, mergeStrategy),
];
```

5. Update `executeInit` to actually run those three writes (drop the `setBaseBranch`/`setMergeStrategy` calls; use `setBranchBaseBranch` and `setBranchMergeStrategy` from Task 1, plus `gitConfigSet` for `stack-parent` or keep an existing helper).

6. Set `plan.stackName = branch` (so callers that still read it get the root branch name).

- [ ] **Step 4: Update `src/cli.ts` init block**

Drop the `--stack-name` option line (line 1039) and the `stackName: options.stackName` field in `baseOpts`. Update the success message:

```ts
console.log(
  `Initialized ${result.plan.branch} as a new stack (base: ${result.plan.baseBranch}).`,
);
```

- [ ] **Step 5: Run tests + commit**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/init.test.ts
deno task check
```

```
git add src/commands/init.ts src/commands/init.test.ts src/cli.ts
git commit -m "feat(init)!: drop --stack-name, write per-branch metadata only"
```

---

### Task 8: `import` command — drop `--stack-name`, write new schema

`import` discovers an existing branch chain via `discoverChain` and writes per-branch metadata for every discovered branch. The CLI flag `--stack-name` is removed. The "stack already exists" error becomes "first branch in chain is already tracked".

**Files:**
- Modify: `src/commands/import.ts`
- Modify: `src/cli.ts` (import cliffy block, lines ~1339-1410)
- Test: `src/commands/import.test.ts`

- [ ] **Step 1: Update the tests**

Same shape as Task 7. Rewrite every `plan.commands` assertion to omit `stack-name` writes and add `branch.<n>.base-branch` + `.merge-strategy` per branch. Pattern:

Before:
```ts
expect(plan.commands).toEqual([
  "git config branch.feat/a.stack-name my-stack",
  "git config branch.feat/a.stack-parent main",
  "git config branch.feat/b.stack-name my-stack",
  "git config branch.feat/b.stack-parent feat/a",
  "git config stack.my-stack.base-branch main",
  "git config stack.my-stack.merge-strategy squash",
]);
```

After:
```ts
expect(plan.commands).toEqual([
  "git config branch.feat/a.stack-parent main",
  "git config branch.feat/a.base-branch main",
  "git config branch.feat/a.merge-strategy squash",
  "git config branch.feat/b.stack-parent feat/a",
  "git config branch.feat/b.base-branch main",
  "git config branch.feat/b.merge-strategy squash",
]);
```

Remove tests for the `stack-exists` error. Remove tests asserting `plan.stackName === "<user-supplied>"`; replace with `plan.stackName === "feat/a"` (the root branch name).

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/import.test.ts
```

- [ ] **Step 3: Update `src/commands/import.ts`**

1. Remove `stackName` from `ImportOptions`.
2. Keep `ImportPlan.stackName` (set to root branch name).
3. Remove the `"stack-exists"` error variant from `ImportError`. Replace the existing "is the stack name taken?" guard with "is the discovered root already tracked?" (read `branch.<root>.stack-parent`).
4. Rewrite the command-list builder. For each entry, push three lines: `stack-parent`, `base-branch`, `merge-strategy`.
5. Set `plan.stackName = entries[0].branch` (the discovered root).
6. In `executeImport`, replace the `setBaseBranch` / `setMergeStrategy` calls with per-branch writes using `setBranchBaseBranch` / `setBranchMergeStrategy` for each entry.

- [ ] **Step 4: Update `src/cli.ts` import block**

Drop `--stack-name` option line and the `stackName: options.stackName` field in `baseOpts`. Update success message to reference root branch.

- [ ] **Step 5: Run tests + commit**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/import.test.ts
deno task check
git add src/commands/import.ts src/commands/import.test.ts src/cli.ts
git commit -m "feat(import)!: drop --stack-name, write per-branch metadata only"
```

---

### Task 9: `create` command — drop `--stack-name` (auto-init), inherit metadata from parent

`create` has two cases: "child" (current branch is tracked, write new branch's parent = current) and "auto-init" (current branch is the base, current becomes a new root). The `--stack-name` flag is auto-init-only; remove it. Auto-init derives stack identity from the new root branch's name. Child case copies parent's `base-branch` and `merge-strategy` onto the new branch.

**Files:**
- Modify: `src/commands/create.ts`
- Modify: `src/cli.ts` (create cliffy block, lines ~488-525)
- Test: `src/commands/create.test.ts`

- [ ] **Step 1: Update the tests**

Same pattern as Tasks 7-8:
- Drop `stackName` from any options passed in.
- Rewrite `plan.commands` arrays: per-branch trio for the new branch, no `stack.<sn>.*` writes anywhere.
- The "auto-init" plan now writes the trio on both the parent root (if it isn't already tracked) and the new child. Actually no: auto-init means the current branch becomes the root + the new branch becomes its child. The current branch must be the base before, so we write the trio for the base-branch-equals-self case as well. Simplest: write the trio for both branches.

Concrete shape for auto-init creating `feat/a` off `main` with merge-strategy `squash`:

```ts
expect(plan.commands).toEqual([
  // (the parent, main, is the base; auto-init makes the new branch a root)
  "git config branch.feat/a.stack-parent main",
  "git config branch.feat/a.base-branch main",
  "git config branch.feat/a.merge-strategy squash",
]);
```

(No metadata on main itself: main is the base branch, not a tracked stack member.)

For the child case (current = feat/a, new = feat/b):

```ts
expect(plan.commands).toEqual([
  "git config branch.feat/b.stack-parent feat/a",
  "git config branch.feat/b.base-branch main",  // copied from parent's base
  "git config branch.feat/b.merge-strategy squash",  // copied from parent's strategy
]);
```

Delete any test asserting `stackName: "user-provided-name"` is honored.

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts
```

- [ ] **Step 3: Update `src/commands/create.ts`**

1. Remove `stackName` from `CreateBranchOptions`.
2. Keep `CreatePlan.stackName` (set to root branch name; root = self for auto-init, root = walk-up-to-parent-of-base for child).
3. In `planCreate`, child branch: read parent's `branch.<parent>.base-branch` and `.merge-strategy` (via the cascade helpers from Task 2), copy onto the new branch's command list.
4. Auto-init: write trio for the new branch only. The base-branch is the current branch (detected via `detectDefaultBranch` already), and the merge-strategy is `opts.mergeStrategy ?? await getEffectiveMergeStrategy(dir, "<base>")` (which falls back to repo default).
5. In `executeCreate`, replace `setStackNode` + `setBaseBranch` + `setMergeStrategy` with the per-branch trio writes.
6. Remove the `"stack-exists"` guard (`git config --get-regexp ^stack\.${escapeRegex(stackName)}\.`).

- [ ] **Step 4: Update `src/cli.ts` create block**

Drop `--stack-name` option line and the `stackName: options.stackName` field in `baseOpts`. Update success message.

- [ ] **Step 5: Run tests + commit**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts
deno task check
git add src/commands/create.ts src/commands/create.test.ts src/cli.ts
git commit -m "feat(create)!: drop --stack-name, copy parent metadata to new branch"
```

---

### Task 10: `restack` — move resume-state to repo-level

`stack.<sn>.resume-state` becomes `stacked-prs.resume-state`. The `ResumeState.stackName` field stays in the JSON payload for now (used by the printer); Task 17 renames it. The `resumeStore` factory in `stack.ts` learns a new repo-level variant.

**Files:**
- Modify: `src/lib/stack.ts` (resumeStore variant)
- Modify: `src/commands/restack.ts`
- Test: `src/commands/restack.test.ts`
- Modify: `src/lib/migration.ts` (already handles resume-state)

- [ ] **Step 1: Update the tests**

In `src/commands/restack.test.ts`, every place that sets up or asserts `stack.<sn>.resume-state` switches to `stacked-prs.resume-state`. The JSON payload shape doesn't change.

Add one new test:

```ts
test("refuses fresh restack while a repo-level resume-state exists", async () => {
  await using repo = await createTestRepo();
  // ... set up a stack ...
  await runGit(repo.dir, "config", "stacked-prs.resume-state", '{"completed":[],"opts":{}}');
  const result = await restack(repo.dir, "feat/a", {});
  expect(result.ok).toBe(false);
  expect(result.error).toBe("conflict");  // or whatever the existing in-flight detection returns
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/restack.test.ts
```

- [ ] **Step 3: Add a repo-level `resumeStore` variant and switch restack to use it**

In `src/lib/stack.ts`, add a parallel factory:

```ts
export function repoResumeStore<T>(
  dir: string,
  key: string,
): ResumeStore<T> {
  const configKey = `stacked-prs.${key}`;
  return {
    async read() {
      const { code, stdout } = await runGitCommand(dir, "config", configKey);
      if (code !== 0) return null;
      try {
        return JSON.parse(stdout) as T;
      } catch {
        return null;
      }
    },
    async write(state: T) {
      await runGitCommand(dir, "config", configKey, JSON.stringify(state));
    },
    async clear() {
      await runGitCommand(dir, "config", "--unset", configKey);
    },
  };
}
```

In `src/commands/restack.ts`, replace:

```ts
const resumeStateFor = (dir: string, stackName: string) =>
  resumeStore<ResumeState>(dir, stackName, "resume-state");
```

with:

```ts
const resumeStateFor = (dir: string) =>
  repoResumeStore<ResumeState>(dir, "resume-state");
```

Drop `stackName` from every `readResumeState` / `writeResumeState` / `clearResumeState` signature and call site. The `ResumeState` interface keeps its `stackName` field (still used by the printer).

Update the recovery hint in `makeRecovery`:

```ts
const makeRecovery = (): RestackResult["recovery"] => ({
  resolve: "git add <conflicting files> && git rebase --continue",
  abort: "git rebase --abort",
  resume:
    `deno run --allow-run=git,gh --allow-env --allow-read src/cli.ts restack --resume`,
});
```

Update the error message that mentions the legacy key (`restack.ts:381`):

```ts
`Run with --resume or clear stacked-prs.resume-state manually.`
```

- [ ] **Step 4: Run tests + commit**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/restack.test.ts
deno task check
git add src/lib/stack.ts src/commands/restack.ts src/commands/restack.test.ts
git commit -m "feat(restack)!: move resume-state to repo-level stacked-prs.resume-state"
```

---

### Task 11: `land` — reparent instead of tombstone

The big behavior change. `land` no longer writes `landed-branches` / `landed-pr` / `landed-parent`. After the PR is confirmed merged and the local base is fast-forwarded, the landed branch's children are reparented to its former parent (the base, for a root land; the nearest surviving ancestor, for a mid-stack land), then `git branch -D` removes the landed branch. Per-branch config goes with it.

`nav.ts` (used downstream by `land` and as its own command) loses its merged-branch rendering path; if a branch no longer exists, it does not appear in nav comments.

**Files:**
- Modify: `src/commands/land.ts`
- Modify: `src/lib/nav.ts`
- Modify: `src/lib/cleanup.ts` (`configBranchCleanup` body)
- Test: `src/commands/land.test.ts`
- Test: `src/lib/nav.test.ts`

- [ ] **Step 1: Update the tests**

In `src/commands/land.test.ts`, find every test that asserts `landed-branches` / `landed-pr` / `landed-parent` config keys after a land. There are roughly a dozen such tests (search: `grep -n "landed-" src/commands/land.test.ts`).

Rewrite each test to assert two things instead:

1. The landed branch's children have their `stack-parent` updated to the landed branch's former parent (the base, for a root land).
2. The landed branch's ref no longer exists (`git rev-parse --verify <branch>` exits non-zero).

Example:

```ts
test("landing root reparents children to base and deletes the root", async () => {
  await using repo = await createTestRepo();
  await addBranch(repo.dir, "feat/a", "main");
  await addBranch(repo.dir, "feat/b", "feat/a");
  await trackBranch(repo.dir, "feat/a", { parent: "main", baseBranch: "main", mergeStrategy: "squash" });
  await trackBranch(repo.dir, "feat/b", { parent: "feat/a", baseBranch: "main", mergeStrategy: "squash" });
  // ... mock PR for feat/a as merged ...
  await executeLand(repo.dir, plan, hooks);
  // child reparented
  expect(await getConfig(repo.dir, "branch.feat/b.stack-parent")).toBe("main");
  // root deleted
  const { code } = await Deno.run({ cmd: ["git", "rev-parse", "--verify", "feat/a"], cwd: repo.dir, stdout: "null", stderr: "null" } as Deno.RunOptions).then(p => p.status());
  expect(code).not.toBe(0);
});
```

Add a new test for mid-stack land:

```ts
test("landing mid-stack reparents to former parent and deletes", async () => {
  await using repo = await createTestRepo();
  await addBranch(repo.dir, "feat/a", "main");
  await addBranch(repo.dir, "feat/b", "feat/a");
  await addBranch(repo.dir, "feat/c", "feat/b");
  await trackBranch(repo.dir, "feat/a", { parent: "main", baseBranch: "main", mergeStrategy: "squash" });
  await trackBranch(repo.dir, "feat/b", { parent: "feat/a", baseBranch: "main", mergeStrategy: "squash" });
  await trackBranch(repo.dir, "feat/c", { parent: "feat/b", baseBranch: "main", mergeStrategy: "squash" });
  // ... mock feat/b as merged but feat/a still open ...
  // ... call planLand + executeLand for feat/b ...
  expect(await getConfig(repo.dir, "branch.feat/c.stack-parent")).toBe("feat/a");
});
```

In `src/lib/nav.test.ts`, remove every test asserting that merged branches appear in nav comments. Replace with tests verifying nav comments only mention currently-tracked branches.

- [ ] **Step 2: Run tests to verify they fail**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/land.test.ts src/lib/nav.test.ts
```

Expect mass failures.

- [ ] **Step 3: Rewrite tombstone-writing paths to reparent + delete**

In `src/lib/cleanup.ts`, rewrite `configBranchCleanup` (lines 271-294) to reparent only:

```ts
export async function configBranchCleanup(
  dir: string,
  stackName: string,
  mergedBranch: string,
  _prNumber?: number,
): Promise<BranchCleanupResult> {
  const tree = await getStackTree(dir, stackName);
  const node = findNode(tree, mergedBranch);
  if (!node) {
    throw new Error(
      `configBranchCleanup: ${mergedBranch} is not a member of stack ${stackName}`,
    );
  }
  // Reparent each direct child of mergedBranch to mergedBranch's recorded parent.
  for (const child of node.children) {
    await gitConfigSet(dir, `branch.${child.branch}.stack-parent`, node.parent);
  }
  return { removed: mergedBranch, splitInto: [] };
}
```

(Adjust imports: import `gitConfigSet` from `./stack.ts` and remove unused `addLandedBranch` / `addLandedParent` / `addLandedPr`.)

In `src/commands/land.ts`:

1. Find the tombstone-writing block at lines 1019-1042 (`for (const branch of toDelete) { ... addLandedBranch/Pr/Parent ... }`). Replace with reparenting before delete:

```ts
for (const branch of toDelete) {
  emit(hooks, { kind: "delete", branch }, "running");
  if (branch !== mergedRoot) {
    // Reparent direct children to this branch's recorded parent BEFORE
    // deleting (otherwise we lose the link).
    const recordedParent = snapByBranch.get(branch)?.recordedParent;
    if (recordedParent !== undefined) {
      const childrenOfThis = plan.snapshot.filter((s) => s.recordedParent === branch);
      for (const child of childrenOfThis) {
        await gitConfigSet(dir, `branch.${child.branch}.stack-parent`, recordedParent);
      }
    }
  }
  const outcome = await deleteBranchIfExists(dir, branch);
  // ...rest unchanged...
}
```

2. The `executeLandFromCli` block at lines 1487-1540 has the same tombstone shape. Apply the same reparent-then-delete rewrite.

3. The `cleanupResult = await configLandCleanup(...)` call near line 974 still works because `configLandCleanup` calls `configBranchCleanup` which we just rewrote. Verify by reading.

In `src/lib/nav.ts`, find every place that consumes `getLandedBranches` / `getLandedPrs` / `getLandedParents` (search: `grep -n "getLanded" src/lib/nav.ts`). Remove those consumers entirely; the nav comment body should be computed only from the live tree.

- [ ] **Step 4: Run tests + commit**

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/land.test.ts src/lib/nav.test.ts src/lib/cleanup.test.ts
deno task check
git add src/commands/land.ts src/lib/nav.ts src/lib/cleanup.ts src/commands/land.test.ts src/lib/nav.test.ts
git commit -m "feat(land)!: reparent children and delete merged branches instead of tombstoning"
```

- [ ] **Step 5: Run the full suite to surface drift**

```
deno task test
```

Triage failures: cross-test fixtures may still call `addTombstone` and rely on tombstone behavior. Leave those tests failing for now if they're not in the files this task touched (they'll be fixed in the subsequent tasks that touch their command files).

---

### Task 12: Rewrite `resolveStackName` → `resolveRootBranch`

`src/cli.ts:88-116` defines `resolveStackName(dir, explicit?)`. Every subcommand calls it. In v3, "the stack" is identified by its root branch. Rename and rewrite: walk parents until you hit the base, return the root. If the current branch isn't tracked, error out.

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts` if any (there are no CLI-level tests today; skip)

- [ ] **Step 1: Write the new helper inline (no test, used by integration tests of each command)**

In `src/cli.ts`, replace `resolveStackName` (lines 88-116):

```ts
async function resolveRootBranch(
  dir: string,
): Promise<string> {
  const { code, stdout: current } = await runGitCommand(
    dir,
    "branch",
    "--show-current",
  );
  if (code !== 0 || !current) {
    console.error(
      "Could not detect current branch. Switch to a tracked stack branch first.",
    );
    Deno.exit(1);
  }

  let walker = current;
  const seen = new Set<string>();
  while (!seen.has(walker)) {
    seen.add(walker);
    const { code: pc, stdout: parent } = await runGitCommand(
      dir,
      "config",
      `branch.${walker}.stack-parent`,
    );
    if (pc !== 0 || !parent) {
      // walker has no recorded parent: either the base branch or untracked
      if (walker === current) {
        console.error(
          `Branch ${current} is not part of a stack. Run \`stacked-prs init\` to track it.`,
        );
        Deno.exit(1);
      }
      // walker IS the root (its parent isn't tracked, so it's pointing at the base)
      return walker;
    }
    // If parent has no stack-parent, then walker is the root.
    const { code: gpc, stdout: grandparent } = await runGitCommand(
      dir,
      "config",
      `branch.${parent}.stack-parent`,
    );
    if (gpc !== 0 || !grandparent) {
      // parent is untracked, walker's parent is the base → walker is the root
      return walker;
    }
    walker = parent;
  }
  // Cycle detected (shouldn't happen): error out
  console.error(
    `Cycle detected in stack-parent chain starting from ${current}`,
  );
  Deno.exit(1);
}
```

- [ ] **Step 2: Replace every call site**

Search for `resolveStackName`:

```
grep -n "resolveStackName" src/cli.ts
```

Replace each call (typically `const stackName = await resolveStackName(dir, options.stackName)`) with:

```ts
const rootBranch = await resolveRootBranch(dir);
```

For now, also rename the local variable from `stackName` to `rootBranch` and pass it to downstream functions that still expect a `stackName` parameter. They'll be migrated in later tasks.

- [ ] **Step 3: Run the test suite**

```
deno task test
```

Many command-level tests still pass `stackName` strings into command functions; that's fine as long as the local variable just happens to carry the root branch name. The functional behavior is unchanged.

- [ ] **Step 4: Commit**

```
git add src/cli.ts
git commit -m "refactor(cli): resolve stack identity via root-branch walk, not stack-name config"
```

---

### Task 13: Status / clean / submit / sync / pr / insert / fold / move / split / import-discover — internal cleanup

These commands don't take `--stack-name` from the CLI but they internally pass `stackName` around. Update each to compute the root branch name from topology and remove any reads of `stack.<sn>.*` keys.

**Files (one task touches all of them, but apply changes file by file):**
- `src/commands/status.ts`
- `src/commands/clean.ts`
- `src/commands/submit.ts`
- `src/commands/sync.ts`
- `src/commands/pr.ts`
- `src/commands/insert.ts`
- `src/commands/fold.ts`
- `src/commands/move.ts`
- `src/commands/split.ts`
- `src/commands/import-discover.ts`
- `src/lib/submit-plan.ts`
- Plus their `.test.ts` counterparts

- [ ] **Step 1: Run the suite once to baseline**

```
deno task test 2>&1 | tail -60
```

Capture which tests currently fail. Use that list to drive the per-file work.

- [ ] **Step 2: For each file in the list, apply this checklist**

For every command file:

1. Search for `stack.${stackName}` and `branch.${...}.stack-name`. Replace each with the new schema:
   - `stack.<sn>.base-branch` → call `getEffectiveBaseBranch(dir, branch)`
   - `stack.<sn>.merge-strategy` → call `getEffectiveMergeStrategy(dir, branch)`
   - `branch.<n>.stack-name` reads/writes → delete (no replacement; stack identity is derived)
2. Remove any `addLandedBranch` / `addLandedPr` / `addLandedParent` calls.
3. Remove any `getLandedBranches` / `getLandedPrs` / `getLandedParents` consumers (return empty arrays for them since the next caller is going to be removed in Task 14, or just delete the consumer code now if it stands alone).
4. Replace `setStackNode(dir, branch, stackName, parent)` calls with direct writes of `branch.<n>.stack-parent` plus, when appropriate, `branch.<n>.base-branch` and `branch.<n>.merge-strategy`.
5. Wherever a function takes a `stackName: string` parameter, leave the signature alone for now (Task 17 sweeps the rename) but pass the root branch name into it.

For each test file:

1. Drop any `addTombstone` calls used to set up "this branch was landed" state. Replace with `markBranchMerged(dir, branch)` (the helper from Task 4).
2. Drop any assertions that check `stack.<sn>.*` config values.
3. Add assertions that check the corresponding `branch.<n>.*` values.

Concrete sub-targets:

- **`src/lib/submit-plan.ts`**: `computeSubmitPlan(dir, stackName, owner, repo, options)` keeps its signature but `stackName` is now the root branch name. Internally, replace `getMergeStrategy(dir, stackName)` with `getEffectiveMergeStrategy(dir, stackName)` (treating stackName as a branch lookup key). The output's `stackName` field stays for now.

- **`src/commands/clean.ts`**: this command detects stale config (orphan `stack.<sn>.*` keys, branches whose `stack-name` points at a missing stack, etc.). In v3 all of that is gone: the only "stale config" detection becomes "branch.<n>.stack-parent pointing at a branch that no longer exists". Rewrite the staleness detector against this single rule. Update tests to match.

- **`src/commands/status.ts`**: any output that says `Stack: <name>` continues to say `Stack: <root-branch>` because the local `stackName` variable was set from `resolveRootBranch`. No structural change. The output format from `.claude/rules/output-style.md` already matches `Stack: <name> (base: <base>)`; that's fine.

- **`src/commands/insert.ts` / `fold.ts` / `move.ts`**: these touch `branch.<n>.stack-name` to propagate stack membership when reparenting. Drop those writes; `stack-parent` is sufficient.

- **`src/commands/split.ts`**: currently calls `configSplitStack` which writes `stack.<new-sn>.*` keys for each split. Rewrite to write `branch.<n>.base-branch` + `.merge-strategy` per branch in each split (replicating from the source stack's values). Update tests.

- **`src/commands/import-discover.ts`**: drop any `stackName` outputs / parameters; the discovery output already keys branches by name without needing a stack name.

- [ ] **Step 3: Run the full suite repeatedly**

After each file's update, run its test file:

```
deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/<file>.test.ts
```

Once each individual file passes, run the full suite:

```
deno task test
deno task check
```

- [ ] **Step 4: Commit**

Split into one commit per command if convenient (`feat(status)!: ...`, `feat(clean)!: ...`), or one bundled commit if the changes are intertwined:

```
git add src/commands/ src/lib/submit-plan.ts src/lib/submit-plan.test.ts
git commit -m "feat!: drop stack.* reads from remaining commands"
```

---

## Phase C: Type and helper cleanup

### Task 14: Remove obsolete `stack.ts` helpers

After phase B, nothing in production code references the legacy helpers. Delete them.

**Files:**
- Modify: `src/lib/stack.ts`
- Modify: `src/lib/stack.test.ts`
- Modify: `src/lib/testdata/helpers.ts`

- [ ] **Step 1: Verify no consumers remain**

```
grep -rn "getLandedBranches\|getLandedPrs\|getLandedParents\|addLandedBranch\|addLandedPr\|addLandedParent\|setStackBranch\|clearStackConfig\|setBaseBranch\|setMergeStrategy\|getMergeStrategy\|getBaseBranch\|getDefaultMergeStrategy" src/
```

Every match outside `src/lib/stack.ts`, `src/lib/stack.test.ts`, `src/lib/migration.ts`, and `src/lib/testdata/helpers.ts` must be zero. If anything still references these, finish the relevant command's migration in Task 13 before proceeding.

The `migration.ts` module is allowed to call legacy helpers internally for the migration probe; but migration uses raw `runGitCommand` calls, not these helpers, so the grep should be clean there too.

- [ ] **Step 2: Delete the helpers from `stack.ts`**

Remove (with line ranges from the codemap):

- `getBaseBranch` (lines 547-553)
- `setBaseBranch` (lines 555-565)
- `clearStackConfig` (lines 567-604)
- `getLandedBranches` / `addLandedBranch` (lines 392-430)
- `getLandedPrs` / `addLandedPr` (lines 432-487)
- `getLandedParents` / `addLandedParent` (lines 489-545)
- `getMergeStrategy` / `setMergeStrategy` (lines 309-340, both versions: keep the new `getBranchMergeStrategy` / `setBranchMergeStrategy` from Task 1)
- `getDefaultMergeStrategy` (lines 320-329) - replaced by inline read of `stacked-prs.default-merge-strategy` inside `getEffectiveMergeStrategy`
- `setStackNode` (lines 381-390) - replaced by direct `gitConfigSet(branch.<n>.stack-parent, ...)`
- `removeStackBranch` (lines 342-358) - replaced inline by `git branch -D <name>` which removes config
- Legacy `setStackBranch` and `SetStackBranchOpts` (lines 5-10, 299-307)
- The `resumeStore` factory: keep it but rename to `legacyResumeStore` (used only by `land.ts` until Task 11 finishes migrating it). Wait: phase B already moved restack to `repoResumeStore`. Check whether `land.ts` still uses `resumeStore(dir, stackName, "land-resume-state")`. If yes, migrate it to `repoResumeStore(dir, "land-resume-state")` now.

Remove the legacy `stack-order` auto-migration block at `stack.ts:693-726` — the new `migrateLegacyConfig` covers it.

- [ ] **Step 3: Delete `addTombstone` from `testdata/helpers.ts`**

The `addTombstone` helper writes legacy tombstone keys. No remaining production code reads them; the only consumer was the tombstone tests we already rewrote in Task 11/13. Delete the function (lines 95-148 in the codemap).

- [ ] **Step 4: Remove obsolete tests**

In `src/lib/stack.test.ts`, delete tests for the helpers you just removed. In particular, the `setStackBranch` migration tests (referencing the legacy linear format) move from `stack.test.ts` to `migration.test.ts` if they're not already there.

- [ ] **Step 5: Run the full suite + commit**

```
deno task test
deno task check
git add src/lib/stack.ts src/lib/stack.test.ts src/lib/testdata/helpers.ts
git commit -m "refactor(stack): remove legacy stack-name helpers and tombstone API"
```

---

### Task 15: Rename `StackTree.stackName` → `rootBranch`, drop `StackNode.stackName`

Final sweep. Mechanical rename across types and JSON output.

**Files:**
- Modify: `src/lib/stack.ts` (types + every constructor)
- Modify: every consumer (search-and-replace)
- Modify: every test that uses the field

- [ ] **Step 1: Rename in types**

In `src/lib/stack.ts`:

```ts
export interface StackNode {
  branch: string;
  parent: string;
  children: StackNode[];
}

export interface StackTree {
  rootBranch: string;
  baseBranch: string;
  mergeStrategy: MergeStrategy | undefined;
  roots: StackNode[];
}
```

(Drop `stackName` from `StackNode` entirely; drop `merged` field if no consumer remains.)

- [ ] **Step 2: Mass rename**

Run a project-wide rename:

```
grep -rln '\.stackName' src/ | xargs sed -i '' 's/\.stackName/.rootBranch/g'
grep -rln 'stackName:' src/ | xargs sed -i '' 's/stackName:/rootBranch:/g'
grep -rln 'stackName,' src/ | xargs sed -i '' 's/stackName,/rootBranch,/g'
grep -rln 'stackName ' src/ | xargs sed -i '' 's/stackName /rootBranch /g'
```

(On macOS, `sed -i ''` requires the empty backup arg. On Linux, use `sed -i`.)

Be careful: some `stackName` usages may be local variable names inside functions that the rename should leave alone (e.g. parameter names that mean "the root branch"). Spot-check after each sed run:

```
grep -rn "stackName" src/
```

Manually inspect the remaining hits and rename appropriately. Common cases:
- `function foo(dir: string, stackName: string)` → `function foo(dir: string, rootBranch: string)`
- `const stackName = ...` → `const rootBranch = ...`

- [ ] **Step 3: Compile and run the suite**

```
deno task check
deno task test
```

Iterate until clean.

- [ ] **Step 4: Commit**

```
git add -A src/
git commit -m "refactor!: rename StackTree.stackName to rootBranch"
```

---

### Task 16: TUI — switch state shape from `stackName` to `rootBranch`

The TUI state/reducer/components and the loader all keyed on `stackName`. After Task 15 most of this is already renamed via the sed sweep, but TSX files need manual inspection because the sed pattern can miss JSX prop usage and snapshot tests.

**Files:**
- Modify: `src/tui/state/loader.ts`
- Modify: `src/tui/state/reducer.ts`
- Modify: `src/tui/state/navigation.ts`
- Modify: `src/tui/components/*.tsx`
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/lib/*.ts` (especially layout.ts)
- Modify: `src/tui/types.ts`
- Test: `src/tui/**/*.test.{ts,tsx}`

- [ ] **Step 1: Grep for any remaining `stackName` in `src/tui/`**

```
grep -rn "stackName" src/tui/
```

- [ ] **Step 2: Rewrite each hit by hand**

For each occurrence, decide:
- If it's a prop name (e.g. `stackName={...}`), rename to `rootBranch`
- If it's a state field, rename
- If it's a key in a Map, rename
- If it's a display label (a render call), keep the rendered string semantics but switch the source variable to the root branch name

- [ ] **Step 3: Update snapshot tests + assertions**

Many TUI tests assert exact rendered strings. If a test expects `Stack: my-stack` and the root branch is `feat/a`, the new expected string is `Stack: feat/a`. Run each test, read the actual output from the diff, update the expectation.

- [ ] **Step 4: Run the suite**

```
deno task test
deno task check
```

- [ ] **Step 5: Commit**

```
git add src/tui/
git commit -m "refactor(tui)!: switch state from stackName to rootBranch"
```

---

## Phase D: Docs and release

### Task 17: Update `skills/stacked-prs/SKILL.md`

The skill is shipped to users. Every `--stack-name` reference must go. Every "Stack: <name>" caption stays (the runtime substitutes the root branch name).

**Files:**
- Modify: `skills/stacked-prs/SKILL.md`

- [ ] **Step 1: Remove every `--stack-name` mention**

```
grep -n "\-\-stack-name" skills/stacked-prs/SKILL.md
```

For each line that includes `[--stack-name <name>]` or `[--stack-name=<name>]`, delete that token. Where the example invocation explicitly passes `--stack-name foo`, delete `--stack-name foo`.

- [ ] **Step 2: Remove the "auto-detect from current branch" prose block**

Around line 649 there is a paragraph reading: "`--stack-name` is auto-detected from the current branch's git config when not provided." Delete the entire paragraph.

- [ ] **Step 3: Update the `init` invocation block**

Replace:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/stacked-prs/scripts/stacked-prs init \
  [--branch <name>] [--stack-name <name>] [--merge-strategy merge|squash] \
  [--base-branch <name>] [--force] [--dry-run] [--json]
```

with:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/stacked-prs/scripts/stacked-prs init \
  [--branch <name>] [--merge-strategy merge|squash] \
  [--base-branch <name>] [--force] [--dry-run] [--json]
```

Apply the same removal to the `import` and `create` invocation blocks.

- [ ] **Step 4: Update the `land` runbook to mention mid-stack land**

Find the `land` section. Today it focuses on root-land. Add one paragraph: "If a branch in the middle of the stack has been merged on GitHub, `cli.ts land` can land it too: it reparents the branch's children onto its former parent and deletes the branch. Tombstones are not written; merged branches do not appear in subsequent nav comments."

- [ ] **Step 5: Run plugin validate + commit**

```
claude plugin validate .
```

(If the `claude` CLI isn't installed locally, this is also covered by CI.)

```
git add skills/stacked-prs/SKILL.md
git commit -m "feat(skill)!: drop --stack-name from SKILL.md and document v3 behavior"
```

---

### Task 18: Update `README.md`, `CLAUDE.md`, and `.claude/rules/output-style.md`

These are in-repo docs. Use `docs:` commit prefix.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `.claude/rules/output-style.md`

- [ ] **Step 1: `README.md`**

Search for "stack name" / "stack-name":

```
grep -in "stack[- ]name" README.md
```

For each occurrence, rewrite to use "stack" (the topology) or "root branch" (when identifying a specific stack). Remove every `--stack-name` flag mention. Add a single one-paragraph upgrade note in a new "Upgrading from 2.x" section near the top:

```markdown
## Upgrading from 2.x

3.0 removes the `--stack-name` flag and the `stack.<name>.*` git config namespace. Stacks are now identified by their root branch (the first branch off the base). On first run after upgrading, `stacked-prs` automatically converts your existing config to the new schema. The conversion prints a single line to stderr and is otherwise silent. The only manual intervention required is finishing or aborting any in-flight rebase from a 2.x version before upgrading.
```

Remove example commands that pass `--stack-name`.

- [ ] **Step 2: `CLAUDE.md`**

Update three sections:

1. The "Git config schema" table around lines 200-230: replace with the new schema (mirror the spec's table).
2. The "Subcommands" line listing all commands: keep the list, but the surrounding prose may mention `--stack-name`; remove that.
3. The "Tree model" section's mention of "stack name": replace with "root branch" identity.
4. The "Architecture > Script roles" table: each command's "Invoked as" column probably mentions `--stack-name` for init/import/create. Remove those tokens.

- [ ] **Step 3: `.claude/rules/output-style.md`**

The rule says: `Stack-scoped sections use Stack: <name> (base: <base>).` This still reads naturally with the root branch name in the `<name>` slot. No change required.

However, if any of the canonical no-op sentences mentioned `--stack-name`, rewrite them. (None do today; verify with grep.)

- [ ] **Step 4: Commit**

```
git add README.md CLAUDE.md .claude/rules/output-style.md
git commit -m "docs: update README, CLAUDE.md, and rules for v3 schema"
```

---

### Task 19: Bump version + release prep

Single major-version bump from current 2.4.x to 3.0.0. release-please will detect the `feat!` commits and the `BREAKING CHANGE:` footer once we push.

**Files:**
- Verify (no manual edit): `deno.json`, `.claude-plugin/plugin.json`

- [ ] **Step 1: Verify the release-please config**

```
cat release-please-config.json
cat .release-please-manifest.json
```

Confirm that `extra-files` bumps both `deno.json` and `.claude-plugin/plugin.json`. If anything is missing, fix the release-please config now (rare; only if the project changed since the last release).

- [ ] **Step 2: Add a `BREAKING CHANGE:` footer to the most recent significant commit**

If the final `feat!:` commit (e.g. the rename from Task 15) does not yet have a `BREAKING CHANGE:` footer, amend it (or add a follow-up `chore:` commit with no code change but with the footer). The footer text:

```
BREAKING CHANGE: --stack-name flag removed from init/import/create; stack.<name>.* git config namespace removed (auto-migrated on first run from any prior 2.x version); landed-* tombstones removed; SubmitPlan/LandPlan/etc. JSON outputs rename stackName to rootBranch. See docs/superpowers/specs/2026-05-21-drop-stack-name-design.md.
```

Use a follow-up commit rather than amending if the prior commit was already pushed.

- [ ] **Step 3: Run the full suite once more**

```
deno task check
deno task test
```

- [ ] **Step 4: Push the branch (do NOT push directly to main per CLAUDE.md)**

```
git push -u origin <branch-name>
```

Then open a PR with `gh pr create`. Do NOT merge until release-please's CI runs.

---

## Self-review checklist (run by the implementing agent at the end)

- [ ] Every `--stack-name` mention is gone from `src/`, `skills/`, `README.md`, `CLAUDE.md`.
- [ ] `grep -rn "stack-name\|stackName" src/` returns only the migration module (which references the old key by string literal).
- [ ] `grep -rn "stack\\.\\${" src/` returns only the migration module.
- [ ] `getLandedBranches`, `getLandedPrs`, `getLandedParents`, `addLandedBranch`, `addLandedPr`, `addLandedParent`, `clearStackConfig`, `setStackBranch`, `setStackNode`, `setBaseBranch` are all gone from `src/lib/stack.ts`.
- [ ] `addTombstone` is gone from `src/lib/testdata/helpers.ts`.
- [ ] `deno task test` passes.
- [ ] `deno task check` passes.
- [ ] `claude plugin validate .` passes.
- [ ] A fresh test repo with no legacy config goes through `init` → `create` → `submit` → `land` smoothly, end-to-end.
- [ ] A test repo with legacy config gets migrated on the first command, and the success message appears once on stderr.
