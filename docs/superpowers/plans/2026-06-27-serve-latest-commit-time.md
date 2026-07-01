# Serve per-stack latest-commit time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the relative time of the most recent commit on each stack, in a muted color next to the stack's name, in the `serve` browser view.

**Architecture:** Compute one `latestCommitAt` ISO timestamp per stack server-side (max committer date across the stack's branch refs via a single `git for-each-ref`), flow it through the existing serve payload, and render a muted "N units ago" label client-side in both the all-stacks and single-stack views.

**Tech Stack:** Deno + TypeScript (`src/lib/stack.ts`, `src/commands/status.ts`, `src/commands/serve.ts`), vanilla browser JS (`src/commands/serve.client.js`), Hono serve server.

## Global Constraints

- All scripts are Deno TypeScript; explicit permissions, no bash scripts.
- Command functions stay pure (no `console.log`/`Deno.args`/`Deno.exit`); `src/lib/` holds shared helpers with no CLI entry points.
- No em dashes in any output, comments, or commit messages.
- Run `deno task check` (fmt + lint + type check) before completion; run `deno task install` after code changes (user runs the global binary as a daily driver).
- `serve.client.js` is vanilla browser JS read at runtime; not unit-tested by convention.
- Commit format: Conventional Commits. `serve` behavior changes are user-facing but `serve.client.js`/`serve.ts`/`status.ts` are not under `skills/**`, so `feat:` is appropriate for the feature commits and `docs:` for README/CLAUDE.md-only changes.

---

### Task 1: `getLatestCommitDate` git helper

**Files:**
- Modify: `src/lib/stack.ts` (add exported helper near other git helpers, after `gitConfig`)
- Test: `src/lib/stack.test.ts` (add a test; create file only if absent — check first)

**Interfaces:**
- Produces: `export async function getLatestCommitDate(dir: string, branches: string[]): Promise<string | null>` — returns the max committer date (ISO 8601, `Z` suffix) across the given branch names that have live refs, or `null` when `branches` is empty or none resolve.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/stack.test.ts` (match existing test imports/style; `createTestRepo`, `addBranch`, `commitFile` come from `./testdata/helpers.ts`). Adjust import paths/helpers to match the existing test file's conventions.

```ts
Deno.test("getLatestCommitDate returns max committer date across branches", async () => {
  const dir = await createTestRepo();
  try {
    await addBranch(dir, "feat-a", "main");
    await commitFile(dir, "a.txt", "a");
    await addBranch(dir, "feat-b", "feat-a");
    await commitFile(dir, "b.txt", "b");

    const iso = await getLatestCommitDate(dir, ["feat-a", "feat-b"]);
    assert(iso !== null);
    // feat-b is the newest commit; result parses to a valid recent date.
    assert(!Number.isNaN(Date.parse(iso!)));

    const onlyA = await getLatestCommitDate(dir, ["feat-a"]);
    assert(onlyA !== null);
    // The two-branch max is >= the feat-a-only value.
    assert(Date.parse(iso!) >= Date.parse(onlyA!));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("getLatestCommitDate returns null for empty and missing refs", async () => {
  const dir = await createTestRepo();
  try {
    assertEquals(await getLatestCommitDate(dir, []), null);
    assertEquals(await getLatestCommitDate(dir, ["does-not-exist"]), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts`
Expected: FAIL — `getLatestCommitDate` is not exported / not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/stack.ts` after `gitConfig`:

```ts
/**
 * Return the most recent committer date (ISO 8601, UTC `Z`) across the given
 * branch names, or null when the list is empty or no ref resolves. Branches
 * without a live ref (e.g. deleted landed branches) are skipped. One
 * `git for-each-ref` subprocess regardless of branch count.
 */
export async function getLatestCommitDate(
  dir: string,
  branches: string[],
): Promise<string | null> {
  if (branches.length === 0) return null;
  const refs = branches.map((b) => `refs/heads/${b}`);
  const { code, stdout } = await runGitCommand(
    dir,
    "for-each-ref",
    "--format=%(committerdate:unix)",
    ...refs,
  );
  if (code !== 0 || !stdout) return null;
  let max = 0;
  for (const line of stdout.split("\n")) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (max === 0) return null;
  return new Date(max * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/lib/stack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stack.ts src/lib/stack.test.ts
git commit -m "feat(serve): add getLatestCommitDate helper"
```

---

### Task 2: Populate `latestCommitAt` on `StackStatus`

**Files:**
- Modify: `src/commands/status.ts` (interface `StackStatus` ~line 44; `buildStackStatus` ~line 382-438)
- Test: `src/commands/status.test.ts` (add a test; match existing conventions)

**Interfaces:**
- Consumes: `getLatestCommitDate` from `src/lib/stack.ts` (Task 1).
- Produces: `StackStatus.latestCommitAt: string | null`, carried through `getStackStatus` / `getAllStackStatuses` and into `ServeStackStatus` via the existing spread in `stripStatusAnsi` (`src/commands/serve.ts`).

- [ ] **Step 1: Write the failing test**

Add to `src/commands/status.test.ts` (match how existing tests build a repo + call `getStackStatus`/`getAllStackStatuses`; mirror an existing test's setup and imports):

```ts
Deno.test("getStackStatus populates latestCommitAt", async () => {
  const dir = await createTestRepo();
  try {
    await addBranch(dir, "feat-a", "main");
    await commitFile(dir, "a.txt", "a");
    await initStack(dir, "feat-a"); // use whatever the existing tests use to register a stack
    const status = await getStackStatus(dir, "feat-a");
    assert(status.latestCommitAt !== null);
    assert(!Number.isNaN(Date.parse(status.latestCommitAt!)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

Note for implementer: use the same stack-registration helper the neighbouring tests in this file already use (e.g. an `init`/config-write helper). If none exists, register via the same calls another `getStackStatus` test in this file performs.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/status.test.ts`
Expected: FAIL — `latestCommitAt` is `undefined` / not a property.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/status.ts`:

Add the import (extend the existing `../lib/stack.ts` import list):

```ts
  getLatestCommitDate,
```

Add the field to the interface:

```ts
export interface StackStatus {
  stackName: string;
  baseBranch: string;
  mergeStrategy: string | undefined;
  archived: boolean;
  branches: BranchStatus[];
  /** ISO 8601 of the most recent commit across the stack's branches, or null. */
  latestCommitAt: string | null;
  display: string;
}
```

In `buildStackStatus`, after `const branches = await Promise.all(...)` completes and before the return, compute the date from the same `nodes`:

```ts
  const latestCommitAt = await getLatestCommitDate(
    dir,
    nodes.map((node) => node.branch),
  );
```

Add it to the returned object:

```ts
  return {
    stackName: tree.stackName,
    baseBranch: tree.baseBranch,
    mergeStrategy: tree.mergeStrategy,
    archived: tree.archived,
    branches,
    latestCommitAt,
    display,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-run=git,gh --allow-env --allow-read --allow-write src/commands/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify type check (serve payload picks up the field for free)**

Run: `deno check src/cli.ts`
Expected: no errors (the `...stack` spread in `stripStatusAnsi` carries `latestCommitAt` into `ServeStackStatus`).

- [ ] **Step 6: Commit**

```bash
git add src/commands/status.ts src/commands/status.test.ts
git commit -m "feat(serve): compute latestCommitAt per stack"
```

---

### Task 3: Render the relative time in both serve views

**Files:**
- Modify: `src/commands/serve.client.js` (`buildModel` ~line 182; new `formatRelativeTime` helper; all-stacks row ~lines 697-708; single-stack repo header ~lines 600-603)

**Interfaces:**
- Consumes: `repo.latestCommitAt` (string | null) made available by Task 2.
- Produces: a `formatRelativeTime(iso)` helper and two rendered muted labels.

- [ ] **Step 1: Carry the timestamp into the model**

In `buildModel`, in the `entry.repos.push({ ... })` object (~line 182), add:

```js
        latestCommitAt: stack.latestCommitAt || null,
```

- [ ] **Step 2: Add the relative-time helper**

Add near the other small helpers (e.g. just above `buildModel` or beside `tagSpan`):

```js
function formatRelativeTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, size] of units) {
    if (secs >= size) {
      const n = Math.floor(secs / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
```

- [ ] **Step 3: Render in the all-stacks view**

In `renderAll`, the stack-name row (~lines 693-708), insert a muted span between the stack-name span and the flex divider span. The children array becomes:

```js
      }, [
        el("span", {
          style: `font:600 11px ${MONO};color:${c};${
            g.stack.archived ? "opacity:0.6;" : ""
          }`,
          text: g.stack.archived ? `${g.stack.name} (archived)` : g.stack.name,
        }),
        ...(formatRelativeTime(g.repo.latestCommitAt)
          ? [el("span", {
            style: `font:500 10px ${MONO};color:#586069;`,
            text: formatRelativeTime(g.repo.latestCommitAt),
          })]
          : []),
        el("span", { style: "flex:1;height:1px;background:#21262d;" }),
        el("span", {
          style: `font:500 10px ${MONO};color:#586069;`,
          text: `${n} ${n === 1 ? "branch" : "branches"}`,
        }),
      ]));
```

- [ ] **Step 4: Render in the single-stack view**

In `renderSingle`, the repo header (~lines 593-605), append a muted span after the `"... stacked"` span. The children array becomes:

```js
      }, [
        el("span", {
          style: `font:700 13px ${MONO};color:#e6edf3;`,
          text: repo.name,
        }),
        el("span", {
          style: `font:400 11px ${MONO};color:#586069;`,
          text: `${repo.github || repo.name} · ${repo.branches.length} stacked`,
        }),
        ...(formatRelativeTime(repo.latestCommitAt)
          ? [el("span", {
            style: `font:400 11px ${MONO};color:#586069;`,
            text: `· ${formatRelativeTime(repo.latestCommitAt)}`,
          })]
          : []),
      ]),
```

- [ ] **Step 5: Verify lint/fmt of the client file**

Run: `deno task check`
Expected: no errors (fmt, lint, type check all pass).

- [ ] **Step 6: Manual smoke test**

Run from a repo with at least one stack:
`deno task install` then `stacked-prs serve --no-open` (or run `src/cli.ts serve --no-open`), open the printed URL, and confirm the muted "N units ago" label appears next to stack names in the all-stacks view and in the single-stack repo headers.

- [ ] **Step 7: Commit**

```bash
git add src/commands/serve.client.js
git commit -m "feat(serve): show most recent commit time by stack name"
```

---

### Task 4: Docs

**Files:**
- Modify: `CLAUDE.md` (serve paragraph under the layout/serve description)
- Modify: `README.md` (serve section, if it describes row contents)
- Modify: `skills/stacked-prs/SKILL.md` (serve entry, if it describes rendered rows)

- [ ] **Step 1: Update CLAUDE.md**

In the serve description, add a sentence noting that each stack-name row (all-stacks view) and each repo header (single-stack view) shows a muted relative time of the most recent commit on that stack, backed by `StackStatus.latestCommitAt` (max committer date across the stack's branch refs, `null` when none resolve).

- [ ] **Step 2: Update README.md and SKILL.md if they describe row contents**

If the serve section enumerates what each row shows, add the relative-commit-time label. If it only says "renders status metadata", no change is needed. Use `feat:` if SKILL.md changes (it ships in the plugin); `docs:` covers README/CLAUDE.md.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md skills/stacked-prs/SKILL.md
git commit -m "docs: document serve latest-commit time"
```

(If `skills/stacked-prs/SKILL.md` changed, split it into a separate `feat(skill):` commit so release-please bumps the version.)

---

## Self-Review

- **Spec coverage:** server `latestCommitAt` (Task 1+2), client model carry (Task 3.1), relative-time helper (Task 3.2), all-stacks render (Task 3.3), single-stack render (Task 3.4), tests (Task 1+2), docs (Task 4). All spec sections covered.
- **Placeholder scan:** test setup in Task 2 notes the existing stack-registration helper must be matched (the file's neighbouring tests show the exact call); all code steps show real code.
- **Type consistency:** `getLatestCommitDate(dir, branches)` and `latestCommitAt: string | null` used consistently across tasks; client reads `repo.latestCommitAt`.
