import type { Action, Cursor, State } from "../types.ts";
import { tabKey } from "../types.ts";
import { buildGrid } from "../lib/layout.ts";

export function initialState(): State {
  return {
    trees: [],
    syncByBranch: new Map(),
    grid: buildGrid([], new Map()),
    prData: new Map(),
    commits: new Map(),
    colorByStack: new Map(),
    activeTab: "all",
    cursor: null,
    cursorByTab: new Map(),
    viewport: { scrollX: 0, scrollY: 0 },
    loadingCount: 0,
    totalLoadCount: 0,
    ghUnavailable: false,
    showHelp: false,
    errorRing: [],
    theme: "dark",
    terminalTooNarrow: false,
    currentBranch: null,
  };
}

function pushError(ring: string[], msg: string): string[] {
  const next = [...ring, msg];
  if (next.length > 20) next.shift();
  return next;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "LOCAL_LOADED": {
      const initial: Cursor | null = action.currentBranch &&
          action.grid.byBranch.has(action.currentBranch)
        ? {
          branch: action.currentBranch,
          preferredCol: action.grid.byBranch.get(action.currentBranch)!.col,
        }
        : (action.grid.cells[0]
          ? {
            branch: action.grid.cells[0].branch,
            preferredCol: action.grid.cells[0].col,
          }
          : null);
      return {
        ...state,
        trees: action.trees,
        syncByBranch: action.syncByBranch,
        grid: action.grid,
        colorByStack: action.colorByStack,
        currentBranch: action.currentBranch,
        totalLoadCount: action.totalBranches,
        cursor: state.cursor ?? initial,
      };
    }
    case "PR_LOAD_START": {
      const prData = new Map(state.prData);
      prData.set(action.branch, { status: "loading" });
      return {
        ...state,
        prData,
        loadingCount: state.loadingCount + 1,
      };
    }
    case "PR_LOADED": {
      const prData = new Map(state.prData);
      prData.set(action.branch, { status: "loaded", pr: action.pr });
      return {
        ...state,
        prData,
        loadingCount: Math.max(0, state.loadingCount - 1),
      };
    }
    case "PR_ERROR": {
      const prData = new Map(state.prData);
      prData.set(action.branch, { status: "error", message: action.message });
      return {
        ...state,
        prData,
        loadingCount: Math.max(0, state.loadingCount - 1),
        errorRing: pushError(state.errorRing, action.message),
      };
    }
    case "GH_UNAVAILABLE":
      return { ...state, ghUnavailable: true };
    case "COMMITS_LOAD_START": {
      const commits = new Map(state.commits);
      commits.set(action.branch, { status: "loading" });
      return { ...state, commits };
    }
    case "COMMITS_LOADED": {
      const commits = new Map(state.commits);
      commits.set(action.branch, {
        status: "loaded",
        commits: action.commits,
      });
      return { ...state, commits };
    }
    case "COMMITS_ERROR": {
      const commits = new Map(state.commits);
      commits.set(action.branch, { status: "error", message: action.message });
      return { ...state, commits };
    }
    case "CURSOR_SET":
      return { ...state, cursor: action.cursor };
    case "TAB_SWITCH": {
      const cursorByTab = new Map(state.cursorByTab);
      if (state.cursor) {
        cursorByTab.set(tabKey(state.activeTab), state.cursor);
      }
      const restored = cursorByTab.get(tabKey(action.tab)) ?? null;
      return {
        ...state,
        activeTab: action.tab,
        cursor: restored ?? state.cursor,
        cursorByTab,
      };
    }
    case "SCROLL":
      return { ...state, viewport: action.viewport };
    case "REFRESH_RESET": {
      const prData = new Map(state.prData);
      for (const b of action.branches) {
        prData.set(b, { status: "loading" });
      }
      return {
        ...state,
        prData,
        loadingCount: action.branches.length,
      };
    }
    case "HELP_TOGGLE":
      return { ...state, showHelp: !state.showHelp };
    case "TERMINAL_SIZE":
      return { ...state, terminalTooNarrow: action.tooNarrow };
    case "ERROR_LOG":
      return {
        ...state,
        errorRing: pushError(state.errorRing, action.message),
      };
  }
}
