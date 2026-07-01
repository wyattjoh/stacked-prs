# Archive a Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user mark a stack as archived so it retains all git-config metadata but is hidden by default from `status`, the TUI, and `serve`, and skipped by `sync`, with an opt-in reveal on each surface.

**Architecture:** A new stack-level git-config key `stack.<name>.archived` is the single source of truth. `getStackTree` populates a new `StackTree.archived` field, which flows through `StackStatus` / the serve payload to every consumer. A new `archive` command toggles the key. Each viewing surface filters archived stacks by default and offers a reveal (`--archived` CLI flag, `a` key in the TUI, "Show archived" switch in serve).

**Tech Stack:** Deno + TypeScript, `@cliffy/command` (CLI router), Ink + React (TUI), Hono + vanilla JS (serve), `@std/testing/bdd` + `@std/expect` (tests).

## Global Constraints

- All scripts are Deno TypeScript with explicit permissions. No bash scripts.
- Command functions in `src/commands/` are pure: no `Deno.args`, no `console.log`, no `Deno.exit`. They take typed options and return structured results. `cli.ts` owns all I/O.
- `src/lib/` holds shared libraries with no CLI entry points. `src/commands/` holds one file per subcommand. `cli.ts` is the only entry point.
- Human-readable CLI output follows `.claude/rules/output-style.md`: glyphs `→ · ⚠ ✓ ✗ -`, `Stack: <name> (base: <base>)` headers, `Nothing to do.` no-ops. `--json` output is a structured dump only, never mixed with status text.
- Tests use `await using repo = await createTestRepo()` for temp git state (per `.claude/rules/testing.md`); no `beforeEach`/`afterEach` shared state. Module-scope helpers for shared setup.
- Ink test gotcha: every `ink-testing-library` render must destructure and call `unmount()` before the test returns. (Not needed for pure reducer/layout tests.)
- No em dashes anywhere (comments, commit messages, docs). Use commas or parentheses.
- Test allow-flags: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write <file>`.
- Commits that touch `skills/**` use `feat:`. Pure repo docs (`README.md`, `CLAUDE.md`, this plan) use `docs:`.
- Each commit message ends with a trailing line: `Claude-Session: https://claude.ai/code/session_01S6QK66Qo2k6tEVtHxcAwGw` (blank line before it).

## Implementation note discovered during planning

The non-interactive `status` output renders a compact tree graph with **no
per-stack `Stack: <name>` header** (that header format belongs to the plan
renderers like `init`/`create`, not `status`). So for non-interactive `status`,
archived stacks are **filtered** (hidden by default, shown with `--archived`)
but get **no inline `(archived)` text marker** in the compact graph. The
`(archived)` visual marker and dimming apply to the **TUI** (which has per-stack
headers) and **serve** (which has a switcher and lane headers). The `--json`
output always includes all stacks, each carrying the `archived` boolean, so
machine consumers can distinguish them.

---

## File Structure

- `src/lib/stack.ts` (modify): add `getStackArchived` / `setStackArchived`, add `archived` to `StackTree`, populate it in `getStackTree`, remove the key in `clearStackConfig`.
- `src/lib/stack.test.ts` (modify): round-trip + tree-population + cleanup tests.
- `src/commands/archive.ts` (create): pure `archiveStack` command function.
- `src/commands/archive.test.ts` (create): command tests.
- `src/cli.ts` (modify): register `archive`; add `--archived` to `status` and `sync`; pass `showArchived` to TUI app and `getAllStackStatuses`.
- `src/commands/sync.ts` (modify): skip archived stacks unless `--archived`; report skips in the plan.
- `src/commands/sync.test.ts` (modify): archived-skip tests.
- `src/commands/status.ts` (modify): add `archived` to `StackStatus`; filter display by `showArchived` in `getAllStackStatuses`.
- `src/commands/status.test.ts` (modify): filter + flag tests.
- `src/tui/types.ts` (modify): add `showArchived` + `allTrees` to `State`; add `ARCHIVED_TOGGLE` action.
- `src/tui/state/reducer.ts` (modify): filter trees + rebuild grid on load and toggle.
- `src/tui/state/reducer.test.ts` (modify): toggle tests.
- `src/tui/app.tsx` (modify): `a` keybind, `showArchived` prop, dispatch toggle.
- `src/tui/components/stack-map.tsx` (modify): dim + `(archived)` marker on archived stack headers.
- `src/tui/components/help-overlay.tsx` (modify): add `a` to status bar / help.
- `src/commands/serve.client.js` (modify): track archived in model, toggle switch, dim/badge, localStorage.
- `src/commands/serve.test.ts` (modify): payload carries `archived`.
- `skills/stacked-prs/SKILL.md`, `README.md`, `CLAUDE.md` (modify): docs.

---

## Task 1: Archived config helpers + `StackTree.archived`

**Files:**
- Modify: `src/lib/stack.ts`
- Test: `src/lib/stack.test.ts`

**Interfaces:**
- Produces:
  - `getStackArchived(dir: string, stackName: string): Promise<boolean>`
  - `setStackArchived(dir: string, stackName: string, archived: boolean): Promise<void>`
  - `StackTree.archived: boolean` (new required field on the existing interface)

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/stack.test.ts`. Import `getStackArchived`, `setStackArchived`, `getStackTree`, `clearStackConfig`, `setStackNode`, `setBaseBranch` (add any missing names to the existing import block at the top of the file), plus `addBranch` (already imported).

```ts
describe("archived flag", () => {
  test("defaults to false when unset", async () => {
    await using repo = await createTestRepo();
    expect(await getStackArchived(repo.dir, "s")).toBe(false);
  });

  test("set true then read true, unset returns false", async () => {
    await using repo = await createTestRepo();
    await setStackArchived(repo.dir, "s", true);
    expect(await getStackArchived(repo.dir, "s")).toBe(true);
    await setStackArchived(repo.dir, "s", false);
    expect(await getStackArchived(repo.dir, "s")).toBe(false);
  });

  test("getStackTree populates archived", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");

    let tree = await getStackTree(repo.dir, "s");
    expect(tree.archived).toBe(false);

    await setStackArchived(repo.dir, "s", true);
    tree = await getStackTree(repo.dir, "s");
    expect(tree.archived).toBe(true);
  });

  test("clearStackConfig removes the archived key", async () => {
    await using repo = await createTestRepo();
    await setStackArchived(repo.dir, "s", true);
    await clearStackConfig(repo.dir, "s");
    expect(await getStackArchived(repo.dir, "s")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts`
Expected: FAIL (e.g. `getStackArchived is not a function` / `archived` undefined).

- [ ] **Step 3: Implement in `src/lib/stack.ts`**

Add the helpers right after `setBaseBranch` (around line 562). `gitConfigSet` and `gitConfig` are already defined in this file.

```ts
/** Read whether a stack is archived. True only when the key is exactly "true". */
export async function getStackArchived(
  dir: string,
  stackName: string,
): Promise<boolean> {
  return (await gitConfig(dir, `stack.${stackName}.archived`)) === "true";
}

