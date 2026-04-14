import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addBranch,
  commitFile,
  createTestRepo,
  runGit,
} from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import { executeRestack } from "./restack.ts";
import { applyClean, detectStaleConfig } from "./clean.ts";

/** Bare-clone fake origin so restack's `origin/<base>` preflight works. */
async function setupFakeOrigin(dir: string): Promise<void> {
  const bareDir = await Deno.makeTempDir({
    prefix: "stacked-prs-clean-origin-",
  });
  await runGit(dir, "clone", "--bare", dir, bareDir);
  await runGit(dir, "remote", "add", "origin", bareDir);
  await runGit(dir, "fetch", "origin");
}

/** True iff a git config key is currently set. */
async function configKeyExists(dir: string, key: string): Promise<boolean> {
  try {
    await runGit(dir, "config", key);
    return true;
  } catch {
    return false;
  }
}

describe("detectStaleConfig", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("empty repo: returns empty report", async () => {
    const report = await detectStaleConfig(repo.dir);
    expect(report.findings).toEqual([]);
    expect(report.stacksScanned).toBe(0);
    expect(report.branchesScanned).toBe(0);
  });

  test("healthy stack: no findings", async () => {
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    const report = await detectStaleConfig(repo.dir);
    expect(report.findings).toEqual([]);
    expect(report.stacksScanned).toBe(1);
    expect(report.branchesScanned).toBe(2);
  });

  test("missing branch ref: flags and lists branch stack keys", async () => {
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await setStackNode(repo.dir, "b", "test", "a");

    // Delete the ref but leave the config in place.
    await runGit(repo.dir, "update-ref", "-d", "refs/heads/b");

    const report = await detectStaleConfig(repo.dir);
    const missing = report.findings.filter((f) => f.kind === "missing-branch");
    expect(missing).toHaveLength(1);
    expect(missing[0].branch).toBe("b");
    expect(missing[0].stackName).toBe("test");
    expect(missing[0].configKeys).toContain("branch.b.stack-name");
    expect(missing[0].configKeys).toContain("branch.b.stack-parent");
  });

  test("stale stack-parent: flags parent ref that does not exist", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "ghost");

    const report = await detectStaleConfig(repo.dir);
    const stale = report.findings.filter(
      (f) => f.kind === "stale-stack-parent",
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].branch).toBe("a");
    expect(stale[0].stackName).toBe("test");
    expect(stale[0].configKeys).toEqual(["branch.a.stack-parent"]);
  });

  test("empty stack: flags stack with no member branches", async () => {
    await runGit(repo.dir, "config", "stack.foo.base-branch", "main");
    await runGit(repo.dir, "config", "stack.foo.merge-strategy", "merge");

    const report = await detectStaleConfig(repo.dir);
    const empty = report.findings.filter((f) => f.kind === "empty-stack");
    expect(empty).toHaveLength(1);
    expect(empty[0].stackName).toBe("foo");
    expect(empty[0].configKeys).toContain("stack.foo.base-branch");
    expect(empty[0].configKeys).toContain("stack.foo.merge-strategy");
  });

  test("stale resume-state: flags when no rebase is in progress", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "foo", "main");
    await setStackNode(repo.dir, "a", "foo", "main");
    await runGit(repo.dir, "config", "stack.foo.resume-state", "{}");

    const report = await detectStaleConfig(repo.dir);
    const stale = report.findings.filter(
      (f) => f.kind === "stale-resume-state",
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].stackName).toBe("foo");
    expect(stale[0].configKeys).toEqual(["stack.foo.resume-state"]);
  });

  test("resume-state during in-progress rebase: not flagged", async () => {
    // Reproduce the conflict scenario from restack.test.ts.
    await runGit(repo.dir, "checkout", "main");
    await commitFile(repo.dir, "shared.txt", "initial\n");
    await addBranch(repo.dir, "root", "main");

    await runGit(repo.dir, "checkout", "-b", "leftConflict", "root");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "left version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "left edits shared");

    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "root", "test", "main");
    await setStackNode(repo.dir, "leftConflict", "test", "root");

    await setupFakeOrigin(repo.dir);
    await runGit(repo.dir, "checkout", "main");
    await Deno.writeTextFile(`${repo.dir}/shared.txt`, "main version\n");
    await runGit(repo.dir, "add", "shared.txt");
    await runGit(repo.dir, "commit", "-m", "main edits shared");
    await runGit(repo.dir, "push", "origin", "main");
    await runGit(repo.dir, "reset", "--hard", "HEAD~1");

    const first = await executeRestack(repo.dir, "test", {});
    expect(first.ok).toBe(false);
    expect(first.error).toBe("conflict");

    try {
      const report = await detectStaleConfig(repo.dir);
      const stale = report.findings.filter(
        (f) => f.kind === "stale-resume-state",
      );
      expect(stale).toEqual([]);
    } finally {
      // Clean up the in-progress rebase so the test directory is safe to
      // remove.
      try {
        await runGit(repo.dir, "rebase", "--abort");
      } catch {
        // already aborted
      }
    }
  });

  test("applyClean removes the right keys", async () => {
    await runGit(repo.dir, "config", "stack.foo.base-branch", "main");
    await runGit(repo.dir, "config", "stack.foo.merge-strategy", "merge");

    const report = await detectStaleConfig(repo.dir);
    expect(report.findings).toHaveLength(1);

    const result = await applyClean(repo.dir, report.findings);
    expect(result.applied).toHaveLength(1);
    for (const key of report.findings[0].configKeys) {
      expect(await configKeyExists(repo.dir, key)).toBe(false);
      expect(result.removed).toContain(key);
    }
  });

  test("applyClean is idempotent on already-gone keys", async () => {
    await runGit(repo.dir, "config", "stack.foo.base-branch", "main");
    const report = await detectStaleConfig(repo.dir);
    expect(report.findings).toHaveLength(1);

    const first = await applyClean(repo.dir, report.findings);
    expect(first.removed.length).toBeGreaterThan(0);

    // Second run: keys are already gone. applyClean must still succeed and
    // still report the keys as removed.
    const second = await applyClean(repo.dir, report.findings);
    expect(second.applied).toHaveLength(1);
    expect(second.removed).toEqual(first.removed);
  });

  test("legacy stack-merged on live branch: flags as legacy-merged-flag", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    // Stranded pre-migration flag: branch is alive, stack-name is set,
    // but the branch carries an orphan stack-merged=true.
    await runGit(repo.dir, "config", "branch.a.stack-merged", "true");

    const report = await detectStaleConfig(repo.dir);
    const legacy = report.findings.filter(
      (f) => f.kind === "legacy-merged-flag",
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0].branch).toBe("a");
    expect(legacy[0].stackName).toBe("test");
    expect(legacy[0].configKeys).toEqual(["branch.a.stack-merged"]);
  });

  test("legacy stack-merged on missing branch: covered by missing-branch, not legacy-merged-flag", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await runGit(repo.dir, "config", "branch.a.stack-merged", "true");
    // Delete the ref.
    await runGit(repo.dir, "update-ref", "-d", "refs/heads/a");

    const report = await detectStaleConfig(repo.dir);
    const legacy = report.findings.filter(
      (f) => f.kind === "legacy-merged-flag",
    );
    expect(legacy).toHaveLength(0);
    const missing = report.findings.filter(
      (f) => f.kind === "missing-branch",
    );
    expect(missing).toHaveLength(1);
    // missing-branch collects *all* branch.a.stack-* keys, including stack-merged.
    expect(missing[0].configKeys).toContain("branch.a.stack-merged");
  });

  test("legacy stack-merged on live branch: applyClean unsets the key", async () => {
    await addBranch(repo.dir, "a", "main");
    await setBaseBranch(repo.dir, "test", "main");
    await setStackNode(repo.dir, "a", "test", "main");
    await runGit(repo.dir, "config", "branch.a.stack-merged", "true");

    const report = await detectStaleConfig(repo.dir);
    await applyClean(
      repo.dir,
      report.findings.filter((f) => f.kind === "legacy-merged-flag"),
    );

    expect(await configKeyExists(repo.dir, "branch.a.stack-merged")).toBe(
      false,
    );
    // Live keys are untouched.
    expect(await configKeyExists(repo.dir, "branch.a.stack-name")).toBe(true);
    expect(await configKeyExists(repo.dir, "branch.a.stack-parent")).toBe(true);
  });

  test("--stack-name filter: excludes findings from other stacks", async () => {
    // Stack "broken" has a missing branch ref.
    await addBranch(repo.dir, "a", "main");
    await addBranch(repo.dir, "b", "a");
    await setBaseBranch(repo.dir, "broken", "main");
    await setStackNode(repo.dir, "a", "broken", "main");
    await setStackNode(repo.dir, "b", "broken", "a");
    await runGit(repo.dir, "update-ref", "-d", "refs/heads/b");

    // Stack "other" is healthy.
    await addBranch(repo.dir, "c", "main");
    await setBaseBranch(repo.dir, "other", "main");
    await setStackNode(repo.dir, "c", "other", "main");

    const scoped = await detectStaleConfig(repo.dir, { stackName: "other" });
    expect(scoped.findings).toEqual([]);

    const unscoped = await detectStaleConfig(repo.dir);
    expect(
      unscoped.findings.some(
        (f) => f.kind === "missing-branch" && f.branch === "b",
      ),
    ).toBe(true);
  });
});
