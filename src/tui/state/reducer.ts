import type { Action, Cursor, State } from "../types.ts";
import { tabKey } from "../types.ts";
import { buildGrid } from "../lib/layout.ts";

export function initialState(): State {
  return {
    trees: [],
    syncByBranch: new Map(),
    worktreeByBranch: new Map(),
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
    focusedSection: "body",
    detailScroll: { scrollX: 0, scrollY: 0 },
    notice: null,
    land: { phase: "idle" },
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
        ? { branch: action.currentBranch }
        : (action.grid.cells[0]
          ? { branch: action.grid.cells[0].branch }
          : null);
      return {
        ...state,
        trees: action.trees,
        syncByBranch: action.syncByBranch,
        worktreeByBranch: action.worktreeByBranch,
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
      return {
        ...state,
        cursor: action.cursor,
        detailScroll: { scrollX: 0, scrollY: 0 },
      };
    case "TAB_SWITCH": {
      const cursorByTab = new Map(state.cursorByTab);
      if (state.cursor) {
        cursorByTab.set(tabKey(state.activeTab), state.cursor);
      }
      const restored = cursorByTab.get(tabKey(action.tab)) ?? null;
      // When switching into a specific-stack tab, the cursor must live in
      // that stack. A restored per-tab cursor is trusted (it came from this
      // tab before), but the "fall back to current cursor" path could carry
      // a branch from a different stack, which would let j/k walk outside
      // the visible stack. Snap to the first cell of the target stack in
      // that case.
      let nextCursor = restored ?? state.cursor;
      if (action.tab !== "all") {
        const stackCells = state.grid.byStack.get(action.tab.stack) ?? [];
        const firstCell = [...stackCells].sort((a, b) => a.row - b.row)[0];
        const cursorCell = nextCursor
          ? state.grid.byBranch.get(nextCursor.branch)
          : undefined;
        const cursorInStack = cursorCell?.stackName === action.tab.stack;
        if (!cursorInStack) {
          nextCursor = firstCell ? { branch: firstCell.branch } : null;
        }
      }
      return {
        ...state,
        activeTab: action.tab,
        cursor: nextCursor,
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
    case "FOCUS_SET":
      return { ...state, focusedSection: action.section };
    case "DETAIL_SCROLL":
      return { ...state, detailScroll: action.viewport };
    case "NOTICE_SHOW": {
      const id = (state.notice?.id ?? 0) + 1;
      return { ...state, notice: { id, message: action.message } };
    }
    case "NOTICE_CLEAR":
      if (!state.notice || state.notice.id !== action.id) return state;
      return { ...state, notice: null };
    case "ERROR_LOG":
      return {
        ...state,
        errorRing: pushError(state.errorRing, action.message),
      };
    case "LAND_START":
      return {
        ...state,
        land: { phase: "planning", stackName: action.stackName },
      };
    case "LAND_PLAN_LOADED":
      return { ...state, land: { phase: "confirming", plan: action.plan } };
    case "LAND_PLAN_ERROR":
      return {
        ...state,
        land: {
          phase: "error",
          plan: null,
          events: [],
          message: action.message,
          rollback: null,
        },
      };
    case "LAND_CONFIRM": {
      if (state.land.phase !== "confirming") return state;
      return {
        ...state,
        land: {
          phase: "executing",
          plan: state.land.plan,
          events: [],
        },
      };
    }
    case "LAND_CANCEL":
      return { ...state, land: { phase: "idle" } };
    case "LAND_PROGRESS": {
      if (state.land.phase !== "executing") return state;
      return {
        ...state,
        land: {
          ...state.land,
          events: [...state.land.events, action.event],
        },
      };
    }
    case "LAND_ERROR":
      return {
        ...state,
        land: {
          phase: "error",
          plan: action.plan,
          events: action.events,
          message: action.message,
          rollback: action.rollback,
        },
      };
    case "LAND_DONE":
      return { ...state, land: { phase: "done", result: action.result } };
    case "LAND_DISMISS":
      return { ...state, land: { phase: "idle" } };
  }
}
