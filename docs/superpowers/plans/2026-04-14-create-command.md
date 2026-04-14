# `stacked-prs create` CLI Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `cli.ts create <branch>` as a native CLI subcommand that creates a new stack branch off the current branch, optionally committing staged changes and placing the branch in a git worktree; rename `clean --confirm` to `--force` so destructive commands share one "skip TTY prompt" idiom.

**Architecture:** New pure-function module `src/commands/create.ts` exporting `planCreate`, `executeCreate`, `create`. CLI layer in `src/cli.ts` owns TTY prompting and I/O. Supporting helper `detectDefaultBranch` added to `src/lib/stack.ts`. Matches the project's strict purity boundary (commands return typed results; CLI prints/exits).

**Tech Stack:** Deno TypeScript, `@cliffy/command` for CLI parsing, `@std/testing/bdd` + `@std/expect` for tests, real git repos in temp dirs via `src/lib/testdata/helpers.ts`.

**Spec:** `docs/superpowers/specs/2026-04-14-create-command-design.md`

---

## File Structure

**Create:**
- `src/commands/create.ts` — pure planner + executor for the create command
- `src/commands/create.test.ts` — behavioral tests over real git repos

**Modify:**
- `src/lib/stack.ts` — add `detectDefaultBranch`
- `src/lib/stack.test.ts` — add tests for `detectDefaultBranch` (if the file exists; otherwise inline tests for the helper go into `create.test.ts`)
- `src/cli.ts` — add `.command("create", ...)`, rename `clean`'s `--confirm` to `--force`
- `src/commands/clean.test.ts` — update any test that sets `{ confirm: true }` on the applyClean path (only if such tests exist at the CLI layer; library-level tests do not pass a flag)
- `skills/stacked-prs/SKILL.md` — add `create` subcommand section, update Scripts block, rename `clean --confirm` to `--force`
- `CLAUDE.md` — add `commands/create.ts` to the file layout, list `create` as a subcommand, update confirmation gate summary
- `README.md` — surface `create` and update any `clean --confirm` mention

---

## Task 1: `detectDefaultBranch` helper

**Files:**
- Modify: `src/lib/stack.ts`
- Test: `src/commands/create.test.ts` (new file; holds the helper tests plus subsequent command tests)

Detects the repo's default branch using `git symbolic-ref refs/remotes/origin/HEAD`, falling back to local `main`/`master`, and throwing if none resolves. Shared by the auto-init path of `create`.

- [ ] **Step 1.1: Write the failing tests**

Create `src/commands/create.test.ts` with the helper tests:

```ts
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  commitFile,
  createTestRepo,
  runGit,
} from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import { detectDefaultBranch } from "../lib/stack.ts";

describe("detectDefaultBranch", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("returns main when origin/HEAD points to origin/main", async () => {
    // Set up a fake origin with HEAD symbolic-ref pointing at main.
    const bareDir = await Deno.makeTempDir({
      prefix: "stacked-prs-create-origin-",
    });
    try {
      await runGit(repo.dir, "clone", "--bare", repo.dir, bareDir);
      await runGit(repo.dir, "remote", "add", "origin", bareDir);
      await runGit(repo.dir, "fetch", "origin");
      await runGit(
        repo.dir,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );

      const result = await detectDefaultBranch(repo.dir);
      expect(result).toBe("main");
    } finally {
      await Deno.remove(bareDir, { recursive: true });
    }
  });

  test("falls back to local main when origin/HEAD is absent", async () => {
    const result = await detectDefaultBranch(repo.dir);
    expect(result).toBe("main");
  });

  test("falls back to local master when main is absent", async () => {
    await runGit(repo.dir, "branch", "-m", "main", "master");
    const result = await detectDefaultBranch(repo.dir);
    expect(result).toBe("master");
  });

  test("throws when neither origin/HEAD nor main/master exist", async () => {
    // Rename main to something else so no canonical default branch remains.
    await runGit(repo.dir, "branch", "-m", "main", "trunk");
    await expect(detectDefaultBranch(repo.dir)).rejects.toThrow(
      /default branch/i,
    );
  });
});
```

- [ ] **Step 1.2: Run the tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts`
Expected: FAIL — `detectDefaultBranch is not exported from stack.ts`.

- [ ] **Step 1.3: Implement `detectDefaultBranch`**

In `src/lib/stack.ts`, add near the other exported helpers (after `revParse`):

```ts
/**
 * Detect the repo's default branch. Tries origin/HEAD first (the canonical
 * source), then falls back to a local `main` or `master`. Throws when none
 * resolves.
 */