/** Archive or unarchive a stack. Unarchiving unsets the key entirely. */
export async function setStackArchived(
  dir: string,
  stackName: string,
  archived: boolean,
): Promise<void> {
  const key = `stack.${stackName}.archived`;
  if (archived) {
    await gitConfigSet(dir, key, "true");
    return;
  }
  // Tolerate exit 5 ("key absent"); any other non-zero is a real failure.
  const { code, stderr } = await runGitCommand(dir, "config", "--unset", key);
  if (code !== 0 && code !== 5) {
    throw new Error(`git config --unset ${key} failed: ${stderr}`);
  }
}
```

Add `archived` to the `StackTree` interface (around line 374):

```ts
export interface StackTree {
  stackName: string;
  baseBranch: string;
  mergeStrategy: MergeStrategy | undefined;
  archived: boolean;
  roots: StackNode[];
}
```

In `getStackTree`, read the flag alongside `mergeStrategy` (after line 678):

```ts
  const mergeStrategy = await getMergeStrategy(dir, resolvedStackName);
  const archived = await getStackArchived(dir, resolvedStackName);
```

Add it to the returned object (around line 823):

```ts
  return {
    stackName: resolvedStackName,
    baseBranch,
    mergeStrategy,
    archived,
    roots: [...legacyTombstones, ...roots],
  };
```

In `clearStackConfig`, add the key to `singleValueKeys` (around line 574):

```ts
  const singleValueKeys = [
    `stack.${stackName}.base-branch`,
    `stack.${stackName}.merge-strategy`,
    `stack.${stackName}.resume-state`,
    `stack.${stackName}.color`,
    `stack.${stackName}.archived`,
  ];
```

- [ ] **Step 4: Fix the other `StackTree` literal in `status.ts`**

`getAllStackStatuses` builds a synthetic `combinedTree: StackTree` (around `src/commands/status.ts:509`). Adding a required field breaks `deno check`. Add `archived: false` to that literal:

```ts
      const combinedTree: StackTree = {
        stackName: `base:${baseBranch}`,
        baseBranch,
        mergeStrategy: undefined,
        archived: false,
        roots: group.flatMap((stack) =>
          treeByStackName.get(stack.stackName)?.roots ?? []
        ),
      };
```

(Search the whole repo for other `: StackTree = {` literals and add `archived: false` to any that the type checker flags. Run `deno check src/cli.ts` to find them.)

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts && deno check src/cli.ts`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stack.ts src/lib/stack.test.ts src/commands/status.ts
git commit -m "$(cat <<'EOF'
feat: add archived flag to stack config and StackTree

Claude-Session: https://claude.ai/code/session_01S6QK66Qo2k6tEVtHxcAwGw
EOF
)"
```

---

## Task 2: `archive` command + CLI registration

**Files:**
- Create: `src/commands/archive.ts`
- Create: `src/commands/archive.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `getStackArchived`, `setStackArchived`, `listAllStacks` from `../lib/stack.ts`; `runGitCommand` for current-branch resolution.
- Produces:
  - `interface ArchiveOptions { stackName?: string; unarchive?: boolean }`
  - `interface ArchiveResult { stackName: string; archived: boolean; changed: boolean }`
  - `archiveStack(dir: string, options: ArchiveOptions): Promise<ArchiveResult>`

- [ ] **Step 1: Write the failing tests**

Create `src/commands/archive.test.ts`:

```ts
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo, runGit } from "../lib/testdata/helpers.ts";
import {
  getStackArchived,
  setBaseBranch,
  setStackArchived,
  setStackNode,
} from "../lib/stack.ts";
import { archiveStack } from "./archive.ts";

async function makeStack(dir: string, name: string, branch: string) {
  await addBranch(dir, branch, "main");
  await setBaseBranch(dir, name, "main");
  await setStackNode(dir, branch, name, "main");
}

describe("archiveStack", () => {
  test("archives a named stack", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");

    const result = await archiveStack(repo.dir, { stackName: "s" });
    expect(result).toEqual({ stackName: "s", archived: true, changed: true });
    expect(await getStackArchived(repo.dir, "s")).toBe(true);
  });

  test("archiving an already-archived stack is a no-op", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");
    await setStackArchived(repo.dir, "s", true);

    const result = await archiveStack(repo.dir, { stackName: "s" });
    expect(result).toEqual({ stackName: "s", archived: true, changed: false });
  });

  test("unarchives a named stack", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");
    await setStackArchived(repo.dir, "s", true);

    const result = await archiveStack(repo.dir, {
      stackName: "s",
      unarchive: true,
    });
    expect(result).toEqual({ stackName: "s", archived: false, changed: true });
    expect(await getStackArchived(repo.dir, "s")).toBe(false);
  });

  test("resolves the stack from the current branch when no name given", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await archiveStack(repo.dir, {});
    expect(result.stackName).toBe("s");
    expect(result.archived).toBe(true);
  });

  test("throws for an unknown stack name", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");

    await expect(archiveStack(repo.dir, { stackName: "nope" })).rejects
      .toThrow("Unknown stack: nope");
  });

  test("throws when current branch is not in a stack", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");
    await runGit(repo.dir, "checkout", "main");

    await expect(archiveStack(repo.dir, {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/archive.test.ts`
