import * as colors from "@std/fmt/colors";
import stringWidth from "string-width";
import { runGitCommand } from "../lib/stack.ts";
import type { AllStacksStatus, StackStatus } from "./status.ts";

export type CheckoutKey =
  | "up"
  | "down"
  | "page-up"
  | "page-down"
  | "home"
  | "end"
  | "backspace"
  | "clear-search"
  | "enter"
  | "abort"
  | "other"
  | { type: "input"; value: string };

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

/**
 * Rendered terminal output for the checkout picker.
 */
export interface CheckoutRenderFrame {
  text: string;
  lineCount: number;
}

/**
 * Runtime terminal constraints for inline checkout rendering.
 */
export interface CheckoutRenderOptions {
  /**
   * Terminal viewport height in rows. When undefined, the full status display
   * is rendered for callers that are not attached to a terminal viewport.
   */
  viewportRows: number | undefined;
  /**
   * Terminal viewport width in columns. When defined, frame row counts include
   * physical rows created by terminal line wrapping.
   */
  viewportColumns: number | undefined;
  /**
   * Current fuzzy-search query shown below the picker.
   */
  query?: string;
  /**
   * Number of selectable branches matching the query.
   */
  matchCount?: number;
  /**
   * Total number of selectable branches before filtering.
   */
  totalCount?: number;
}

/**
 * Footer displayed below the interactive checkout picker.
 */
export const CHECKOUT_FOOTER =
  "Move Up/Down/Pg/Home/End  Enter choose  Esc abort";

const SYNC_STATUSES = [
  "up-to-date",
  "behind-parent",
  "diverged",
  "landed",
];

const ESCAPE = "\x1b";
const CLEAR_TO_END = "\x1b[J";
const CHECKOUT_FOOTER_ROWS = 3;
const CHECKOUT_VIEWPORT_SAFETY_ROWS = 1;

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

function checkoutBranchNames(
  status: StackStatus | AllStacksStatus,
): Set<string> {
  const rows = new Set<string>();
  for (const stack of stacksFromStatus(status)) {
    for (const branch of stack.branches) {
      if (branch.syncStatus === "landed") continue;
      rows.add(branch.branch);
    }
    rows.add(stack.baseBranch);
  }
  return rows;
}

function stackNameByBranch(
  status: StackStatus | AllStacksStatus,
): Map<string, string> {
  const stackByBranch = new Map<string, string>();
  for (const stack of stacksFromStatus(status)) {
    for (const branch of stack.branches) {
      if (branch.syncStatus === "landed") continue;
      stackByBranch.set(branch.branch, stack.stackName);
    }
  }
  return stackByBranch;
}

function checkoutStackStarts(
  status: StackStatus | AllStacksStatus,
  branches: string[],
): Array<{ stackName: string; firstIndex: number }> {
  const stackByBranch = stackNameByBranch(status);
  const seen = new Set<string>();
  const starts: Array<{ stackName: string; firstIndex: number }> = [];
  for (const [index, branch] of branches.entries()) {
    const stackName = stackByBranch.get(branch);
    if (stackName === undefined || seen.has(stackName)) continue;
    seen.add(stackName);
    starts.push({ stackName, firstIndex: index });
  }
  return starts;
}

function lineMatchesBranch(line: string, branch: string): boolean {
  const plain = stripAnsi(line);
  const sync = SYNC_STATUSES.join("|");
  const branchPattern = escapeRegex(branch);
  const stackBranchPattern = new RegExp(
    `(^|\\s)${branchPattern}\\s+(?:#\\d+ \\([^)]*\\)\\s+)?(?:${sync})\\s*$`,
  );
  const baseBranchPattern = new RegExp(
    `(^|\\s)[◉◯](?:[─┴┘]*)?\\s+${branchPattern}\\s*$`,
  );
  return stackBranchPattern.test(plain) || baseBranchPattern.test(plain);
}

/**
 * Return true when every character in `query` appears in `candidate` in order.
 */
export function fuzzyCheckoutMatch(candidate: string, query: string): boolean {
  if (query.length === 0) return true;
  const normalizedCandidate = candidate.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  let queryIndex = 0;
  for (const char of normalizedCandidate) {
    if (char !== normalizedQuery[queryIndex]) continue;
    queryIndex += 1;
    if (queryIndex === normalizedQuery.length) return true;
  }
  return false;
}

/**
 * Filter checkout branches with fuzzy subsequence matching against branch names.
 */
export function filterCheckoutBranches(
  branches: string[],
  query: string,
): string[] {
  if (query.length === 0) return branches;
  return branches.filter((branch) => fuzzyCheckoutMatch(branch, query));
}