export async function detectDefaultBranch(dir: string): Promise<string> {
  const originHead = await runGitCommand(
    dir,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  if (originHead.code === 0 && originHead.stdout) {
    const trimmed = originHead.stdout.replace(/^origin\//, "");
    if (trimmed) return trimmed;
  }

  for (const candidate of ["main", "master"]) {
    const probe = await runGitCommand(
      dir,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${candidate}`,
    );
    if (probe.code === 0) return candidate;
  }

  throw new Error(
    "Could not detect default branch: no origin/HEAD and no local main or master",
  );
}
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/stack.ts src/commands/create.test.ts
git commit -m "feat(lib): add detectDefaultBranch helper"
```

---

## Task 2: Scaffold `commands/create.ts` with types and stubs

**Files:**
- Create: `src/commands/create.ts`

Defines the public API shape so later tasks only fill in behavior. `planCreate` / `executeCreate` initially throw `not implemented`; `create` routes to one based on `dryRun`.

- [ ] **Step 2.1: Create `src/commands/create.ts`**

```ts
import {
  detectDefaultBranch,
  gitConfig,
  type MergeStrategy,
  runGitCommand,
} from "../lib/stack.ts";

export interface CreateBranchOptions {
  branch: string;
  message?: string;
  createWorktree?: string;
  stackName?: string;
  mergeStrategy?: MergeStrategy;
  force?: boolean;
  dryRun?: boolean;
}

export type CreateCase = "child" | "auto-init" | "auto-init-worktree";

export interface CreatePlan {
  case: CreateCase;
  branch: string;
  parent: string;
  baseBranch: string;
  stackName: string;
  mergeStrategy: MergeStrategy;
  willCommit: boolean;
  worktreePath?: string;
}

export type CreateError =
  | "invalid-branch-name"
  | "branch-exists"
  | "not-on-stack"
  | "worktree-requires-base"
  | "worktree-exists"
  | "flag-misuse"
  | "stack-exists"
  | "nothing-staged"
  | "git-failed";

export interface CreateResult {
  ok: boolean;
  plan?: CreatePlan;
  error?: CreateError;
  message?: string;
}

export async function planCreate(
  _dir: string,
  _opts: CreateBranchOptions,
): Promise<CreateResult> {
  throw new Error("planCreate not implemented");
}

export async function executeCreate(
  _dir: string,
  _opts: CreateBranchOptions,
): Promise<CreateResult> {
  throw new Error("executeCreate not implemented");
}

export function create(
  dir: string,
  opts: CreateBranchOptions,
): Promise<CreateResult> {
  if (opts.dryRun) return planCreate(dir, opts);
  return executeCreate(dir, opts);
}

// Referenced by later tasks to keep imports stable.
export const _internal = { detectDefaultBranch, gitConfig, runGitCommand };
```

The `_internal` re-export is a scaffolding hack to keep `deno lint` happy about unused imports until the real bodies use them. It is removed by the last task that actually consumes them.

- [ ] **Step 2.2: Verify type check**

Run: `deno task check`
Expected: PASS.

- [ ] **Step 2.3: Commit**

```bash
git add src/commands/create.ts
git commit -m "feat(create): scaffold command types and stub entry points"
```

---

## Task 3: Case 1 — child in existing stack (planner + executor)

**Files:**
- Modify: `src/commands/create.ts`
- Modify: `src/commands/create.test.ts`

Implements the simplest path: current branch already has `stack-name` config; the new branch is added as its child. Covers branch-name validation, collision detection, and four error paths (`invalid-branch-name`, `branch-exists`, `not-on-stack`, `flag-misuse`).

- [ ] **Step 3.1: Write the failing tests**

Append to `src/commands/create.test.ts`:

```ts
import { create, planCreate } from "./create.ts";
import { addBranch, setStackNode } from "./create.test.helpers.ts";

describe("create — case 1 (child in existing stack)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
    // Register `feat/a` as a stack branch off main.
    await addBranch(repo.dir, "feat/a", "main");
    await runGit(repo.dir, "checkout", "feat/a");
    await runGit(repo.dir, "config", "branch.feat/a.stack-name", "my-stack");
    await runGit(repo.dir, "config", "branch.feat/a.stack-parent", "main");
    await runGit(repo.dir, "config", "stack.my-stack.base-branch", "main");
    await runGit(repo.dir, "config", "stack.my-stack.merge-strategy", "merge");
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("plans a child branch", async () => {
    const result = await planCreate(repo.dir, { branch: "feat/b" });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("child");
    expect(result.plan?.parent).toBe("feat/a");
    expect(result.plan?.stackName).toBe("my-stack");
    expect(result.plan?.baseBranch).toBe("main");
    expect(result.plan?.willCommit).toBe(false);
  });

  test("creates a child branch and writes config", async () => {
    const result = await create(repo.dir, { branch: "feat/b" });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("child");

    const current = await runGit(repo.dir, "branch", "--show-current");
    expect(current).toBe("feat/b");

    const stackName = await runGit(
      repo.dir,
      "config",
      "branch.feat/b.stack-name",
    );
    expect(stackName).toBe("my-stack");
    const parent = await runGit(
      repo.dir,
      "config",
      "branch.feat/b.stack-parent",
    );
    expect(parent).toBe("feat/a");
  });

  test("commits staged changes when -m is passed", async () => {
    await Deno.writeTextFile(`${repo.dir}/new-file.txt`, "hello\n");
    await runGit(repo.dir, "add", "new-file.txt");

    const result = await create(repo.dir, {
      branch: "feat/b",
      message: "add new-file",
    });
    expect(result.ok).toBe(true);

    const log = await runGit(repo.dir, "log", "--format=%s", "-n", "1");
    expect(log).toBe("add new-file");
  });

  test("rejects invalid branch names", async () => {
    const result = await create(repo.dir, { branch: "has spaces" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-branch-name");
  });

  test("rejects collision with existing branch", async () => {
    await addBranch(repo.dir, "existing", "main");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await create(repo.dir, { branch: "existing" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("branch-exists");
  });

  test("rejects flag misuse (--stack-name on child)", async () => {
    const result = await create(repo.dir, {
      branch: "feat/b",
      stackName: "other",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("flag-misuse");
  });

  test("rejects --create-worktree on child", async () => {
    const result = await create(repo.dir, {
      branch: "feat/b",
      createWorktree: "/tmp/should-not-be-used",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("worktree-requires-base");
  });

  test("errors when on untracked non-base branch", async () => {
    await runGit(repo.dir, "checkout", "-b", "random");
    const result = await create(repo.dir, { branch: "feat/c" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-on-stack");
  });

  test("dry-run does not mutate", async () => {
    const result = await create(repo.dir, {
      branch: "feat/b",
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("child");

    const probe = await runGit(
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/feat/b",
    ).catch(() => "");
    expect(probe).toBe("");
  });
});
```

Remove the unused `addBranch, setStackNode` import line; use `addBranch` from `../lib/testdata/helpers.ts` already imported, and drop `setStackNode` (the test sets config directly via `runGit`).

Corrected import line:

```ts
import { create, planCreate } from "./create.ts";
```

Also add `addBranch` to the existing top-level import from `helpers.ts`.

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts`
Expected: FAIL — `planCreate not implemented`.

- [ ] **Step 3.3: Implement the case-1 planner**

Replace the `planCreate` stub in `src/commands/create.ts`:

```ts
async function validateBranchName(
  dir: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!branch) return { ok: false, message: "branch name is required" };
  const { code, stderr } = await runGitCommand(
    dir,
    "check-ref-format",
    "--branch",
    branch,
  );
  if (code !== 0) {
    return { ok: false, message: stderr || `invalid branch name: ${branch}` };
  }
  return { ok: true };
}

async function branchExists(dir: string, branch: string): Promise<boolean> {
  const { code } = await runGitCommand(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  );
  return code === 0;
}

async function currentBranch(dir: string): Promise<string> {
  const { code, stdout } = await runGitCommand(dir, "branch", "--show-current");
  if (code !== 0) return "";
  return stdout;
}

export async function planCreate(
  dir: string,
  opts: CreateBranchOptions,
): Promise<CreateResult> {
  const nameCheck = await validateBranchName(dir, opts.branch);
  if (!nameCheck.ok) {
    return {
      ok: false,
      error: "invalid-branch-name",
      message: nameCheck.message,
    };
  }

  if (await branchExists(dir, opts.branch)) {
    return {
      ok: false,
      error: "branch-exists",
      message:
        `branch "${opts.branch}" already exists; use \`move\` to reparent or delete it first`,
    };
  }

  const current = await currentBranch(dir);
  if (!current) {
    return {
      ok: false,
      error: "not-on-stack",
      message:
        "not on a branch (detached HEAD); run `init` or switch to a stack branch",
    };
  }

  const currentStack = await gitConfig(
    dir,
    `branch.${current}.stack-name`,
  );

  if (currentStack) {
    // Case 1: child in existing stack.
    if (opts.createWorktree !== undefined) {
      return {
        ok: false,
        error: "worktree-requires-base",
        message:
          "--create-worktree only applies when starting a new stack from the base branch",
      };
    }
    if (opts.stackName !== undefined || opts.mergeStrategy !== undefined) {
      return {
        ok: false,
        error: "flag-misuse",
        message:
          "--stack-name and --merge-strategy only apply when auto-initing from the base branch",
      };
    }
    const baseBranch = await gitConfig(
      dir,
      `stack.${currentStack}.base-branch`,
    );
    const strategy = (await gitConfig(
      dir,
      `stack.${currentStack}.merge-strategy`,
    )) as MergeStrategy | undefined;
    if (!baseBranch || !strategy) {
      return {
        ok: false,
        error: "git-failed",
        message: `stack "${currentStack}" is missing base-branch or merge-strategy config`,
      };
    }

    return {
      ok: true,
      plan: {
        case: "child",
        branch: opts.branch,
        parent: current,
        baseBranch,
        stackName: currentStack,
        mergeStrategy: strategy,
        willCommit: opts.message !== undefined,
      },
    };
  }

  // Not in a stack — auto-init eligibility handled in later tasks.
  return {
    ok: false,
    error: "not-on-stack",
    message:
      `current branch "${current}" is not part of a stack; run \`init\` first or switch to a stack branch`,
  };
}
```

- [ ] **Step 3.4: Implement the case-1 executor**

Replace the `executeCreate` stub:

```ts
async function runGitOrFail(
  dir: string,
  ...args: string[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { code, stderr, stdout } = await runGitCommand(dir, ...args);
  if (code !== 0) {
    return { ok: false, message: (stderr || stdout).trim() };
  }
  return { ok: true };
}

export async function executeCreate(
  dir: string,
  opts: CreateBranchOptions,
): Promise<CreateResult> {
  const planResult = await planCreate(dir, opts);
  if (!planResult.ok || !planResult.plan) return planResult;

  const plan = planResult.plan;

  if (plan.case === "child") {
    const checkout = await runGitOrFail(dir, "checkout", "-b", plan.branch);
    if (!checkout.ok) {
      return { ok: false, error: "git-failed", message: checkout.message };
    }

    if (opts.message !== undefined) {
      const commit = await runGitCommand(
        dir,
        "commit",
        "-m",
        opts.message,
      );
      if (commit.code !== 0) {
        const stderr = (commit.stderr || commit.stdout).toLowerCase();
        if (
          stderr.includes("nothing to commit") ||
          stderr.includes("no changes added")
        ) {
          return {
            ok: false,
            error: "nothing-staged",
            message: "nothing staged; stage changes before using -m",
          };
        }
        return {
          ok: false,
          error: "git-failed",
          message: (commit.stderr || commit.stdout).trim(),
        };
      }
    }

    const setStack = await runGitOrFail(
      dir,
      "config",
      `branch.${plan.branch}.stack-name`,
      plan.stackName,
    );
    if (!setStack.ok) {
      return { ok: false, error: "git-failed", message: setStack.message };
    }
    const setParent = await runGitOrFail(
      dir,
      "config",
      `branch.${plan.branch}.stack-parent`,
      plan.parent,
    );
    if (!setParent.ok) {
      return { ok: false, error: "git-failed", message: setParent.message };
    }

    return { ok: true, plan };
  }

  // Case 2 and case 3 added in later tasks.
  return {
    ok: false,
    error: "git-failed",
    message: `case ${plan.case} not yet implemented`,
  };
}
```

Remove the placeholder `_internal` export from Task 2 — all of the once-unused imports are consumed now.

- [ ] **Step 3.5: Run tests to verify case-1 passes**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts`
Expected: PASS for all case-1 tests and the earlier `detectDefaultBranch` tests.

- [ ] **Step 3.6: Commit**

```bash
git add src/commands/create.ts src/commands/create.test.ts
git commit -m "feat(create): implement case 1 (child in existing stack)"
```

---

## Task 4: Case 2 — auto-init from base, in-repo

**Files:**
- Modify: `src/commands/create.ts`
- Modify: `src/commands/create.test.ts`

Implements the "starting a new stack from main" path. The planner accepts `--stack-name` and `--merge-strategy`; the executor writes both stack-level and branch-level config.

- [ ] **Step 4.1: Write the failing tests**

Append to `src/commands/create.test.ts`:

```ts
describe("create — case 2 (auto-init in-repo)", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
    // Default branch is main; no stack config yet.
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("plans auto-init with defaulted stack name", async () => {
    const result = await planCreate(repo.dir, { branch: "feat/a" });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("auto-init");
    expect(result.plan?.stackName).toBe("feat/a");
    expect(result.plan?.parent).toBe("main");
    expect(result.plan?.baseBranch).toBe("main");
    expect(result.plan?.mergeStrategy).toBe("merge");
  });

  test("creates a new stack from main", async () => {
    const result = await create(repo.dir, { branch: "feat/a" });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("auto-init");

    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-name"),
    ).toBe("feat/a");
    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-parent"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "stack.feat/a.base-branch"),
    ).toBe("main");
    expect(
      await runGit(repo.dir, "config", "stack.feat/a.merge-strategy"),
    ).toBe("merge");
  });

  test("honors explicit --stack-name and --merge-strategy", async () => {
    const result = await create(repo.dir, {
      branch: "feat/a",
      stackName: "my-stack",
      mergeStrategy: "squash",
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.stackName).toBe("my-stack");
    expect(result.plan?.mergeStrategy).toBe("squash");
    expect(
      await runGit(repo.dir, "config", "stack.my-stack.merge-strategy"),
    ).toBe("squash");
  });

  test("rejects when stack-name already exists", async () => {
    await runGit(repo.dir, "config", "stack.taken.base-branch", "main");

    const result = await create(repo.dir, {
      branch: "feat/a",
      stackName: "taken",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stack-exists");
  });

  test("commits staged changes when -m is passed", async () => {
    await Deno.writeTextFile(`${repo.dir}/file.txt`, "hi\n");
    await runGit(repo.dir, "add", "file.txt");

    const result = await create(repo.dir, {
      branch: "feat/a",
      message: "add file",
    });
    expect(result.ok).toBe(true);

    const log = await runGit(repo.dir, "log", "--format=%s", "-n", "1");
    expect(log).toBe("add file");
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts`
Expected: FAIL — case-2 tests fall through to the "not-on-stack" branch in the planner.

- [ ] **Step 4.3: Extend the planner for case 2**

In `src/commands/create.ts`, replace the final `not-on-stack` return in `planCreate` with auto-init resolution:

```ts
  // Not in a stack — try auto-init from the base branch.
  let defaultBranch: string;
  try {
    defaultBranch = await detectDefaultBranch(dir);
  } catch (err) {
    return {
      ok: false,
      error: "not-on-stack",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (current !== defaultBranch) {
    return {
      ok: false,
      error: "not-on-stack",
      message:
        `current branch "${current}" is not part of a stack and is not the base branch ("${defaultBranch}"); run \`init\` or switch branches`,
    };
  }

  const stackName = opts.stackName ?? opts.branch;
  const mergeStrategy: MergeStrategy = opts.mergeStrategy ?? "merge";

  const existingStackBase = await gitConfig(
    dir,
    `stack.${stackName}.base-branch`,
  );
  if (existingStackBase !== undefined) {
    return {
      ok: false,
      error: "stack-exists",
      message:
        `stack "${stackName}" already exists (stack.${stackName}.base-branch is set); choose a different --stack-name`,
    };
  }

  const worktreeCase = opts.createWorktree !== undefined;

  return {
    ok: true,
    plan: {
      case: worktreeCase ? "auto-init-worktree" : "auto-init",
      branch: opts.branch,
      parent: defaultBranch,
      baseBranch: defaultBranch,
      stackName,
      mergeStrategy,
      willCommit: opts.message !== undefined,
      worktreePath: worktreeCase
        ? `${opts.createWorktree}/${opts.branch}`
        : undefined,
    },
  };
```

- [ ] **Step 4.4: Extend the executor for case 2**

Replace the "case 2 and 3 not yet implemented" return in `executeCreate` with case-2 handling:

```ts
  if (plan.case === "auto-init") {
    const checkout = await runGitOrFail(dir, "checkout", "-b", plan.branch);
    if (!checkout.ok) {
      return { ok: false, error: "git-failed", message: checkout.message };
    }

    if (opts.message !== undefined) {
      const commit = await runGitCommand(dir, "commit", "-m", opts.message);
      if (commit.code !== 0) {
        const stderr = (commit.stderr || commit.stdout).toLowerCase();
        if (
          stderr.includes("nothing to commit") ||
          stderr.includes("no changes added")
        ) {
          return {
            ok: false,
            error: "nothing-staged",
            message: "nothing staged; stage changes before using -m",
          };
        }
        return {
          ok: false,
          error: "git-failed",
          message: (commit.stderr || commit.stdout).trim(),
        };
      }
    }

    const writes: Array<[string, string]> = [
      [`branch.${plan.branch}.stack-name`, plan.stackName],
      [`branch.${plan.branch}.stack-parent`, plan.baseBranch],
      [`stack.${plan.stackName}.base-branch`, plan.baseBranch],
      [`stack.${plan.stackName}.merge-strategy`, plan.mergeStrategy],
    ];
    for (const [key, value] of writes) {
      const r = await runGitOrFail(dir, "config", key, value);
      if (!r.ok) {
        return { ok: false, error: "git-failed", message: r.message };
      }
    }

    return { ok: true, plan };
  }

  // Case 3 added in the next task.
  return {
    ok: false,
    error: "git-failed",
    message: `case ${plan.case} not yet implemented`,
  };
```

Note: the `"auto-init-worktree"` plan case must not reach the executor yet; case-2 tests never set `createWorktree`, so the existing ones pass. The case-3 task below wires up the worktree executor and removes the final "not yet implemented" branch.

- [ ] **Step 4.5: Run tests**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts`
Expected: PASS for all prior tests plus the new case-2 tests.

- [ ] **Step 4.6: Commit**

```bash
git add src/commands/create.ts src/commands/create.test.ts
git commit -m "feat(create): implement case 2 (auto-init in-repo)"
```

---

## Task 5: Case 3 — auto-init + worktree

**Files:**
- Modify: `src/commands/create.ts`
- Modify: `src/commands/create.test.ts`

Handles the two worktree flows (with and without `-m`). Without `-m`, uses `git worktree add -b` to create the branch and worktree in one step. With `-m`, checks out the branch locally, commits, returns to base, then runs `git worktree add` against the now-existing branch.

- [ ] **Step 5.1: Write the failing tests**

Append to `src/commands/create.test.ts`:

```ts
describe("create — case 3 (auto-init worktree)", () => {
  let repo: TestRepo;
  let worktreeRoot: string;

  beforeEach(async () => {
    repo = await createTestRepo();
    worktreeRoot = await Deno.makeTempDir({ prefix: "stacked-prs-wt-" });
  });

  afterEach(async () => {
    await repo.cleanup();
    await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
  });

  test("creates worktree without -m; main stays checked out", async () => {
    const result = await create(repo.dir, {
      branch: "feat/a",
      createWorktree: worktreeRoot,
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.case).toBe("auto-init-worktree");
    expect(result.plan?.worktreePath).toBe(`${worktreeRoot}/feat/a`);

    expect(await runGit(repo.dir, "branch", "--show-current")).toBe("main");

    const worktreeBranch = await runGit(
      `${worktreeRoot}/feat/a`,
      "branch",
      "--show-current",
    );
    expect(worktreeBranch).toBe("feat/a");

    expect(
      await runGit(repo.dir, "config", "branch.feat/a.stack-name"),
    ).toBe("feat/a");
  });

  test("creates worktree with -m; commit lands on new branch", async () => {
    await Deno.writeTextFile(`${repo.dir}/staged.txt`, "hi\n");
    await runGit(repo.dir, "add", "staged.txt");

    const result = await create(repo.dir, {
      branch: "feat/a",
      message: "add staged",
      createWorktree: worktreeRoot,
    });
    expect(result.ok).toBe(true);

    expect(await runGit(repo.dir, "branch", "--show-current")).toBe("main");

    const log = await runGit(
      `${worktreeRoot}/feat/a`,
      "log",
      "--format=%s",
      "-n",
      "1",
    );
    expect(log).toBe("add staged");

    // main never picked up the commit.
    const mainLog = await runGit(
      repo.dir,
      "log",
      "main",
      "--format=%s",
      "-n",
      "1",
    );
    expect(mainLog).not.toBe("add staged");
  });

  test("supports branch names with slashes", async () => {
    const result = await create(repo.dir, {
      branch: "wyattjoh/feat/colors",
      createWorktree: worktreeRoot,
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.worktreePath).toBe(
      `${worktreeRoot}/wyattjoh/feat/colors`,
    );

    const stat = await Deno.stat(
      `${worktreeRoot}/wyattjoh/feat/colors/README.md`,
    );
    expect(stat.isFile).toBe(true);
  });

  test("rejects when worktree target already exists", async () => {
    await Deno.mkdir(`${worktreeRoot}/feat/a`, { recursive: true });
    const result = await create(repo.dir, {
      branch: "feat/a",
      createWorktree: worktreeRoot,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("worktree-exists");
  });
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts`
Expected: FAIL — case-3 path still returns "not yet implemented".

- [ ] **Step 5.3: Pre-check worktree target existence in planner**

In `planCreate`, after resolving `worktreeCase` but before returning, add:

```ts
  if (worktreeCase) {
    const worktreePath = `${opts.createWorktree}/${opts.branch}`;
    try {
      await Deno.stat(worktreePath);
      return {
        ok: false,
        error: "worktree-exists",
        message: `worktree path already exists: ${worktreePath}`,
      };
    } catch {
      // Does not exist — good.
    }
  }
```

Place this immediately before the final `return { ok: true, plan: ... }`.

- [ ] **Step 5.4: Add the case-3 executor branch**

Replace the "case 3 added in the next task" return in `executeCreate` with:

```ts
  if (plan.case === "auto-init-worktree") {
    if (!plan.worktreePath) {
      return {
        ok: false,
        error: "git-failed",
        message: "internal: auto-init-worktree plan missing worktreePath",
      };
    }

    if (opts.message !== undefined) {
      // Commit staged work on the new branch in the main worktree, then
      // return to base and eject the new branch into its own worktree.
      const checkout = await runGitOrFail(dir, "checkout", "-b", plan.branch);
      if (!checkout.ok) {
        return { ok: false, error: "git-failed", message: checkout.message };
      }
      const commit = await runGitCommand(dir, "commit", "-m", opts.message);
      if (commit.code !== 0) {
        const stderr = (commit.stderr || commit.stdout).toLowerCase();
        if (
          stderr.includes("nothing to commit") ||
          stderr.includes("no changes added")
        ) {
          return {
            ok: false,
            error: "nothing-staged",
            message: "nothing staged; stage changes before using -m",
          };
        }
        return {
          ok: false,
          error: "git-failed",
          message: (commit.stderr || commit.stdout).trim(),
        };
      }
      const back = await runGitOrFail(dir, "checkout", "-");
      if (!back.ok) {
        return { ok: false, error: "git-failed", message: back.message };
      }
      const addWt = await runGitOrFail(
        dir,
        "worktree",
        "add",
        plan.worktreePath,
        plan.branch,
      );
      if (!addWt.ok) {
        return { ok: false, error: "git-failed", message: addWt.message };
      }
    } else {
      const addWt = await runGitOrFail(
        dir,
        "worktree",
        "add",
        plan.worktreePath,
        "-b",
        plan.branch,
      );
      if (!addWt.ok) {
        return { ok: false, error: "git-failed", message: addWt.message };
      }
    }

    const writes: Array<[string, string]> = [
      [`branch.${plan.branch}.stack-name`, plan.stackName],
      [`branch.${plan.branch}.stack-parent`, plan.baseBranch],
      [`stack.${plan.stackName}.base-branch`, plan.baseBranch],
      [`stack.${plan.stackName}.merge-strategy`, plan.mergeStrategy],
    ];
    for (const [key, value] of writes) {
      const r = await runGitOrFail(dir, "config", key, value);
      if (!r.ok) {
        return { ok: false, error: "git-failed", message: r.message };
      }
    }

    return { ok: true, plan };
  }

  return {
    ok: false,
    error: "git-failed",
    message: `internal: unknown plan case ${plan.case}`,
  };
```

- [ ] **Step 5.5: Run tests**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/create.test.ts`
Expected: PASS for all case-1, case-2, and case-3 tests.

- [ ] **Step 5.6: Commit**

```bash
git add src/commands/create.ts src/commands/create.test.ts
git commit -m "feat(create): implement case 3 (auto-init worktree)"
```

---

## Task 6: CLI wiring + TTY prompt

**Files:**
- Modify: `src/cli.ts`

Registers the `create` subcommand, prompts on TTY unless `--force`, and prints text or JSON.

- [ ] **Step 6.1: Add imports**

Near the top of `src/cli.ts` (next to the other command imports), add:

```ts
import {
  create as createBranch,
  type CreatePlan,
  planCreate,
} from "./commands/create.ts";
```

- [ ] **Step 6.2: Add the `create` command registration**

Insert between the `status` and `restack` command blocks (after line 231's closing `})` for the status action):

```ts
  // --- create ---
  .command("create <branch:string>", "Create a new branch in the stack")
  .option(
    "-m, --message <msg:string>",
    "Commit staged changes onto the new branch",
  )
  .option(
    "--create-worktree <dir:string>",
    "Place the new branch in a worktree at <dir>/<branch> (base branch only)",
  )
  .option("--stack-name <name:string>", "Auto-init only: stack name")
  .option(
    "--merge-strategy <strategy:string>",
    "Auto-init only: merge or squash",
  )
  .option("--force", "Skip the TTY confirmation prompt")
  .option("--dry-run", "Print plan without touching git or config")
  .option("--json", "Output as JSON")
  .action(async (options, branch: string) => {
    const mergeStrategy =
      options.mergeStrategy === "merge" || options.mergeStrategy === "squash"
        ? options.mergeStrategy
        : undefined;
    if (options.mergeStrategy !== undefined && mergeStrategy === undefined) {
      console.error(
        `invalid --merge-strategy: expected "merge" or "squash", got "${options.mergeStrategy}"`,
      );
      Deno.exit(1);
    }

    const baseOpts = {
      branch,
      message: options.message,
      createWorktree: options.createWorktree,
      stackName: options.stackName,
      mergeStrategy,
    };

    if (options.dryRun) {
      const result = await planCreate(dir, baseOpts);
      if (options.json) {
        console.log(
          JSON.stringify(
            { ok: result.ok, dryRun: true, plan: result.plan, error: result.error, message: result.message },
            null,
            2,
          ),
        );
      } else if (result.ok && result.plan) {
        console.log(renderCreatePlan(result.plan));
      } else {
        console.error(`${result.error}: ${result.message ?? ""}`);
      }
      if (!result.ok) Deno.exit(1);
      return;
    }

    const plan = await planCreate(dir, baseOpts);
    if (!plan.ok || !plan.plan) {
      if (options.json) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.error(`${plan.error}: ${plan.message ?? ""}`);
      }
      Deno.exit(1);
    }

    if (!options.force && Deno.stdin.isTerminal()) {
      console.log(renderCreatePlan(plan.plan));
      const answer = prompt("Proceed? [y/N]");
      if (answer?.trim().toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }

    const result = await createBranch(dir, baseOpts);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok && result.plan) {
      const where = result.plan.worktreePath
        ? ` (worktree: ${result.plan.worktreePath})`
        : "";
      console.log(
        `Created ${result.plan.branch} (stack: ${result.plan.stackName}, parent: ${result.plan.parent})${where}`,
      );
    } else {
      console.error(`${result.error}: ${result.message ?? ""}`);
    }
    if (!result.ok) Deno.exit(1);
  })