Expected: FAIL (`Cannot find module ./archive.ts` / `archiveStack is not a function`).

- [ ] **Step 3: Implement `src/commands/archive.ts`**

```ts
import {
  getStackArchived,
  listAllStacks,
  runGitCommand,
  setStackArchived,
} from "../lib/stack.ts";

export interface ArchiveOptions {
  /** Stack to (un)archive. Defaults to the current branch's stack. */
  stackName?: string;
  /** Clear the archived flag instead of setting it. */
  unarchive?: boolean;
}

export interface ArchiveResult {
  stackName: string;
  /** The resulting archived state after the call. */
  archived: boolean;
  /** Whether a config write actually occurred (false when already in state). */
  changed: boolean;
}

async function resolveStackName(
  dir: string,
  explicit?: string,
): Promise<string> {
  if (explicit) {
    const known = await listAllStacks(dir);
    if (!known.includes(explicit)) {
      throw new Error(`Unknown stack: ${explicit}`);
    }
    return explicit;
  }

  const { code, stdout } = await runGitCommand(dir, "branch", "--show-current");
  if (code !== 0 || !stdout) {
    throw new Error(
      "Could not detect the current branch. Pass a stack name explicitly.",
    );
  }
  const { code: cfgCode, stdout: name } = await runGitCommand(
    dir,
    "config",
    `branch.${stdout}.stack-name`,
  );
  if (cfgCode !== 0 || !name) {
    throw new Error(
      `Branch ${stdout} is not part of a stack. Pass a stack name explicitly.`,
    );
  }
  return name;
}

export async function archiveStack(
  dir: string,
  options: ArchiveOptions,
): Promise<ArchiveResult> {
  const stackName = await resolveStackName(dir, options.stackName);
  const target = options.unarchive !== true;
  const current = await getStackArchived(dir, stackName);
  if (current === target) {
    return { stackName, archived: target, changed: false };
  }
  await setStackArchived(dir, stackName, target);
  return { stackName, archived: target, changed: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/archive.test.ts`
Expected: PASS (all six tests).

- [ ] **Step 5: Register the command in `src/cli.ts`**

Add the import near the other command imports (top of file, alongside the `import { ... } from "./commands/...";` block):

```ts
import { archiveStack } from "./commands/archive.ts";
```

Add the command definition. Place it next to a related command (e.g. right after the `clean` command block, or anywhere in the `.command(...)` chain). Use this exact shape:

```ts
  // --- archive ---
  .command(
    "archive [stack:string]",
    "Mark a stack as archived (hidden from status/serve and skipped by sync)",
  )
  .option("--unarchive", "Clear the archived flag instead of setting it")
  .option("--json", "Output as JSON")
  .action(async (options, stack?: string) => {
    let result;
    try {
      result = await archiveStack(dir, {
        stackName: stack,
        unarchive: options.unarchive,
      });
    } catch (err) {
      console.error((err as Error).message);
      Deno.exit(1);
    }
    if (options.json) {
      logJson(result);
      return;
    }
    if (!result.changed) {
      const state = result.archived ? "already archived" : "not archived";
      console.log(`· Stack ${result.stackName} is ${state}.`);
      return;
    }
    const verb = result.archived ? "Archived" : "Unarchived";
    console.log(`✓ ${verb} stack ${result.stackName}.`);
  })
```

(`dir` and `logJson` are already in scope in `cli.ts`; confirm by checking an existing command action.)

- [ ] **Step 6: Verify the command runs**

Run: `deno check src/cli.ts`
Expected: no type errors.

Run (manual smoke, in a repo with a stack):
```bash
deno run --allow-run=git,gh,open --allow-env --allow-read --allow-net src/cli.ts archive --help
```
Expected: help text shows `archive [stack]` with `--unarchive` and `--json`.

- [ ] **Step 7: Commit**

```bash
git add src/commands/archive.ts src/commands/archive.test.ts src/cli.ts
git commit -m "$(cat <<'EOF'
feat: add archive command to toggle stack archived state

Claude-Session: https://claude.ai/code/session_01S6QK66Qo2k6tEVtHxcAwGw
EOF
)"
```

---

## Task 3: `sync` skips archived stacks