function filterCheckoutDisplay(display: string, branches: string[]): string {
  if (branches.length === 0) return "";
  const filtered = [];
  for (const line of display.split("\n")) {
    if (!branches.some((branch) => lineMatchesBranch(line, branch))) continue;
    filtered.push(line);
  }
  return filtered.join("\n");
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
  const candidates = checkoutBranchNames(status);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const line of status.display.split("\n")) {
    for (const branch of candidates) {
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

function moveCheckoutSelectionByStack(
  status: StackStatus | AllStacksStatus,
  branches: string[],
  currentIndex: number,
  delta: -1 | 1,
): number {
  if (branches.length === 0) return 0;
  const clampedCurrent = moveCheckoutSelection(
    currentIndex,
    0,
    branches.length,
  );
  const stackByBranch = stackNameByBranch(status);
  const stackStarts = checkoutStackStarts(status, branches);
  const currentStack = stackByBranch.get(branches[clampedCurrent]);
  if (currentStack === undefined) {
    return delta < 0 && stackStarts.length > 0
      ? stackStarts[stackStarts.length - 1].firstIndex
      : clampedCurrent;
  }

  const currentStackIndex = stackStarts.findIndex((stack) =>
    stack.stackName === currentStack
  );
  if (currentStackIndex < 0) return clampedCurrent;
  const targetStack = stackStarts[currentStackIndex + delta];
  return targetStack?.firstIndex ?? clampedCurrent;
}

/**
 * Move a checkout selection in response to a parsed navigation key.
 */
export function moveCheckoutSelectionForKey(
  status: StackStatus | AllStacksStatus,
  branches: string[],
  currentIndex: number,
  key: CheckoutKey,
): number {
  switch (key) {
    case "up":
      return moveCheckoutSelection(currentIndex, -1, branches.length);
    case "down":
      return moveCheckoutSelection(currentIndex, 1, branches.length);
    case "page-up":
      return moveCheckoutSelectionByStack(status, branches, currentIndex, -1);
    case "page-down":
      return moveCheckoutSelectionByStack(status, branches, currentIndex, 1);
    case "home":
      return 0;
    case "end":
      return branches.length > 0 ? branches.length - 1 : 0;
    default:
      return moveCheckoutSelection(currentIndex, 0, branches.length);
  }
}

function isPrintableInput(sequence: string): boolean {
  if (sequence.length === 0) return false;
  for (const char of sequence) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) return false;
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
  }
  return true;
}

function parseCsiKey(sequence: string): { code: string; final: string } | null {
  if (!sequence.startsWith(`${ESCAPE}[`)) return null;
  const payload = sequence.slice(2);
  if (payload.length === 0) return null;
  const final = payload[payload.length - 1];
  if (final !== "~" && final !== "H" && final !== "F") return null;
  const [code = ""] = payload.slice(0, -1).split(";");
  return { code, final };
}

function matchesCsiKey(
  key: { code: string; final: string } | null,
  final: string,
  codes: string[],
): boolean {
  if (key === null) return false;
  return key.final === final && codes.includes(key.code);
}

/**
 * Parse a raw terminal keypress into the subset used by checkout selection.
 */
export function parseCheckoutKeypress(bytes: Uint8Array): CheckoutKey {
  if (bytes.length === 0) return "other";
  const [first] = bytes;
  if (first === 0x03) return "abort";
  if (first === 0x15) return "clear-search";
  if (first === 0x7f || first === 0x08) return "backspace";
  if (first === 0x0d || first === 0x0a) return "enter";
  const sequence = new TextDecoder().decode(bytes);
  if (first === 0x1b) {
    if (sequence === `${ESCAPE}[A` || sequence === `${ESCAPE}OA`) return "up";
    if (sequence === `${ESCAPE}[B` || sequence === `${ESCAPE}OB`) {
      return "down";
    }
    const csiKey = parseCsiKey(sequence);
    if (matchesCsiKey(csiKey, "~", ["5"])) return "page-up";
    if (matchesCsiKey(csiKey, "~", ["6"])) return "page-down";
    if (
      sequence === `${ESCAPE}[H` || sequence === `${ESCAPE}OH` ||
      matchesCsiKey(csiKey, "~", ["1", "7"]) ||
      matchesCsiKey(csiKey, "H", ["", "1", "7"])
    ) return "home";
    if (
      sequence === `${ESCAPE}[F` || sequence === `${ESCAPE}OF` ||
      matchesCsiKey(csiKey, "~", ["4", "8"]) ||
      matchesCsiKey(csiKey, "F", ["", "4", "8"])
    ) return "end";
    return "abort";
  }
  if (isPrintableInput(sequence)) return { type: "input", value: sequence };
  return "other";
}