```

And near the top-level helper section (above the `await new Command()` chain, next to `resolveStackName`), add:

```ts
function renderCreatePlan(plan: CreatePlan): string {
  const lines = [
    `Plan: ${plan.case}`,
    `  branch:         ${plan.branch}`,
    `  parent:         ${plan.parent}`,
    `  base branch:    ${plan.baseBranch}`,
    `  stack name:     ${plan.stackName}`,
    `  merge strategy: ${plan.mergeStrategy}`,
    `  commit staged:  ${plan.willCommit ? "yes" : "no"}`,
  ];
  if (plan.worktreePath) {
    lines.push(`  worktree:       ${plan.worktreePath}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 6.3: Verify type check and lint**

Run: `deno task check`
Expected: PASS.

- [ ] **Step 6.4: Smoke-test the CLI**

Run in a throwaway git repo:

```bash
cd $(mktemp -d) && git init --initial-branch=main && git commit --allow-empty -m init
deno run --allow-run=git,gh --allow-env --allow-read --allow-write \
  $OLDPWD/src/cli.ts create feat/demo --force
git branch --show-current  # expected: feat/demo
git config branch.feat/demo.stack-name  # expected: feat/demo
```

Then clean up: `rm -rf .`.

- [ ] **Step 6.5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): wire up create subcommand with TTY prompt"
```

---

## Task 7: Rename `clean --confirm` to `--force`

**Files:**
- Modify: `src/cli.ts`

`cli.ts clean` is the only `--confirm` consumer. Keep the flag semantics identical: without it, TTY prompts and non-TTY errors out; with it, apply directly.

- [ ] **Step 7.1: Rename in the clean command registration**

In `src/cli.ts`, replace the `.option("--confirm", ...)` line (currently around line 369) with:

```ts
    .option(
      "--force",
      "Apply cleanups without prompting (for non-interactive use)",
    )
```

- [ ] **Step 7.2: Rename `options.confirm` references**

In the `clean` command's action, replace every `options.confirm` with `options.force`. Affected lines (based on current HEAD):

- Line ~378: `if (options.json && !options.confirm) {` → `!options.force`
- Line ~451: `if (!options.confirm) {` → `!options.force`
- Line ~454: user-facing message `"Cannot prompt in non-interactive mode. Pass --confirm to apply, or --json to inspect."` → `Pass --force to apply, or --json to inspect.`

- [ ] **Step 7.3: Verify type check**

Run: `deno task check`
Expected: PASS.

- [ ] **Step 7.4: Smoke-test clean**

Run in a repo with a stale config entry (or just confirm the help text):

```bash
deno run --allow-run=git,gh --allow-env --allow-read src/cli.ts clean --help | grep force
```

Expected: `--force` appears in the output and `--confirm` does not.

- [ ] **Step 7.5: Commit**

```bash
git add src/cli.ts
git commit -m "refactor(cli): rename clean --confirm to --force"
```

---

## Task 8: Update `skills/stacked-prs/SKILL.md`

**Files:**
- Modify: `skills/stacked-prs/SKILL.md`

Replace the SKILL-orchestrated `create` runbook with a pointer to the CLI, add `create` to the Scripts section, and rename `--confirm` to `--force` in the `clean` section.

- [ ] **Step 8.1: Replace the `create` runbook**

In `skills/stacked-prs/SKILL.md`, locate the `### create` subsection (starting around line 166). Replace its numbered list (steps 1-7) with:

```markdown
### `create`

Create a new child branch off the current branch. Backed by
`cli.ts create <branch>`.

**Before invoking**, apply the independent-branch rule from "Building
Review-Ready Stacks": confirm the new branch's intended scope is
self-contained and would not leave the current (parent) branch in a
CI-failing state. If the user's plan would violate the rule, flag it
and suggest a better split.

Invoke the CLI:

```bash
deno run --allow-run=git,gh --allow-env --allow-read --allow-write \
  ${CLAUDE_PLUGIN_ROOT}/src/cli.ts create <branch> \
  [-m <message>] [--create-worktree <dir>] \
  [--stack-name <name>] [--merge-strategy merge|squash] \
  [--force] [--dry-run] [--json]
```

The CLI resolves the create case automatically:

- **Child branch**: when the current branch is already in a stack.
- **Auto-init from base**: when the current branch is the repo's
  default branch. A new stack is registered (default name: the new
  branch name; default merge strategy: `merge`).
- **Auto-init + worktree**: same as auto-init, but the new branch
  lives in a worktree at `<dir>/<branch>` and the current repo stays
  on the base branch. Only valid from the base branch.

Pass `--force` to skip the CLI's TTY confirmation prompt.
```

- [ ] **Step 8.2: Rename `clean` flag references**

In the `### clean` subsection and the Scripts block, replace every `--confirm` with `--force`. Specific lines (current HEAD):

- Line ~486: `--confirm` in prose about `legacy-merged-flag` → `--force`
- Line ~489: `**Flags:** \`--stack-name=<name>\`, \`--confirm\`, \`--json\`` → `--force`
- Line ~498: `5. Run \`cli.ts clean [--stack-name=<name>] --confirm\` to apply.` → `--force`
- Line ~628: `- \`deno run ... cli.ts clean --json\` (report-only; \`--confirm\` mutates)` → `--force mutates`
- Line ~745: Scripts example `[--confirm]` → `[--force]`
- Line ~752: `Pass \`--confirm\` for non-interactive use.` → `Pass \`--force\` for non-interactive use.`

- [ ] **Step 8.3: Add `create` to Scripts section**

In the Scripts section of `skills/stacked-prs/SKILL.md`, insert a new subsection (alphabetical placement; before `### import-discover`):

```markdown
### `create`

```bash
deno run --allow-run=git,gh --allow-env --allow-read --allow-write ${CLAUDE_PLUGIN_ROOT}/src/cli.ts create <branch> \
  [-m <message>] [--create-worktree <dir>] \
  [--stack-name <name>] [--merge-strategy merge|squash] \
  [--force] [--dry-run] [--json]
```

Creates a new branch in the stack off the current branch. Auto-resolves
between child-in-stack, auto-init, and auto-init-with-worktree based on
the current branch's git config. Prints a plan and prompts on TTY
unless `--force` is passed. `--dry-run` reports the plan without
mutating anything.
```

- [ ] **Step 8.4: Verify plugin validation still passes**

Run from the repo root:

```bash
claude plugin validate .
```

Expected: success (no manifest or skill-file issues).

- [ ] **Step 8.5: Commit**

```bash
git add skills/stacked-prs/SKILL.md
git commit -m "docs(skill): add create CLI section and rename clean --force"
```

---

## Task 9: Update `CLAUDE.md` and `README.md`

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 9.1: Update `CLAUDE.md` file layout**

In `CLAUDE.md`, in the file-layout tree under `src/commands/`, add a line for `create.ts`. The block currently lists `clean.ts`, `config.ts`, `status.ts`, etc. Insert between `config.ts` and `status.ts` (alphabetical):

```
│   ├── create.ts               # Branch creation: child / auto-init / auto-init + worktree
```

- [ ] **Step 9.2: Add `create` to the subcommand list**

Find the line in `CLAUDE.md` starting "Subcommands: `status` (add `-i`..." and append `create`:

```
Subcommands: `status` (add `-i`/`--interactive` to launch the TUI), `create`,
`restack`, `nav`, `verify-refs`, `import-discover`, `submit-plan`, `land`,
`clean`.
```

- [ ] **Step 9.3: Add a row to the "Script roles" table**

In the table listing command-file roles, add between `clean.ts` and `config.ts`:

```
| `src/commands/create.ts`          | Branch creation with optional worktree                                       | `cli.ts create <branch> [flags]`                                        |
```

- [ ] **Step 9.4: Update the README if it mentions `clean --confirm`**

Run:

```bash
grep -n "\-\-confirm" README.md
```

For any match, replace `--confirm` with `--force`. If the README does not mention `create` in the sub-commands list, add a short bullet under the user-facing commands section:

```markdown
- `create <branch>` — create a new branch in the stack off the current branch.
  Auto-inits when run from the repo's default branch; supports
  `--create-worktree <dir>` to eject the new branch into a git worktree.
```

- [ ] **Step 9.5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document create subcommand and --force rename"
```

---

## Task 10: Final verification

- [ ] **Step 10.1: Run the full test suite**

Run: `deno task test`
Expected: all tests pass.

- [ ] **Step 10.2: Run type check and lint**

Run: `deno task check`
Expected: PASS.

- [ ] **Step 10.3: Reinstall the global binary**

Run: `deno task install`
Expected: the `stacked-prs` binary installs into `~/.deno/bin` (or the mise Deno bin dir). The user's daily-driver flow runs the installed binary from other repos.

- [ ] **Step 10.4: Smoke-test the installed binary**

In a scratch repo:

```bash
cd $(mktemp -d) && git init --initial-branch=main && \
  git commit --allow-empty -m init

stacked-prs create feat/demo --force
stacked-prs status --json | head -20

stacked-prs create feat/demo-child --force
# Expect: feat/demo-child is a child of feat/demo in the stack.

stacked-prs create feat/demo-wt --create-worktree /tmp/sp-wt --force
# Expect: current branch is "main" (actually feat/demo-child; see note),
# a worktree exists at /tmp/sp-wt/feat/demo-wt.
```

Note: the third command will error with `worktree-requires-base` because the current branch (`feat/demo-child`) is in a stack. Switch back to main first: `git checkout main` before running it.

Clean up: `rm -rf /tmp/sp-wt`.

- [ ] **Step 10.5: Final commit** (only if docs or any files still have uncommitted tweaks)

```bash
git status
# If clean, nothing to do.
# Otherwise:
git add -A && git commit -m "chore: final verification tweaks"
```

---

## Self-Review Notes

Items checked against the spec:

- CLI surface flags (`<branch>`, `-m`, `--create-worktree`, `--stack-name`, `--merge-strategy`, `--force`, `--dry-run`, `--json`): Task 6.
- Three cases with precise end-of-command states: Tasks 3, 4, 5.
- All nine error codes tested (`invalid-branch-name`, `branch-exists`, `not-on-stack`, `worktree-requires-base`, `worktree-exists`, `flag-misuse`, `stack-exists`, `nothing-staged`, `git-failed`): covered in Task 3, 4, 5 test blocks.
- `detectDefaultBranch` helper (origin/HEAD → main → master → error): Task 1.
- `--confirm` → `--force` rename on `clean`: Task 7 (code) + Task 8 (SKILL.md).
- SKILL.md `create` runbook replaced with CLI pointer: Task 8.
- `CLAUDE.md` / `README.md` updates: Task 9.
- TTY prompt in CLI layer, not in `executeCreate`: Task 6 (enforced by separation of `planCreate` from `executeCreate`).
- Breaking-change documentation: Task 7 commit message notes the rename; release-please will surface it in the changelog via the `refactor(cli):` type. (If stricter signalling is desired, change the commit type to `feat(cli)!:` to trigger a minor bump and a BREAKING CHANGE note — outside this plan's scope.)