**Files:**
- Modify: `src/commands/sync.ts`
- Modify: `src/commands/sync.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `StackTree.archived` (Task 1).
- Produces:
  - `computeSyncPlan(dir, options: { filter?: string; archived?: boolean })` (extended options).
  - `SyncPlan.archivedSkipped: string[]` (new field, names of archived stacks excluded from the plan; empty when `--archived` is passed).

- [ ] **Step 1: Write the failing tests**

Add to `src/commands/sync.test.ts` (inside the existing `describe("computeSyncPlan", ...)`). `setStackArchived` must be added to the test file's `../lib/stack.ts` import block.

```ts
  test("skips archived stacks by default and reports them", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "a/1", "main");
    await addBranch(repo.dir, "b/1", "main");
    await setupStack(repo.dir, "stack-a", [["a/1", "main"]]);
    await setupStack(repo.dir, "stack-b", [["b/1", "main"]]);
    await setStackArchived(repo.dir, "stack-b", true);
    await using _bare = await wireOrigin(repo.dir);

    const plan = await computeSyncPlan(repo.dir);
    expect(plan.stacks.map((s) => s.stackName)).toEqual(["stack-a"]);
    expect(plan.archivedSkipped).toEqual(["stack-b"]);
  });

  test("includes archived stacks when archived option is set", async () => {
    await using repo = await createTestRepo();
    await using mock = await makeMockDir();
    await writeRepoViewFixture(mock.path);
    await addBranch(repo.dir, "a/1", "main");
    await addBranch(repo.dir, "b/1", "main");
    await setupStack(repo.dir, "stack-a", [["a/1", "main"]]);
    await setupStack(repo.dir, "stack-b", [["b/1", "main"]]);
    await setStackArchived(repo.dir, "stack-b", true);
    await using _bare = await wireOrigin(repo.dir);

    const plan = await computeSyncPlan(repo.dir, { archived: true });
    expect(plan.stacks.map((s) => s.stackName).sort()).toEqual([
      "stack-a",
      "stack-b",
    ]);
    expect(plan.archivedSkipped).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/sync.test.ts`
Expected: FAIL (`archivedSkipped` undefined; `stack-b` present in stacks).

- [ ] **Step 3: Implement in `src/commands/sync.ts`**

Add the field to the `SyncPlan` interface (around line 62):

```ts
export interface SyncPlan {
  baseFastForwards: BaseFfPlan[];
  stacks: StackSyncPlan[];
  baseBranches: string[];
  isNoOp: boolean;
  filter?: string;
  filteredOut: string[];
  /** Archived stack names excluded from the plan (empty when --archived). */
  archivedSkipped: string[];
}
```

Update `computeSyncPlan` (signature + filter loop, around lines 330-345):

```ts
export async function computeSyncPlan(
  dir: string,
  options: { filter?: string; archived?: boolean } = {},
): Promise<SyncPlan> {
  const filter = options.filter;
  const includeArchived = options.archived === true;
  const allTrees = await getAllStackTrees(dir);

  const trees: StackTree[] = [];
  const filteredOut: string[] = [];
  const archivedSkipped: string[] = [];
  for (const tree of allTrees) {
    if (!includeArchived && tree.archived) {
      archivedSkipped.push(tree.stackName);
      continue;
    }
    if (stackNameMatchesFilter(tree.stackName, filter)) {
      trees.push(tree);
    } else {
      filteredOut.push(tree.stackName);
    }
  }
```

Add `archivedSkipped` to the returned object (around line 376):

```ts
  return {
    baseFastForwards,
    stacks,
    baseBranches,
    isNoOp,
    filter,
    filteredOut,
    archivedSkipped,
  };
```

Render the skip in `renderSyncPlan`. After the `if (plan.filter) {...}` block (around line 653), add:

```ts
  if (plan.archivedSkipped.length > 0) {
    lines.push(`Archived (skipped): ${plan.archivedSkipped.join(", ")}`);
    lines.push("");
  }
```

- [ ] **Step 4: Add the `--archived` flag to the sync command in `src/cli.ts`**

In the `sync` command (around line 1214), add the option:

```ts
  .option("--archived", "Include archived stacks in the sync")
```

And pass it through where `computeSyncPlan` is called (line 1236):

```ts
      const plan = await computeSyncPlan(dir, {
        filter: options.filter,
        archived: options.archived,
      });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/sync.test.ts && deno check src/cli.ts`
Expected: PASS, no type errors. (If any other call site constructs a `SyncPlan` literal in tests, add `archivedSkipped: []` to it.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/sync.ts src/commands/sync.test.ts src/cli.ts
git commit -m "$(cat <<'EOF'
feat: skip archived stacks in sync unless --archived

Claude-Session: https://claude.ai/code/session_01S6QK66Qo2k6tEVtHxcAwGw
EOF
)"
```

---

## Task 4: `status` filters archived stacks

**Files:**
- Modify: `src/commands/status.ts`
- Modify: `src/commands/status.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `StackTree.archived` (Task 1).
- Produces:
  - `StackStatus.archived: boolean` (new field).
  - `StatusOptions.showArchived?: boolean` (controls only the `display` string; `stacks[]` always contains all stacks).

- [ ] **Step 1: Write the failing tests**

Add to `src/commands/status.test.ts` (inside `describe("getAllStackStatuses", ...)`). Mirror the existing setup pattern used by the tests already in that block; they use `getAllStackStatuses(repo.dir)`. Add `setStackArchived`, `setBaseBranch`, `setStackNode` to imports if not present, and `addBranch`.

```ts
  test("includes archived stacks in stacks[] with the flag, hidden from display by default", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "a/1", "main");
    await addBranch(repo.dir, "b/1", "main");
    await setBaseBranch(repo.dir, "stack-a", "main");
    await setStackNode(repo.dir, "a/1", "stack-a", "main");
    await setBaseBranch(repo.dir, "stack-b", "main");
    await setStackNode(repo.dir, "b/1", "stack-b", "main");
    await setStackArchived(repo.dir, "stack-b", true);

    const status = await getAllStackStatuses(repo.dir);
    // stacks[] always carries every stack with its archived flag.
    const byName = new Map(status.stacks.map((s) => [s.stackName, s]));
    expect(byName.get("stack-a")?.archived).toBe(false);
    expect(byName.get("stack-b")?.archived).toBe(true);
    // display hides the archived branch by default.
    expect(status.display).toContain("a/1");
    expect(status.display).not.toContain("b/1");
  });

  test("showArchived includes archived stacks in display", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "a/1", "main");
    await addBranch(repo.dir, "b/1", "main");
    await setBaseBranch(repo.dir, "stack-a", "main");
    await setStackNode(repo.dir, "a/1", "stack-a", "main");
    await setBaseBranch(repo.dir, "stack-b", "main");
    await setStackNode(repo.dir, "b/1", "stack-b", "main");
    await setStackArchived(repo.dir, "stack-b", true);

    const status = await getAllStackStatuses(repo.dir, undefined, undefined, {
      showArchived: true,
    });
    expect(status.display).toContain("a/1");
    expect(status.display).toContain("b/1");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/status.test.ts`
Expected: FAIL (`archived` undefined; `b/1` present in default display).

- [ ] **Step 3: Implement in `src/commands/status.ts`**

Add `archived` to `StackStatus` (around line 43):

```ts
export interface StackStatus {
  stackName: string;
  baseBranch: string;
  mergeStrategy: string | undefined;
  archived: boolean;
  branches: BranchStatus[];
  display: string;
}
```

Add `showArchived` to `StatusOptions` (around line 81):

```ts
export interface StatusOptions {
  loadPrs?: boolean;
  showArchived?: boolean;
}
```

In `buildStackStatus`, include `archived` from the tree in the returned object (around line 449):

```ts
  return {
    stackName: tree.stackName,
    baseBranch: tree.baseBranch,
    mergeStrategy: tree.mergeStrategy,
    archived: tree.archived,
    branches,
    display,
  };
```

In `getAllStackStatuses`, filter the stacks used to build `display` while leaving `stacks[]` complete. Replace the section that builds `sections` and `display` (around lines 499-525) with a version that filters first:

```ts
  const showArchived = opts.showArchived === true;
  const displayStacks = showArchived
    ? stacks
    : stacks.filter((stack) => !stack.archived);

  if (displayStacks.length === 0) {
    return { stacks, display: "No stacks found." };
  }

  const sections = new Map<string, StackStatus[]>();
  for (const stack of displayStacks) {
    const group = sections.get(stack.baseBranch) ?? [];
    group.push(stack);
    sections.set(stack.baseBranch, group);
  }

  const display = [...sections.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([baseBranch, group]) => {
      const combinedTree: StackTree = {
        stackName: `base:${baseBranch}`,
        baseBranch,
        mergeStrategy: undefined,
        archived: false,
        roots: group.flatMap((stack) =>
          treeByStackName.get(stack.stackName)?.roots ?? []
        ),
      };
      const branches = group.flatMap((stack) => stack.branches);
      return renderStackDisplay(
        combinedTree,
        branches,
        colorMap,
        currentBranch,
      );
    })
    .join("\n\n");

  return { stacks, display };
```

(The earlier `if (stacks.length === 0) return { stacks, display: "No stacks found." };` guard at the top stays as-is. The new guard handles the "all remaining stacks are archived" case.)

- [ ] **Step 4: Add the `--archived` flag to the status command in `src/cli.ts`**

Add the option to the `status` command (around line 283):

```ts
  .option("--archived", "Include archived stacks (hidden by default)")
```

Pass it to `getAllStackStatuses` in `runStatus` (around line 472):

```ts
      if (statusAll) {
        return await getAllStackStatuses(dir, owner, repo, {
          loadPrs,
          showArchived: options.archived === true,
        });
      }
```

(The single-stack path is unchanged: viewing one stack explicitly always shows it. `--json` is unaffected because it dumps the full `status` object, whose `stacks[]` always contains every stack.)

- [ ] **Step 5: Run tests + typecheck**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/status.test.ts && deno check src/cli.ts`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/status.ts src/commands/status.test.ts src/cli.ts
git commit -m "$(cat <<'EOF'
feat: hide archived stacks from status unless --archived

Claude-Session: https://claude.ai/code/session_01S6QK66Qo2k6tEVtHxcAwGw
EOF
)"
```

---

## Task 5: TUI archived filter + `a` toggle

**Files:**
- Modify: `src/tui/types.ts`
- Modify: `src/tui/state/reducer.ts`
- Modify: `src/tui/state/reducer.test.ts`
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/components/stack-map.tsx`
- Modify: `src/tui/components/help-overlay.tsx`

