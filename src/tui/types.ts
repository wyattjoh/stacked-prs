import type { StackTree } from "../lib/stack.ts";
import type { SyncStatus } from "../commands/status.ts";

export type { SyncStatus };

/** PR state surfaced by the TUI node glyphs. */
export type PrState = "open" | "draft" | "merged" | "closed" | "none";

/** Line style for tree connectors. */
export type ConnectorStyle = "solid" | "dashed" | "double";

/** Raw PR info returned by `gh pr list`. */
export interface PrInfo {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
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

/** One node's position in the 2D grid. */
export interface GridCell {
  branch: string;
  stackName: string;
  row: number;
  col: number;
  parentCol: number | null;
  connectorStyle: ConnectorStyle;
  isForkRow: boolean;
}

export interface GridLayout {
  cells: GridCell[];
  byBranch: Map<string, GridCell>;
  byRow: Map<number, GridCell[]>;
  byStack: Map<string, GridCell[]>;
  rowsByStack: Map<string, number[]>;
  totalRows: number;
  totalCols: number;
}

export interface Cursor {
  branch: string;
  preferredCol: number;
}

/** "all" or a specific stack name. */
export type TabId = "all" | { stack: string };

export type ThemeName = "light" | "dark";

export interface Viewport {
  scrollX: number;
  scrollY: number;
}

export interface State {
  trees: StackTree[];
  syncByBranch: Map<string, SyncStatus>;
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
}

export type Action =
  | {
    type: "LOCAL_LOADED";
    trees: StackTree[];
    syncByBranch: Map<string, SyncStatus>;
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
  | { type: "REFRESH_RESET"; branches: string[] }
  | { type: "HELP_TOGGLE" }
  | { type: "TERMINAL_SIZE"; tooNarrow: boolean }
  | { type: "ERROR_LOG"; message: string };

/** Encode a TabId as a string key for Maps. */
export function tabKey(tab: TabId): string {
  return tab === "all" ? "all" : `stack:${tab.stack}`;
}
