import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { State, TabId } from "./types.ts";
import type { StackTree } from "../lib/stack.ts";
import { initialState, reducer } from "./state/reducer.ts";
import { loadCommits, loadLocal, loadPrsProgressive } from "./state/loader.ts";
import { buildGrid } from "./lib/layout.ts";
import { assignColors, detectTheme, readColorOverrides } from "./lib/colors.ts";
import {
  moveDown,
  moveLeft,
  moveRight,
  moveToStack,
  moveToStackEnd,
  moveToStackStart,
  moveUp,
} from "./state/navigation.ts";
import { copyToClipboard } from "./lib/clipboard.ts";
import { gh } from "../lib/gh.ts";
import { runGitCommand } from "../lib/stack.ts";
import { TabBar } from "./components/tab-bar.tsx";
import { StackMap } from "./components/stack-map.tsx";
import { DetailPane } from "./components/detail-pane.tsx";
import { buildStatusBar, HelpOverlay } from "./components/help-overlay.tsx";

export interface AppProps {
  dir: string;
  theme?: "light" | "dark";
}

function parentOf(state: State, branch: string): string | null {
  for (const tree of state.trees) {
    const stack = [...tree.roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.branch === branch) return node.parent;
      stack.push(...node.children);
    }
  }
  return null;
}

