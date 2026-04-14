---
description: Testing conventions, use await using for per-test temp state
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
alwaysApply: false
---

# Testing patterns

## Per-test temp state via `await using`

All tests that need a temp git repo or temp directory MUST acquire that state
inline via `await using` rather than sharing it through `beforeEach` /
`afterEach` hooks.

### Use

```ts
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createTestRepo, makeTempDir } from "../lib/testdata/helpers.ts";

describe("feature", () => {
  test("does the thing", async () => {
    await using repo = await createTestRepo();
    await using tmp = await makeTempDir("feature-");

    // ... exercise behavior on repo.dir and tmp.path ...
  });
});
```

Both `TestRepo` and `TempDir` implement `[Symbol.asyncDispose]`, so disposal
runs automatically at scope exit even if the test throws.

### Do not

```ts
// Avoid. Shared mutable state, implicit ordering, harder to read in isolation.
describe("feature", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("does the thing", async () => {
    // repo comes from closure state.
  });
});
```

### Shared setup

When several tests need the same non-trivial post-repo-creation setup (e.g.
registering a stack), extract a helper that operates on the already-created
`repo.dir`, and call it from each test body:

```ts
async function setupStackOnFeatA(dir: string): Promise<void> {
  await addBranch(dir, "feat/a", "main");
  await runGit(dir, "checkout", "feat/a");
  // ... config writes ...
}

test("plans a child branch", async () => {
  await using repo = await createTestRepo();
  await setupStackOnFeatA(repo.dir);

  const result = await planCreate(repo.dir, { branch: "feat/b" });
  expect(result.ok).toBe(true);
});
```

Keep the helper at module scope (top of the test file), not inside a `describe`
closure.

### Why

- Each test is readable in isolation; no need to scan outer scope to see what
  `repo` is.
- No shared mutable state between tests, so `deno test --parallel` and
  reordering are safe by construction.
- Setup failures surface at the call site instead of fanning out from
  `beforeEach`.
- Cleanup runs even when assertions throw, via the language, not hook
  bookkeeping.

### Scope

Applies to every `*.test.ts` / `*.test.tsx` file in this repo. TUI component
tests that only render synthetic props (no git state) do not need either helper;
they stay as plain `test()` bodies.
