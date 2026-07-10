import * as colors from "@std/fmt/colors";
import {
  computeSyncStatus,
  effectiveParent,
  getAllNodes,
  getAllStackTrees,
  getStackTree,
  runGitCommand,
  type StackNode,
  type StackTree,
  type SyncStatus,
} from "../lib/stack.ts";
import { listPrsForBranch } from "../lib/gh.ts";
import { ansiColor } from "../lib/ansi.ts";
import {
  assignColors,
  detectTheme,
  readColorOverrides,
} from "../lib/colors.ts";
import {
  firstLine,
  renderAnsiLines,
  renderInlineAnsi,
} from "../lib/markdown.ts";

export type { SyncStatus };

export interface PrInfo {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  /** ISO timestamp; present when the query asks for `createdAt`. */
  createdAt?: string;
}

export interface BranchStatus {
  branch: string;
  parent: string;
  depth: number;
  isLastChild: boolean;
  childCount: number;
  pr: PrInfo | null;
  syncStatus: SyncStatus;
  isCurrent: boolean;
  /** Raw markdown from git's native branch.<name>.description key. */
  description?: string;
}

export interface StackStatus {
  stackName: string;
  baseBranch: string;
  mergeStrategy: string | undefined;
  archived: boolean;
  branches: BranchStatus[];
  display: string;
}

export interface AllStacksStatus {
  stacks: StackStatus[];
  display: string;
}

interface RenderRow {
  branch: string;
  stackName: string;
  rootIndex: number;
  pipeCount: number;
  hasBranchingChildren: boolean;
  pr: PrInfo | null;
  syncStatus: SyncStatus;
  isCurrent: boolean;
  merged: boolean;
  description?: string;
}

async function getCurrentBranch(dir: string): Promise<string> {
  const { stdout } = await runGitCommand(dir, "branch", "--show-current");
  return stdout;
}

export async function queryPr(
  branch: string,
  owner?: string,
  repo?: string,
): Promise<PrInfo | null> {
  return await listPrsForBranch(branch, { owner, repo });
}

export interface StatusOptions {
  loadPrs?: boolean;
  showArchived?: boolean;
  /**
   * Render each branch's full markdown description in the ladder instead of
   * the dimmed first line. Set by `status --description`.
   */
  fullDescriptions?: boolean;
}

const DESCRIPTION_WRAP_WIDTH = 72;

/** Walk the tree DFS and compute depth + isLastChild for each node. */
function computeDepths(
  tree: StackTree,
): Map<string, { depth: number; isLastChild: boolean }> {
  const result = new Map<string, { depth: number; isLastChild: boolean }>();

  const walk = (node: StackNode, depth: number, isLastChild: boolean): void => {
    result.set(node.branch, { depth, isLastChild });
    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i], depth + 1, i === node.children.length - 1);
    }
  };

  for (let i = 0; i < tree.roots.length; i++) {
    // Roots are always "last child" relative to themselves (no parent connector)
    walk(tree.roots[i], 0, i === tree.roots.length - 1);
  }

  return result;
}

function flattenPostorder(tree: StackTree): Array<{
  branch: string;
  stackName: string;
  rootIndex: number;
  pipeCount: number;
  hasBranchingChildren: boolean;
  merged: boolean;
}> {
  const out: Array<{
    branch: string;
    stackName: string;
    rootIndex: number;
    pipeCount: number;
    hasBranchingChildren: boolean;
    merged: boolean;
  }> = [];

  const visit = (
    node: StackNode,
    rowPipeCount: number,
    rootIndex: number,
  ): void => {
    const [primaryChild, ...secondaryChildren] = node.children;

    if (primaryChild) {
      visit(primaryChild, rowPipeCount, rootIndex);
    }

    for (const child of secondaryChildren) {
      visit(child, rowPipeCount + 1, rootIndex);
    }

    out.push({
      branch: node.branch,
      stackName: node.stackName,
      rootIndex,
      pipeCount: rowPipeCount,
      hasBranchingChildren: secondaryChildren.length > 0,
      merged: node.merged === true,
    });
  };

  // Preserve StackTree root order so the compact renderer follows the same
  // parent/child/root ordering the TUI gets from getStackTree/getAllStackTrees.
  for (let i = 0; i < tree.roots.length; i++) {
    visit(tree.roots[i], i, i);
  }
  return out;
}