export function App(props: AppProps): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState());
  const { exit } = useApp();
  const { stdout } = useStdout();
  const abortRef = useRef<AbortController | null>(null);
  const [termSize, setTermSize] = useState<{ cols: number; rows: number }>(
    () => ({
      cols: stdout?.columns ?? 80,
      rows: stdout?.rows ?? 24,
    }),
  );
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState(0);

  const runRunGit = (
    ...args: string[]
  ): Promise<{ code: number; stdout: string }> =>
    runGitCommand(props.dir, ...args);

  async function doInitialLoad(): Promise<void> {
    const theme = props.theme ?? detectTheme(Deno.env.get("COLORFGBG"));
    const local = await loadLocal(props.dir);
    const overrides = await readColorOverrides(
      props.dir,
      local.trees.map((t) => t.stackName),
      runRunGit,
    );
    const colorByStack = assignColors(
      local.trees.map((t) => t.stackName),
      overrides,
      theme,
    );
    const grid = buildGrid(local.trees, local.syncByBranch);
    dispatch({
      type: "LOCAL_LOADED",
      trees: local.trees,
      syncByBranch: local.syncByBranch,
      grid,
      colorByStack,
      currentBranch: local.currentBranch,
      totalBranches: local.allBranches.length,
    });

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    for (const b of local.allBranches) {
      dispatch({ type: "PR_LOAD_START", branch: b });
    }

    await loadPrsProgressive({
      branches: local.allBranches,
      concurrency: 8,
      signal: controller.signal,
      onLoaded: (branch, pr) => dispatch({ type: "PR_LOADED", branch, pr }),
      onError: (branch, message) =>
        dispatch({ type: "PR_ERROR", branch, message }),
    });
  }

  useEffect(() => {
    doInitialLoad().catch((err) => {
      dispatch({ type: "ERROR_LOG", message: (err as Error).message });
    });
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.dir]);

  // Load commits for focused branch lazily.
  useEffect(() => {
    const branch = state.cursor?.branch;
    if (!branch) return;
    if (state.commits.has(branch)) return;
    const parent = parentOf(state, branch);
    if (!parent) return;
    dispatch({ type: "COMMITS_LOAD_START", branch });
    loadCommits(props.dir, branch, parent).then((commits) => {
      dispatch({ type: "COMMITS_LOADED", branch, commits });
    }).catch((err) =>
      dispatch({
        type: "COMMITS_ERROR",
        branch,
        message: (err as Error).message,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.cursor?.branch]);

  // Track terminal size so the outer layout can stretch to fill the window,
  // and update the too-narrow guard on the same resize event.
  useEffect(() => {
    const minWidth = 40;
    const check = () => {
      const cols = stdout?.columns ?? 80;
      const rows = stdout?.rows ?? 24;
      setTermSize({ cols, rows });
      dispatch({ type: "TERMINAL_SIZE", tooNarrow: cols < minWidth });
    };
    check();
    stdout?.on("resize", check);
    return () => {
      stdout?.off("resize", check);
    };
  }, [stdout]);

  // Visible trees for the active tab, used by both the render and the
  // cursor-Y computation so they stay in sync.
  const visibleTrees: StackTree[] = state.activeTab === "all"
    ? state.trees
    : state.trees.filter((t: StackTree) =>
      t.stackName === (state.activeTab as { stack: string }).stack
    );

  // Height reserved for the StackMap, computed from the terminal size minus
  // the fixed chrome around it: tab bar (1), optional gh-warning (1),
  // detail pane (8, fixed in DetailPane), status bar (1).
  const stackMapHeight = Math.max(
    3,
    termSize.rows - 1 - (state.ghUnavailable ? 1 : 0) - 8 - 1,
  );

  // Keep the cursor's approximate x position inside the visible viewport.
  // In the ladder layout, a row's x extent is `depth*3` for the prefix plus
  // the branch name. That's a coarse proxy but enough to drive horizontal
  // scroll when a deeply-nested branch falls off the right edge.
  useEffect(() => {
    if (!state.cursor) return;
    const cell = state.grid.byBranch.get(state.cursor.branch);
    if (!cell) return;
    const x = cell.depth * 3;
    const right = x + cell.branch.length;
    const viewportW = termSize.cols;
    setScrollX((prev: number) => {
      if (x < prev) return Math.max(0, x);
      if (right > prev + viewportW) return Math.max(0, right - viewportW);
      return prev;
    });
  }, [state.cursor?.branch, termSize.cols, state.grid]);

  // Keep the cursor's vertical position inside the StackMap viewport. Each
  // branch occupies 2 lines (name + info) plus 1 rail line if it isn't the
  // last branch of its stack. The shared `main` label and initial trunk
  // row add 2 lines at the top; each stack adds 1 header row before its
  // branches; a gap row sits between adjacent stacks. This must match
  // StackBand/StackMap rendering exactly, otherwise the scroll offset
  // drifts.
  //
  // Scroll rules:
  // - Scrolling up snaps to `max(0, headerY - 2)` so the stack header and
  //   two rows of context above it stay visible. For the first stack that
  //   means the shared `main` label is visible too.
  // - Scrolling down moves minimally to keep the cursor's 2-line row in
  //   view. For very long stacks the header may scroll off the top once
  //   the cursor moves past `stackMapHeight` rows into the stack.
  // - If the context target would hide the cursor (stack longer than the
  //   viewport), fall back to cursor-only visibility.
  useEffect(() => {
    if (!state.cursor) return;
    const cursorBranch = state.cursor.branch;
    let y = 0;
    let cursorY = -1;
    let headerY = -1;
    if (visibleTrees.length > 0) y += 2; // main + initial trunk
    for (let s = 0; s < visibleTrees.length; s++) {
      const tree = visibleTrees[s];
      const cells = [...(state.grid.byStack.get(tree.stackName) ?? [])]
        .sort((a, b) => a.row - b.row);
      const thisHeaderY = y;
      y += 1; // stack header
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].branch === cursorBranch) {
          cursorY = y;
          headerY = thisHeaderY;
        }
        y += 2; // branch name + info
        if (i < cells.length - 1) y += 1; // inter-row rail
      }
      if (s < visibleTrees.length - 1) y += 1; // gap row between stacks
    }
    if (cursorY < 0) return;
    const cursorBottom = cursorY + 2; // cursor row is 2 lines tall
    setScrollY((prev: number) => {
      // Scroll up: include the stack header plus two rows of context above
      // (which is the shared `main` label for the first stack).
      if (cursorY < prev) {
        const target = Math.max(0, headerY - 2);
        if (cursorBottom - target > stackMapHeight) {
          return Math.max(0, cursorBottom - stackMapHeight);
        }
        return target;
      }
      // Scroll down: keep cursor visible with minimal movement.
      if (cursorBottom > prev + stackMapHeight) {
        return Math.max(0, cursorBottom - stackMapHeight);
      }
      return prev;
    });
  }, [state.cursor?.branch, stackMapHeight, state.grid, state.activeTab]);

  useInput((input, key) => {
    if (state.showHelp && input !== "?") {
      if (key.escape || input === "q") {
        dispatch({ type: "HELP_TOGGLE" });
      }
      return;
    }

    if (input === "q" || key.escape) {
      abortRef.current?.abort();
      exit();
      return;
    }
    if (input === "?") {
      dispatch({ type: "HELP_TOGGLE" });
      return;
    }

    if (!state.cursor) return;
    const grid = state.grid;
    const cursor = state.cursor;

    if (key.leftArrow || input === "h") {
      dispatch({ type: "CURSOR_SET", cursor: moveLeft(grid, cursor) });
    } else if (key.rightArrow || input === "l") {
      dispatch({ type: "CURSOR_SET", cursor: moveRight(grid, cursor) });
    } else if (key.upArrow || input === "k") {
      dispatch({ type: "CURSOR_SET", cursor: moveUp(grid, cursor) });
    } else if (key.downArrow || input === "j") {
      dispatch({ type: "CURSOR_SET", cursor: moveDown(grid, cursor) });
    } else if (input === "r" || input === "R") {
      doInitialLoad().catch(() => {});
    } else if (input === "g") {
      const c = grid.byBranch.get(cursor.branch);
      if (c) {
        const target = moveToStackStart(grid, c.stackName);
        if (target) dispatch({ type: "CURSOR_SET", cursor: target });
      }
    } else if (input === "G") {
      const c = grid.byBranch.get(cursor.branch);
      if (c) {
        const target = moveToStackEnd(grid, c.stackName);
        if (target) dispatch({ type: "CURSOR_SET", cursor: target });
      }
    } else if (input === "[" || key.pageUp) {
      const stackNames = [...grid.byStack.keys()];
      const c = grid.byBranch.get(cursor.branch);
      if (c) {
        const i = stackNames.indexOf(c.stackName);
        if (i > 0) {
          const target = moveToStack(grid, stackNames[i - 1], cursor);
          if (target) dispatch({ type: "CURSOR_SET", cursor: target });
        }
      }
    } else if (input === "]" || key.pageDown) {
      const stackNames = [...grid.byStack.keys()];
      const c = grid.byBranch.get(cursor.branch);
      if (c) {
        const i = stackNames.indexOf(c.stackName);
        if (i >= 0 && i < stackNames.length - 1) {
          const target = moveToStack(grid, stackNames[i + 1], cursor);
          if (target) dispatch({ type: "CURSOR_SET", cursor: target });
        }
      }
    } else if (key.tab) {
      const tabs: TabId[] = [
        "all",
        ...state.trees.map((t: StackTree): TabId => ({ stack: t.stackName })),
      ];
      const currentIdx = tabs.findIndex((t) =>
        t === "all"
          ? state.activeTab === "all"
          : state.activeTab !== "all" && state.activeTab.stack === t.stack
      );
      const nextIdx = key.shift
        ? (currentIdx - 1 + tabs.length) % tabs.length
        : (currentIdx + 1) % tabs.length;
      dispatch({ type: "TAB_SWITCH", tab: tabs[nextIdx] });
    } else if (/^[1-9]$/.test(input)) {
      const idx = Number.parseInt(input, 10) - 1;
      const tabs: TabId[] = [
        "all",
        ...state.trees.map((t: StackTree): TabId => ({ stack: t.stackName })),
      ];
      if (idx < tabs.length) {
        dispatch({ type: "TAB_SWITCH", tab: tabs[idx] });
      }
    } else if (input === "o") {
      const prCell = state.prData.get(cursor.branch);
      if (prCell?.status === "loaded" && prCell.pr) {
        gh("pr", "view", "--web", String(prCell.pr.number)).catch(() => {});
      }
    } else if (input === "y") {
      copyToClipboard(cursor.branch).catch(() => {});
    } else if (input === "Y") {
      const prCell = state.prData.get(cursor.branch);
      if (prCell?.status === "loaded" && prCell.pr) {
        copyToClipboard(prCell.pr.url).catch(() => {});
      }
    }
  });

  if (state.terminalTooNarrow) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>terminal too narrow (need at least 40 cols)</Text>
      </Box>
    );
  }

  const focusedBranch = state.cursor?.branch ?? null;
  const stackNames = state.trees.map((t: StackTree) => t.stackName);

  return (
    // Stretch to the full terminal so the stack map gets the remaining
    // vertical space via flexGrow.
    //
    // overflowX="hidden" is critical: stack bands render each row as a
    // horizontal Box whose children can exceed terminal width. Without
    // clipping, the terminal physically wraps those rows, but Ink's
    // log-update tracks lines by counting '\n' in the rendered string, so
    // previousLineCount undercounts. On re-render, log-update's eraseLines
    // can't reach the wrapped tail, and each new frame stacks below the
    // un-erased portion of the previous one.
    <Box
      flexDirection="column"
      overflowX="hidden"
      width={termSize.cols}
      height={termSize.rows}
    >
      <TabBar
        stacks={stackNames}
        activeTab={state.activeTab}
        loadingCount={state.loadingCount}
        totalLoadCount={state.totalLoadCount}
      />
      {state.ghUnavailable && (
        <Text dimColor>gh unavailable - showing topology only</Text>
      )}
      {state.showHelp
        ? (
          <Box flexGrow={1} width={termSize.cols} overflowY="hidden">
            <HelpOverlay />
          </Box>
        )
        : (
          <>
            <StackMap
              state={state}
              viewportWidth={termSize.cols}
              viewportHeight={stackMapHeight}
              scrollX={scrollX}
              scrollY={scrollY}
            />
            <DetailPane
              branch={focusedBranch}
              prCell={focusedBranch
                ? state.prData.get(focusedBranch)
                : undefined}
              syncStatus={focusedBranch
                ? state.syncByBranch.get(focusedBranch)
                : undefined}
              commitsCell={focusedBranch
                ? state.commits.get(focusedBranch)
                : undefined}
            />
          </>
        )}
      <Text dimColor>{buildStatusBar(termSize.cols)}</Text>
    </Box>
  );
}