**Interfaces:**
- Consumes: `StackTree.archived` (Task 1), `buildGrid` (existing, `src/tui/lib/layout.ts`).
- Produces:
  - `State.showArchived: boolean`, `State.allTrees: StackTree[]`.
  - Action `{ type: "ARCHIVED_TOGGLE" }`.
  - `initialState(activeTab?, showArchived?)`.

- [ ] **Step 1: Write the failing reducer tests**

First inspect `src/tui/state/reducer.test.ts` to match its existing import and `StackTree` fixture style. StackTree fixtures in that file must now include `archived`. Add this describe block (adjust the fixture helper to match how the file already builds trees/grids; the key behaviors to assert):

```ts
describe("ARCHIVED_TOGGLE", () => {
  function treeFixture(name: string, archived: boolean): StackTree {
    return {
      stackName: name,
      baseBranch: "main",
      mergeStrategy: undefined,
      archived,
      roots: [{
        branch: `${name}/1`,
        stackName: name,
        parent: "main",
        children: [],
      }],
    };
  }

  test("hides archived stacks on load, reveals them after toggle", () => {
    const trees = [treeFixture("active", false), treeFixture("old", true)];
    const loaded = reducer(initialState("all"), {
      type: "LOCAL_LOADED",
      trees,
      syncByBranch: new Map(),
      worktreeByBranch: new Map(),
      grid: buildGrid(trees, new Map()),
      colorByStack: new Map(),
      currentBranch: null,
      totalBranches: 2,
    });
    expect(loaded.trees.map((t) => t.stackName)).toEqual(["active"]);
    expect(loaded.allTrees.map((t) => t.stackName)).toEqual(["active", "old"]);

    const toggled = reducer(loaded, { type: "ARCHIVED_TOGGLE" });
    expect(toggled.showArchived).toBe(true);
    expect(toggled.trees.map((t) => t.stackName)).toEqual(["active", "old"]);
    expect(toggled.grid.byStack.has("old")).toBe(true);

    const back = reducer(toggled, { type: "ARCHIVED_TOGGLE" });
    expect(back.showArchived).toBe(false);
    expect(back.trees.map((t) => t.stackName)).toEqual(["active"]);
  });
});
```

