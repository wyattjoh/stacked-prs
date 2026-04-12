import type { StackTree } from "../lib/stack.ts";
import type { PrInfo, SyncStatus } from "../commands/status.ts";
import type { ThemeName } from "../lib/colors.ts";
import type {
  LandPlan,
  LandProgressEvent,
  LandResult,
  LandRollbackReport,
} from "../commands/land.ts";

export type { PrInfo, SyncStatus, ThemeName };

/** PR state surfaced by the TUI node glyphs. */
export type PrState = "open" | "draft" | "merged" | "closed" | "none";

/** Line style for tree connectors. */
export type ConnectorStyle = "solid" | "dashed" | "double";

/** Per-branch worktree display info surfaced in the stack map. */
export interface WorktreeInfo {
  displayPath: string;
  dirty: boolean;
}

/** Per-branch PR load state. */
export type PrCellState =
  | { status: "loading" }
  | { status: "loaded"; pr: PrInfo | null }
  | { status: "error"; message: string };

/** Single commit summary for the detail pane. */
export interface CommitInfo {
  sha: string;
  subject: string;
}

export type CommitsCellState =
  | { status: "loading" }
  | { status: "loaded"; commits: CommitInfo[] }
  | { status: "error"; message: string };

/**
 * One branch's position in the ladder. Every branch gets a unique row.
 *
 * `ancestorRails` has length `max(0, depth - 1)`; entry `i` is true when the
 * ancestor at depth `(i + 1)` has a later sibling, meaning a vertical rail
 * runs through col-group `i` on this row. The corner at col-group
 * `(depth - 1)` is drawn from `isLastSibling` and consumes its own slot.
 */
export interface GridCell {
  branch: string;
  stackName: string;
  row: number;
  depth: number;
  isLastSibling: boolean;
  hasChildren: boolean;
  ancestorRails: boolean[];
  parent: string | null;
  firstChild: string | null;
  connectorStyle: ConnectorStyle;
  /** True for historically merged branches (stack-merged = true). */
  merged?: boolean;
}

export interface GridLayout {
  cells: GridCell[];
  byBranch: Map<string, GridCell>;
  byRow: Map<number, GridCell[]>;
  byStack: Map<string, GridCell[]>;
  rowsByStack: Map<string, number[]>;
  totalRows: number;
}

export interface Cursor {
  branch: string;
}

/** "all" or a specific stack name. */
export type TabId = "all" | { stack: string };

/** Which UI section currently receives keyboard input. */
export type FocusedSection = "header" | "body" | "detail";

export interface Viewport {
  scrollX: number;
  scrollY: number;
}

export interface State {
  trees: StackTree[];
  syncByBranch: Map<string, SyncStatus>;
  worktreeByBranch: Map<string, WorktreeInfo>;
  grid: GridLayout;
  prData: Map<string, PrCellState>;
  commits: Map<string, CommitsCellState>;
  colorByStack: Map<string, string>;
  activeTab: TabId;
  cursor: Cursor | null;
  cursorByTab: Map<string, Cursor>;
  viewport: Viewport;
  loadingCount: number;
  totalLoadCount: number;
  ghUnavailable: boolean;
  showHelp: boolean;
  errorRing: string[];
  theme: ThemeName;
  terminalTooNarrow: boolean;
  currentBranch: string | null;
  focusedSection: FocusedSection;
  detailScroll: Viewport;
  notice: { id: number; message: string } | null;
  land: LandPhase;
}

export type LandPhase =
  | { phase: "idle" }
  | { phase: "planning"; stackName: string }
  | { phase: "confirming"; plan: LandPlan }
  | { phase: "executing"; plan: LandPlan; events: LandProgressEvent[] }
  | {
    phase: "error";
    plan: LandPlan | null;
    events: LandProgressEvent[];
    message: string;
    rollback: LandRollbackReport | null;
  }
  | { phase: "done"; result: LandResult };

export type Action =
  | {
    type: "LOCAL_LOADED";
    trees: StackTree[];
    syncByBranch: Map<string, SyncStatus>;
    worktreeByBranch: Map<string, WorktreeInfo>;
    grid: GridLayout;
    colorByStack: Map<string, string>;
    currentBranch: string | null;
    totalBranches: number;
  }
  | { type: "PR_LOAD_START"; branch: string }
  | { type: "PR_LOADED"; branch: string; pr: PrInfo | null }
  | { type: "PR_ERROR"; branch: string; message: string }
  | { type: "GH_UNAVAILABLE" }
  | { type: "COMMITS_LOAD_START"; branch: string }
  | { type: "COMMITS_LOADED"; branch: string; commits: CommitInfo[] }
  | { type: "COMMITS_ERROR"; branch: string; message: string }
  | { type: "CURSOR_SET"; cursor: Cursor }
  | { type: "TAB_SWITCH"; tab: TabId }
  | { type: "SCROLL"; viewport: Viewport }
  | { type: "HELP_TOGGLE" }
  | { type: "TERMINAL_SIZE"; tooNarrow: boolean }
  | { type: "FOCUS_SET"; section: FocusedSection }
  | { type: "DETAIL_SCROLL"; viewport: Viewport }
  | { type: "NOTICE_SHOW"; message: string }
  | { type: "NOTICE_CLEAR"; id: number }
  | { type: "ERROR_LOG"; message: string }
  | { type: "LAND_START"; stackName: string }
  | { type: "LAND_PLAN_LOADED"; plan: LandPlan }
  | { type: "LAND_CONFIRM" }
  | { type: "LAND_CANCEL" }
  | { type: "LAND_PROGRESS"; event: LandProgressEvent }
  | {
    type: "LAND_ERROR";
    plan: LandPlan | null;
    message: string;
    rollback: LandRollbackReport | null;
  }
  | { type: "LAND_DONE"; result: LandResult }
  | { type: "LAND_DISMISS" };

/** Encode a TabId as a string key for Maps. */
export function tabKey(tab: TabId): string {
  return tab === "all" ? "all" : `stack:${tab.stack}`;
}