function colorGraphText(
  text: string,
  colorName: string,
  dimmed = false,
): string {
  const color = ansiColor(colorName);
  return color(dimmed ? colors.dim(text) : text);
}

function ownerStackNameForColumn(
  column: number,
  rootIndex: number,
  rowStackName: string,
  rootStackNames: string[],
): string {
  return column < rootIndex
    ? rootStackNames[column] ?? rowStackName
    : rowStackName;
}

function renderPrefixColumns(
  pipeCount: number,
  rootIndex: number,
  rowStackName: string,
  rootStackNames: string[],
  colorMap: Map<string, string>,
  dimmed: boolean,
): string {
  let out = "";
  for (let i = 0; i < pipeCount; i++) {
    const ownerStack = ownerStackNameForColumn(
      i,
      rootIndex,
      rowStackName,
      rootStackNames,
    );
    out += colorGraphText(
      "│ ",
      colorMap.get(ownerStack) ?? "cyan",
      dimmed,
    );
  }
  return out;
}

function basePrefixText(
  marker: string,
  rootCount: number,
): string {
  // The `─┘` corner is the right side of a join glyph and only makes sense
  // when two or more root trunks merge into the base row. A single root sits
  // directly above the base label with no horizontal extension.
  if (rootCount <= 1) return marker;
  return `${marker}${"─┴".repeat(rootCount - 2)}─┘`;
}

function renderBasePrefix(
  marker: string,
  rootStackNames: string[],
  colorMap: Map<string, string>,
): string {
  if (rootStackNames.length === 0) {
    return colorGraphText(marker, colorMap.get("base") ?? "cyan");
  }

  const chars = basePrefixText(marker, rootStackNames.length);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ownerIdx = Math.min(Math.floor(i / 2), rootStackNames.length - 1);
    out += colorGraphText(
      chars[i],
      colorMap.get(rootStackNames[ownerIdx]) ?? "cyan",
    );
  }
  return out;
}

async function resolveStackColors(
  dir: string,
  stackNames: string[],
): Promise<Map<string, string>> {
  const theme = detectTheme(Deno.env.get("COLORFGBG"));
  const overrides = await readColorOverrides(
    stackNames,
    (...args) => runGitCommand(dir, ...args),
  );
  return assignColors(stackNames, overrides, theme);
}

function renderPrText(pr: PrInfo | null): string {
  if (!pr) return "";
  return `#${pr.number} (${pr.isDraft ? "draft" : pr.state.toLowerCase()})`;
}

function colorizePrText(text: string, pr: PrInfo | null): string {
  if (!pr) return colors.dim(text);
  if (pr.isDraft) return colors.yellow(text);
  switch (pr.state.toUpperCase()) {
    case "OPEN":
      return colors.green(text);
    case "MERGED":
      return colors.magenta(text);
    case "CLOSED":
      return colors.dim(text);
    default:
      return text;
  }
}

function colorizeSyncText(text: string, syncStatus: SyncStatus): string {
  switch (syncStatus) {
    case "up-to-date":
      return colors.dim(text);
    case "behind-parent":
      return colors.yellow(text);
    case "diverged":
      return colors.red(text);
    case "landed":
      return colors.magenta(text);
  }
}

function renderMetadata(
  pr: PrInfo | null,
  syncStatus: SyncStatus,
): string {
  const prText = renderPrText(pr);
  if (!prText) return colorizeSyncText(syncStatus, syncStatus);
  return `${colorizePrText(prText, pr)}  ${
    colorizeSyncText(syncStatus, syncStatus)
  }`;
}