(Import `buildGrid` from `../lib/layout.ts` and `StackTree` from `../../lib/stack.ts` in the test file if not already imported.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/tui/state/reducer.test.ts`
Expected: FAIL (`allTrees` undefined; `ARCHIVED_TOGGLE` not handled; archived stacks not filtered).

- [ ] **Step 3: Update types in `src/tui/types.ts`**

Add to the `State` interface (near `trees` at line 90):

```ts
  /** Every loaded tree, including archived. `trees` is the visible subset. */
  allTrees: StackTree[];
```

and (anywhere in `State`):

```ts
  showArchived: boolean;
```

Add the action to the `Action` union (near `HELP_TOGGLE` at line 150):

```ts
  | { type: "ARCHIVED_TOGGLE" }
```

- [ ] **Step 4: Update `src/tui/state/reducer.ts`**

Add a module-scope helper above `reducer`:

```ts
function visibleTrees(
  trees: StackTree[],
  showArchived: boolean,
): StackTree[] {
  return showArchived ? trees : trees.filter((tree) => !tree.archived);
}
```

(Import `StackTree` from `../../lib/stack.ts` at the top of the file if not already imported.)

Update `initialState` to accept and store the flag and `allTrees`:

```ts
export function initialState(
  activeTab: TabId = "all",
  showArchived = false,
): State {
  return {
    trees: [],
    allTrees: [],
    showArchived,
    syncByBranch: new Map(),
    // ... rest unchanged ...
```

In the `LOCAL_LOADED` case, filter trees and rebuild the grid when archived stacks are present. Replace the start of the case (it currently does `let activeTab = ...; const stackExists = action.trees.some(...)`) so that all tree/grid references use the visible subset:

```ts
    case "LOCAL_LOADED": {
      const allTrees = action.trees;
      const visible = visibleTrees(allTrees, state.showArchived);
      const hasArchived = allTrees.some((t) => t.archived);
      const grid = (state.showArchived || !hasArchived)
        ? action.grid
        : buildGrid(visible, action.syncByBranch);

      let activeTab = state.activeTab;
      if (state.activeTab !== "all") {
        const stackName = state.activeTab.stack;
        const stackExists = visible.some((tree) => tree.stackName === stackName);
        if (!stackExists) activeTab = "all";
      }
      const initial: Cursor | null = action.currentBranch &&
          grid.byBranch.has(action.currentBranch)
        ? { branch: action.currentBranch }
        : (grid.cells[0] ? { branch: grid.cells[0].branch } : null);
      let nextCursor = state.cursor ?? initial;
      if (activeTab !== "all") {
        const stackCells = grid.byStack.get(activeTab.stack) ?? [];
        const firstCell = [...stackCells].sort((a, b) => a.row - b.row)[0];
        const cursorCell = nextCursor
          ? grid.byBranch.get(nextCursor.branch)
          : undefined;
        const cursorInStack = cursorCell?.stackName === activeTab.stack;
        if (!cursorInStack) {
          nextCursor = firstCell ? { branch: firstCell.branch } : null;
        }
      }
      return {
        ...state,
        trees: visible,
        allTrees,
        syncByBranch: action.syncByBranch,
        worktreeByBranch: action.worktreeByBranch,
        grid,
        colorByStack: action.colorByStack,
        activeTab,
        currentBranch: action.currentBranch,
        totalLoadCount: action.totalBranches,
        cursor: nextCursor,
      };
    }
```

Add the new case (place near `HELP_TOGGLE`):

```ts
    case "ARCHIVED_TOGGLE": {
      const showArchived = !state.showArchived;
      const visible = visibleTrees(state.allTrees, showArchived);
      const grid = buildGrid(visible, state.syncByBranch);
      let activeTab = state.activeTab;
      if (
        activeTab !== "all" &&
        !visible.some((tree) => tree.stackName === activeTab.stack)
      ) {
        activeTab = "all";
      }
      const cursorCell = state.cursor
        ? grid.byBranch.get(state.cursor.branch)
        : undefined;
      const cursor = cursorCell
        ? state.cursor
        : (grid.cells[0] ? { branch: grid.cells[0].branch } : null);
      return { ...state, showArchived, trees: visible, grid, activeTab, cursor };
    }
```

- [ ] **Step 5: Run reducer tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/tui/state/reducer.test.ts`
Expected: PASS. Fix any other reducer tests that build a `State`/`StackTree` literal missing the new `allTrees` / `showArchived` / `archived` fields (add `allTrees: []`, `showArchived: false`, `archived: false` as needed).

- [ ] **Step 6: Wire the keybind and prop in `src/tui/app.tsx`**

`App` props: add `showArchived?: boolean`. Find the `useReducer` call (around line 82) that calls `initialState(...)` and pass the prop:

```ts
  const [state, dispatch] = useReducer(
    reducer,
    initialState(
      props.initialTab === "all" ? "all" : props.initialTab,
      props.showArchived ?? false,
    ),
  );
```

(Match the existing argument shape for `initialState`; the file currently passes the initial tab. Keep that and add the second arg.)

Add the keybind in the main `useInput` handler (the non-modal section, near the `?` handler around line 528). Do not add it inside the land/help modal branches:

```ts
    if (input === "a") {
      dispatch({ type: "ARCHIVED_TOGGLE" });
      return;
    }
```

- [ ] **Step 7: Pass `showArchived` from the CLI launcher in `src/cli.ts`**

In the `--interactive` branch, pass the flag into the `App` element (around line 415, inside `React.createElement(App, {...})`):

```ts
          React.createElement(App, {
            dir,
            initialTab,
            loadPrs,
            theme,
            showArchived: options.archived === true,
            onRequestExit: (code = 0) => {
              tuiExitCode = code;
              instance?.unmount();
            },
          }),
```

(The `status` command's `--archived` option from Task 4 is reused here, so no new option is needed.)

- [ ] **Step 8: Dim + mark archived stacks in `src/tui/components/stack-map.tsx`**

The component already maps `visible` trees and renders a header per tree with `stackName`. For each archived tree, append ` (archived)` to the displayed name and dim it. Locate the header render (around line 234-243 where `<StackHeader stackName={tree.stackName} ... />` or similar is built). Pass a derived label and a `dimColor`/muted color. Concretely, where the stack header receives `stackName`, change it to:

```tsx
                stackName={tree.archived
                  ? `${tree.stackName} (archived)`
                  : tree.stackName}
```

and pass the existing color as a dimmed variant when archived (if the header takes a `color` prop, use a muted gray like `"gray"` for archived; if it takes a `dimColor` boolean on the `<Text>`, set it). Inspect the `StackHeader`/`stack-band` header prop contract first and apply the minimal change that renders archived headers visually muted. Keep the change confined to the label + color; do not restructure the component.

- [ ] **Step 9: Add `a` to the status bar / help in `src/tui/components/help-overlay.tsx`**

Add an entry to `STATUS_BAR_ITEMS` (and the help overlay key list) for the archived toggle, matching the existing item shape:

```ts
  { key: "a", label: "archived" },
```

(Match the exact field names used by the other entries in that array.)

- [ ] **Step 10: Typecheck + run TUI tests**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/tui/ && deno check src/cli.ts`
Expected: PASS. Fix any component test fixtures that construct `State`/`StackTree` literals to include the new fields.

- [ ] **Step 11: Commit**

```bash
git add src/tui src/cli.ts
git commit -m "$(cat <<'EOF'
feat: hide archived stacks in the TUI with an 'a' toggle

Claude-Session: https://claude.ai/code/session_01S6QK66Qo2k6tEVtHxcAwGw
EOF
)"
```

---

## Task 6: serve web UI archived toggle

**Files:**
- Modify: `src/commands/serve.client.js`
- Modify: `src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `ServeStackStatus.archived` (inherited from `StackStatus` via Task 4; the serve payload already spreads each stack, so `archived` is present with no server change).

- [ ] **Step 1: Write the failing payload test**

Inspect `src/commands/serve.test.ts` around line 69 (`expect(status.repositories[0].status?.stacks[0]).toMatchObject({...})`) and the fixture setup that creates a stack. Add an assertion (or a new test) that an archived stack surfaces `archived: true` in the payload. Following the existing setup pattern in that file, set the flag with `setStackArchived` before building the payload, then:

```ts
    // archived flag flows through to the browser payload unchanged.
    const archivedStack = status.repositories[0].status?.stacks.find(
      (s) => s.stackName === "<archived-stack-name>",
    );
    expect(archivedStack?.archived).toBe(true);
```

Use the actual stack name and payload-builder call already used by the surrounding test. If the existing baseline test asserts a stack object via `toMatchObject`, simply add `archived: false` there for a non-archived stack to lock the field in.

- [ ] **Step 2: Run the test to verify it fails (or passes trivially)**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts`
Expected: FAIL if asserting `archived: true` on a stack that the fixture has not yet flagged; this confirms the assertion is wired. (If it already passes because `archived` flows through from Task 1/4, that is acceptable evidence the server side needs no change. Keep the assertion as a regression guard.)

- [ ] **Step 3: Track archived in the client model (`src/commands/serve.client.js`)**

In `buildModel` (around line 99), record `archived` per repo entry and per group. Update the entry push and add a group-level `archived`:

```js
      entry.repos.push({
        name: repo.name,
        github: repo.github ? `${repo.github.owner}/${repo.github.repo}` : null,
        baseBranch: stack.baseBranch,
        branches: stack.branches || [],
        archived: stack.archived === true,
      });
```

After building the `list` (around line 117), compute group archived state (a group is archived only when every contributing repo's stack is archived):

```js
  for (const s of list) {
    s.archived = s.repos.length > 0 && s.repos.every((r) => r.archived);
  }
```

- [ ] **Step 4: Add `showArchived` state with localStorage persistence**

Update the `state` object (around line 61):

```js
const ARCHIVED_KEY = "stacked-prs:show-archived";
const state = {
  selectedId: idFromPath(),
  open: false,
  showArchived: (() => {
    try {
      return localStorage.getItem(ARCHIVED_KEY) === "1";
    } catch {
      return false;
    }
  })(),
};
```

Add a helper near `selectStack`:

```js
function setShowArchived(value) {
  state.showArchived = value;
  try {
    localStorage.setItem(ARCHIVED_KEY, value ? "1" : "0");
  } catch {
    // localStorage unavailable (private mode); keep ephemeral.
  }
  render();
}

function visibleStacks() {
  return state.showArchived ? stacks : stacks.filter((s) => !s.archived);
}
```

- [ ] **Step 5: Use visible stacks in render + add the toggle**

In `render()` (around line 672), derive from `visibleStacks()` for emptiness, the all-stacks list, and the switcher, while still resolving the single selected stack from the full `stacks` (so a deep-linked archived stack still renders):

```js
function render() {
  app.replaceChildren();
  const id = state.selectedId;
  const visible = visibleStacks();
  const isEmpty = visible.length === 0;
  const isAll = !isEmpty && id === "__all__";
  const sel = (id !== "__all__")
    ? (stacks.find((s) => s.id === id) || null)
    : null;
  // ... build header switcher with `visible` (see Step 6) ...
```

Update `renderHeaderSwitcher` to take and iterate the visible list, and pass `visible` into `renderAll`:

```js
      isAll ? renderAll(visible) : renderSingle(sel),
```

Add a "Show archived" toggle to the header, only when archived stacks exist. After the existing header tag append (around line 702, before `app.append(header)`), insert:

```js
  if (stacks.some((s) => s.archived)) {
    const toggle = el("label", {
      style:
        `display:inline-flex;align-items:center;gap:6px;margin-left:12px;cursor:pointer;font:400 12px ${MONO};color:#6e7681;`,
    });
    const box = el("input", { type: "checkbox" });
    box.checked = state.showArchived;
    box.addEventListener("change", () => setShowArchived(box.checked));
    toggle.append(box, el("span", { text: "Show archived" }));
    tagWrap.append(toggle);
  }
```

(Place this where `tagWrap` is still in scope, before `header.append(tagWrap)`.)

- [ ] **Step 6: Dim + badge archived stacks**

In `renderHeaderSwitcher`'s menu loop (around line 655), append " (archived)" to the name and mute archived items:

```js
    for (const s of visible) {
      menu.append(
        menuItem(
          s.archived ? `${s.name} (archived)` : s.name,
          s.summary,
          stackColor(s.id),
          s.id === id,
          false,
          () => selectStack(s.id),
        ),
      );
    }
```

For the single-stack header label and lane header in `renderSingle`, append ` (archived)` when `sel.archived` / the lane's stack is archived. Apply a muted text color (`#6e7681`) to the archived label so it reads as de-emphasized. Keep the changes confined to label text and color.

Also handle the reconcile in `loadStatus` (around line 727): when the selected stack is hidden by the current filter, the existing fallback to `ALL_ID` already covers unknown selections; a selected archived stack still exists in `stacks`, so it stays selectable. No change needed beyond using `stacks` (full list) for that membership check, which it already does.

- [ ] **Step 7: Typecheck + verify the served page**

Run: `deno check src/cli.ts`
Expected: no type errors (the client is plain JS, but ensure serve.ts still compiles).

Run the serve tests: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/serve.test.ts`
Expected: PASS.

Manual smoke (in a repo with one archived and one active stack):
```bash
deno run --allow-run=git,gh,open --allow-env --allow-read --allow-net src/cli.ts serve --no-open --port 0
```
Then open the printed URL: the active stack shows by default; "Show archived" reveals the archived one (dimmed, with `(archived)`); the preference survives reload.

- [ ] **Step 8: Commit**

```bash
git add src/commands/serve.client.js src/commands/serve.test.ts
git commit -m "$(cat <<'EOF'
feat: hide archived stacks in serve with a Show archived toggle

Claude-Session: https://claude.ai/code/session_01S6QK66Qo2k6tEVtHxcAwGw
EOF
)"
```

---

## Task 7: Documentation

**Files:**
- Modify: `skills/stacked-prs/SKILL.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `SKILL.md`**

In the Scripts section, add the `archive` command with its full `cli.ts` invocation, matching the existing entry format:

```
archive [<stack>] [--unarchive] [--json]
```

Describe: marks a stack archived (or clears it with `--unarchive`); defaults to the current branch's stack; hidden from `status`/`serve` and skipped by `sync` until revealed. Note the new `--archived` flag on `status` and `sync`. (This is a shipped skill file, so the change is `feat:` per the repo convention; it is committed together with the other docs here, so use `feat:` for this commit since it touches `skills/**`.)

- [ ] **Step 2: Update `README.md`**

Add a short "Archiving a stack" subsection to the user-facing command docs: `stacked-prs archive` / `archive --unarchive`, and that `status --archived`, `sync --archived`, the TUI `a` key, and the serve "Show archived" switch reveal archived stacks.

- [ ] **Step 3: Update `CLAUDE.md`**

- Add to the git-config schema block:
  ```
  stack.<stack-name>.archived        # "true" when archived; hidden from status/serve, skipped by sync. Key absent = not archived.
  ```
- Add an `archive` row to the script-roles table:
  ```
  | `src/commands/archive.ts` | Toggle a stack's archived flag | `cli.ts archive [<stack>] [--unarchive] [--json]` |
  ```
- Update the `status`, `sync`, and `serve` prose to mention archived hiding/`--archived`/the serve toggle.
- In the development rules for `serve`, note the client's "Show archived" switch and that archived stacks are still sent in the payload (filtered client-side).

- [ ] **Step 4: Commit**

```bash
git add skills/stacked-prs/SKILL.md README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
feat: document stack archiving across SKILL, README, and CLAUDE

Claude-Session: https://claude.ai/code/session_01S6QK66Qo2k6tEVtHxcAwGw
EOF
)"
```

---

## Final verification

- [ ] **Run the full suite + checks**

Run: `deno task check && deno task test`
Expected: type check, lint, fmt check all pass; full test suite green.

- [ ] **Install the updated binary** (per user workflow: run `deno task install` after changes)

Run: `deno task install`
Expected: global `stacked-prs` rebuilt from live source.
