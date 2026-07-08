import { runGitCommand } from "../lib/stack.ts";
import type { AllStacksStatus, BranchStatus, StackStatus } from "./status.ts";

export type CheckoutKey = "up" | "down" | "enter" | "abort" | "other";

export interface CheckoutBranchResult {
  ok: boolean;
  branch: string;
  code: number;
  stdout: string;
  stderr: string;
}

export interface CheckoutBranchOptions {
  showArchived?: boolean;
}

const SYNC_STATUSES = [
  "up-to-date",
  "behind-parent",
  "diverged",
  "landed",
];

function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

function escapeRegex(input: string): string {
  return input.replaceAll(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function stacksFromStatus(
  status: StackStatus | AllStacksStatus,
): StackStatus[] {
  return "stacks" in status ? status.stacks : [status];
}

function checkoutBranchRows(
  status: StackStatus | AllStacksStatus,
): Map<string, BranchStatus> {
  const rows = new Map<string, BranchStatus>();
  for (const stack of stacksFromStatus(status)) {
    for (const branch of stack.branches) {
      if (branch.syncStatus === "landed") continue;
      rows.set(branch.branch, branch);
    }
  }
  return rows;
}

function lineMatchesBranch(line: string, branch: string): boolean {
  const plain = stripAnsi(line);
  const sync = SYNC_STATUSES.join("|");
  const branchPattern = escapeRegex(branch);
  const pattern = new RegExp(
    `(^|\\s)${branchPattern}\\s+(?:#\\d+ \\([^)]*\\)\\s+)?(?:${sync})\\s*$`,
  );
  return pattern.test(plain);
}

/**
 * Return checkout candidates in the same order they appear in status output.
 * Landed tombstone rows are excluded because they no longer have a local ref
 * that `git checkout <branch>` can select.
 */
export function visibleCheckoutBranches(
  status: StackStatus | AllStacksStatus,
  _options: CheckoutBranchOptions = {},
): string[] {
  const candidates = checkoutBranchRows(status);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const line of status.display.split("\n")) {
    for (const branch of candidates.keys()) {
      if (seen.has(branch)) continue;
      if (!lineMatchesBranch(line, branch)) continue;
      seen.add(branch);
      ordered.push(branch);
      break;
    }
  }

  return ordered;
}

/**
 * Clamp a checkout selection index after moving by `delta`.
 */
export function moveCheckoutSelection(
  currentIndex: number,
  delta: number,
  branchCount: number,
): number {
  if (branchCount <= 0) return 0;
  return Math.min(branchCount - 1, Math.max(0, currentIndex + delta));
}

/**
 * Parse a raw terminal keypress into the subset used by checkout selection.
 */
export function parseCheckoutKeypress(bytes: Uint8Array): CheckoutKey {
  if (bytes.length === 0) return "other";
  const [first, second, third] = bytes;
  if (first === 0x03) return "abort";
  if (first === 0x0d || first === 0x0a) return "enter";
  if (first === 0x1b) {
    if (second === 0x5b && third === 0x41) return "up";
    if (second === 0x5b && third === 0x42) return "down";
    return "abort";
  }
  return "other";
}

/**
 * Prefix status output with a checkout cursor on the selected branch row.
 */
export function renderCheckoutDisplay(
  display: string,
  branches: string[],
  selectedBranch: string,
): string {
  return display.split("\n").map((line) => {
    const isBranchLine = branches.some((branch) =>
      lineMatchesBranch(line, branch)
    );
    const selected = isBranchLine && lineMatchesBranch(line, selectedBranch);
    return `${selected ? "> " : "  "}${line}`;
  }).join("\n");
}

/**
 * Run `git checkout <branch>` and return its process result without printing
 * or exiting.
 */
export async function checkoutBranch(
  dir: string,
  branch: string,
): Promise<CheckoutBranchResult> {
  const result = await runGitCommand(dir, "checkout", branch);
  return {
    ok: result.code === 0,
    branch,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
