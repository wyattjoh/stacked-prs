import React, { useEffect, useReducer, useRef } from "react";
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
import { HelpOverlay } from "./components/help-overlay.tsx";

export interface AppProps {
  dir: string;
  theme?: "light" | "dark";
}

const STATUS_BAR = "? help  r refresh  o open  y yank  q quit";

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

  // Terminal-width guard.
  useEffect(() => {
    const minWidth = 40;
    const check = () => {
      dispatch({
        type: "TERMINAL_SIZE",
        tooNarrow: (stdout?.columns ?? 80) < minWidth,
      });
    };
    check();
    stdout?.on("resize", check);
    return () => {
      stdout?.off("resize", check);
    };
  }, [stdout]);

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
    } else if (input === "[") {
      const stackNames = [...grid.byStack.keys()];
      const c = grid.byBranch.get(cursor.branch);
      if (c) {
        const i = stackNames.indexOf(c.stackName);
        if (i > 0) {
          const target = moveToStack(grid, stackNames[i - 1], cursor);
          if (target) dispatch({ type: "CURSOR_SET", cursor: target });
        }
      }
    } else if (input === "]") {
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

  if (state.showHelp) {
    return <HelpOverlay />;
  }

  const focusedBranch = state.cursor?.branch ?? null;
  const stackNames = state.trees.map((t: StackTree) => t.stackName);

  return (
    // overflowX="hidden" is critical: stack bands render each row as a
    // horizontal Box whose children can exceed terminal width. Without
    // clipping, the terminal physically wraps those rows, but Ink's
    // log-update tracks lines by counting '\n' in the rendered string, so
    // previousLineCount undercounts. On re-render, log-update's eraseLines
    // can't reach the wrapped tail, and each new frame stacks below the
    // un-erased portion of the previous one.
    <Box flexDirection="column" overflowX="hidden">
      <TabBar
        stacks={stackNames}
        activeTab={state.activeTab}
        loadingCount={state.loadingCount}
        totalLoadCount={state.totalLoadCount}
      />
      {state.ghUnavailable && (
        <Text dimColor>gh unavailable - showing topology only</Text>
      )}
      <StackMap state={state} />
      <DetailPane
        branch={focusedBranch}
        prCell={focusedBranch ? state.prData.get(focusedBranch) : undefined}
        syncStatus={focusedBranch
          ? state.syncByBranch.get(focusedBranch)
          : undefined}
        commitsCell={focusedBranch
          ? state.commits.get(focusedBranch)
          : undefined}
      />
      <Text dimColor>{STATUS_BAR}</Text>
    </Box>
  );
}
