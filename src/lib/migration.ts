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

const LEGACY_PROBE_REGEX = "^(branch\\.[^.]+\\.stack-name|stack\\.)";

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
    m =
      /^stack\.(.+)\.(base-branch|merge-strategy|resume-state|land-resume-state)$/
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
  const branchesCount =
    [...snap.branches.values()].filter((e) => snap.stacks.has(e.stackName))
      .length;
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