function renderRow(
  row: RenderRow,
  colorMap: Map<string, string>,
  rootStackNames: string[],
  graphWidth: number,
  branchWidth: number,
): string {
  const stackColor = ansiColor(colorMap.get(row.stackName) ?? "cyan");
  const marker = row.isCurrent ? "◉" : "◯";
  const trunk = renderPrefixColumns(
    row.pipeCount,
    row.rootIndex,
    row.stackName,
    rootStackNames,
    colorMap,
    row.merged,
  );
  const branchConnector = `${marker}${row.hasBranchingChildren ? "─┘" : ""}`;
  const left = `${branchConnector.padEnd(graphWidth - row.pipeCount * 2)}`;
  const leftColored = `${trunk}${
    stackColor(row.merged ? colors.dim(left) : left)
  }`;
  const branchLabel = row.branch.padEnd(branchWidth);
  const branchText = row.isCurrent ? colors.bold(branchLabel) : branchLabel;
  const branchColored = stackColor(
    row.merged ? colors.dim(branchText) : branchText,
  );
  const metadata = renderMetadata(row.pr, row.syncStatus);
  return metadata
    ? `${leftColored}${branchColored}  ${metadata}`
    : `${leftColored}${branchColored}`;
}

function renderDescriptionLines(
  row: RenderRow,
  colorMap: Map<string, string>,
  rootStackNames: string[],
  graphWidth: number,
  fullDescriptions: boolean,
): string[] {
  if (!row.description) return [];
  const stackColor = ansiColor(colorMap.get(row.stackName) ?? "cyan");
  const trunk = renderPrefixColumns(
    row.pipeCount,
    row.rootIndex,
    row.stackName,
    rootStackNames,
    colorMap,
    row.merged,
  );
  const rail = stackColor(row.merged ? colors.dim("│") : "│");
  const pad = " ".repeat(
    Math.max(0, graphWidth - row.pipeCount * 2 - 1) + 2,
  );
  const body = fullDescriptions
    ? renderAnsiLines(row.description, DESCRIPTION_WRAP_WIDTH, { dim: true })
    : [renderInlineAnsi(firstLine(row.description), { dim: true })];
  return body.map((text) => `${trunk}${rail}${pad}${text}`);
}

function renderBaseRow(
  baseBranch: string,
  rootCount: number,
  isCurrent: boolean,
  rootStackNames: string[],
  colorMap: Map<string, string>,
  graphWidth: number,
  branchWidth: number,
): string {
  const marker = isCurrent ? "◉" : "◯";
  const leftText = `${renderBasePrefix(marker, rootStackNames, colorMap)}${
    " ".repeat(
      Math.max(0, graphWidth - (rootCount > 0 ? rootCount * 2 - 1 : 1)),
    )
  }`;
  const branchLabel = baseBranch.padEnd(branchWidth);
  const branchText = isCurrent ? colors.bold(branchLabel) : branchLabel;
  return `${leftText}${colors.dim(branchText)}`;
}

function renderStackDisplay(
  tree: StackTree,
  branches: BranchStatus[],
  colorMap: Map<string, string>,
  currentBranch: string,
  fullDescriptions: boolean,
): string {
  const branchByName = new Map(
    branches.map((branch) => [branch.branch, branch]),
  );
  const rows = flattenPostorder(tree).map((row): RenderRow => {
    const branch = branchByName.get(row.branch);
    if (!branch) {
      throw new Error(`missing status row for ${row.branch}`);
    }
    return {
      branch: branch.branch,
      stackName: row.stackName,
      rootIndex: row.rootIndex,
      pipeCount: row.pipeCount,
      hasBranchingChildren: row.hasBranchingChildren,
      pr: branch.pr,
      syncStatus: branch.syncStatus,
      isCurrent: branch.isCurrent,
      merged: row.merged,
      description: branch.description,
    };
  });

  const maxBranchWidth = rows.reduce(
    (max, row) => Math.max(max, row.branch.length),
    0,
  );
  const rootCount = tree.roots.length;
  const rootStackNames = tree.roots.map((root) => root.stackName);
  const graphWidth = Math.max(
    ...rows.map((row) =>
      `${"│ ".repeat(row.pipeCount)}◯${row.hasBranchingChildren ? "─┘" : ""}`
        .length
    ),
    rootCount > 0 ? rootCount + 1 : 1,
  ) + 2;
  const branchWidth = Math.max(maxBranchWidth, tree.baseBranch.length);
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(
      renderRow(row, colorMap, rootStackNames, graphWidth, branchWidth),
    );
    lines.push(
      ...renderDescriptionLines(
        row,
        colorMap,
        rootStackNames,
        graphWidth,
        fullDescriptions,
      ),
    );
  }
  lines.push(
    renderBaseRow(
      tree.baseBranch,
      rootCount,
      currentBranch === tree.baseBranch,
      rootStackNames,
      colorMap,
      graphWidth,
      branchWidth,
    ),
  );
  return lines.join("\n");
}