/**
 * Prefix status output with a checkout cursor on the selected branch row.
 */
export function renderCheckoutDisplay(
  display: string,
  branches: string[],
  selectedBranch: string | undefined,
): string {
  return display.split("\n").map((line) => {
    const isBranchLine = branches.some((branch) =>
      lineMatchesBranch(line, branch)
    );
    const selected = selectedBranch !== undefined && isBranchLine &&
      lineMatchesBranch(line, selectedBranch);
    const prefixed = `${selected ? "> " : "  "}${line}`;
    return selected ? colors.white(stripAnsi(prefixed)) : prefixed;
  }).join("\n");
}

function renderedLineCount(
  text: string,
  viewportColumns: number | undefined,
): number {
  if (text.length === 0) return 0;
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  if (
    viewportColumns === undefined || !Number.isFinite(viewportColumns) ||
    viewportColumns < 1
  ) {
    return lines.length;
  }

  const columns = Math.floor(viewportColumns);
  return lines.reduce(
    (rows, line) => rows + Math.max(1, Math.ceil(stringWidth(line) / columns)),
    0,
  );
}

function checkoutStatusLineBudget(
  options: CheckoutRenderOptions | undefined,
): number | undefined {
  const rows = options?.viewportRows;
  if (rows === undefined || !Number.isFinite(rows)) return undefined;
  const available = Math.floor(rows) - CHECKOUT_FOOTER_ROWS -
    CHECKOUT_VIEWPORT_SAFETY_ROWS;
  return Math.max(1, available);
}

function selectedDisplayLineIndex(
  lines: string[],
  selectedBranch: string | undefined,
): number {
  if (selectedBranch === undefined) return 0;
  const index = lines.findIndex((line) =>
    lineMatchesBranch(line, selectedBranch)
  );
  return index >= 0 ? index : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function renderCheckoutDisplayWindow(
  display: string,
  selectedBranch: string | undefined,
  options: CheckoutRenderOptions | undefined,
): string {
  const budget = checkoutStatusLineBudget(options);
  if (budget === undefined) return display;

  const lines = display.split("\n");
  if (lines.length <= budget) return display;

  const selectedLine = selectedDisplayLineIndex(lines, selectedBranch);
  const maxStart = Math.max(0, lines.length - budget);
  const start = clamp(selectedLine - Math.floor(budget / 2), 0, maxStart);
  return lines.slice(start, start + budget).join("\n");
}

function renderCheckoutSearchLine(
  options: CheckoutRenderOptions | undefined,
): string {
  const query = options?.query ?? "";
  const matchCount = options?.matchCount;
  const totalCount = options?.totalCount;
  if (query.length === 0) {
    if (matchCount === undefined || totalCount === undefined) return "Search:";
    return `Search: ${matchCount}/${totalCount}`;
  }
  if (matchCount === undefined || totalCount === undefined) {
    return `Search: ${query}`;
  }
  return `Search: ${query}  ${matchCount}/${totalCount}`;
}

/**
 * Render the checkout picker as an inline terminal frame.
 */
export function renderCheckoutFrame(
  display: string,
  branches: string[],
  selectedBranch: string | undefined,
  options?: CheckoutRenderOptions,
): CheckoutRenderFrame {
  const query = options?.query ?? "";
  const displayBody = query.length > 0
    ? filterCheckoutDisplay(display, branches)
    : display;
  const windowedDisplay = renderCheckoutDisplayWindow(
    displayBody,
    selectedBranch,
    options,
  );
  const renderedDisplay = windowedDisplay.length === 0
    ? colors.dim("No matches")
    : renderCheckoutDisplay(windowedDisplay, branches, selectedBranch);
  const text = `${renderedDisplay}\n\n${
    renderCheckoutSearchLine(options)
  }\n${CHECKOUT_FOOTER}\n`;
  return {
    text,
    lineCount: renderedLineCount(text, options?.viewportColumns),
  };
}

/**
 * Render an inline checkout picker update that replaces the previous frame.
 */
export function renderCheckoutFrameUpdate(
  previousLineCount: number,
  display: string,
  branches: string[],
  selectedBranch: string | undefined,
  options?: CheckoutRenderOptions,
): CheckoutRenderFrame {
  const frame = renderCheckoutFrame(display, branches, selectedBranch, options);
  const moveToFrameStart = previousLineCount > 0
    ? `\x1b[${previousLineCount}A`
    : "";
  return {
    text: `${moveToFrameStart}${CLEAR_TO_END}${frame.text}`,
    lineCount: frame.lineCount,
  };
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