async function buildStackStatus(
  dir: string,
  tree: StackTree,
  currentBranch: string,
  owner?: string,
  repo?: string,
  opts: StatusOptions = {},
): Promise<StackStatus> {
  const depthMap = computeDepths(tree);
  const nodes = getAllNodes(tree);
  const loadPrs = opts.loadPrs === true;

  const branches = await Promise.all(
    nodes.map(async (node): Promise<BranchStatus> => {
      // Walk past tombstoned ancestors so we compare against a parent ref
      // that still exists. `land` deletes the local branch when a stack node
      // is folded into the base, so the literal `node.parent` may be a
      // dangling name; rev-list then fails and the old code returned a
      // spurious "diverged". This matches the parent restack would target.
      const syncStatus: SyncStatus = node.merged
        ? "landed"
        : await computeSyncStatus(
          dir,
          node.branch,
          effectiveParent(tree, node),
        );
      const pr = loadPrs ? await queryPr(node.branch, owner, repo) : null;

      const { depth, isLastChild } = depthMap.get(node.branch) ?? {
        depth: 0,
        isLastChild: true,
      };

      return {
        branch: node.branch,
        parent: node.parent,
        depth,
        isLastChild,
        childCount: node.children.length,
        pr,
        syncStatus,
        isCurrent: node.branch === currentBranch,
        ...(node.description ? { description: node.description } : {}),
      };
    }),
  );

  const colorMap = await resolveStackColors(dir, [tree.stackName]);
  const display = renderStackDisplay(
    tree,
    branches,
    colorMap,
    currentBranch,
    opts.fullDescriptions === true,
  );

  return {
    stackName: tree.stackName,
    baseBranch: tree.baseBranch,
    mergeStrategy: tree.mergeStrategy,
    archived: tree.archived,
    branches,
    display,
  };
}

export async function getStackStatus(
  dir: string,
  stackName: string,
  owner?: string,
  repo?: string,
  opts: StatusOptions = {},
): Promise<StackStatus> {
  const [tree, currentBranch] = await Promise.all([
    getStackTree(dir, stackName),
    getCurrentBranch(dir),
  ]);

  return await buildStackStatus(dir, tree, currentBranch, owner, repo, opts);
}

export async function getAllStackStatuses(
  dir: string,
  owner?: string,
  repo?: string,
  opts: StatusOptions = {},
): Promise<AllStacksStatus> {
  const [trees, currentBranch] = await Promise.all([
    getAllStackTrees(dir),
    getCurrentBranch(dir),
  ]);
  const stacks = await Promise.all(
    trees.map((tree) =>
      buildStackStatus(dir, tree, currentBranch, owner, repo, opts)
    ),
  );
  if (stacks.length === 0) {
    return { stacks, display: "No stacks found." };
  }
  const treeByStackName = new Map(
    trees.map((tree) => [tree.stackName, tree] as const),
  );
  const colorMap = await resolveStackColors(
    dir,
    [...new Set(trees.map((tree) => tree.stackName))],
  );

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
        opts.fullDescriptions === true,
      );
    })
    .join("\n\n");

  return { stacks, display };
}
