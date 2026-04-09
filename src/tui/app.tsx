import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { State, TabId } from "./types.ts";
import type { StackTree } from "../lib/stack.ts";
import { initialState, reducer } from "./state/reducer.ts";
import { loadCommits, loadLocal, loadPrsProgressive } from "./state/loader.ts";
import { buildGrid } from "./lib/layout.ts";
import {
  assignColors,
  detectTheme,
  readColorOverrides,
} from "../lib/colors.ts";
import {
  branchNameContentX,
  computeScrollX,
  computeScrollY,
} from "./lib/scroll.ts";
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
import { HeaderBox } from "./components/header-box.tsx";
import { StackMap } from "./components/stack-map.tsx";
import { DetailPane } from "./components/detail-pane.tsx";
import { buildStatusBar, HelpOverlay } from "./components/help-overlay.tsx";
import { LandModal } from "./components/land-modal.tsx";
import {
  executeLand,
  LandError,
  planLand,
  type PrStateByBranch,
  UnsupportedLandShape,
} from "../commands/land.ts";
import type { PrInfo } from "./types.ts";
import { selectBestPr } from "../lib/gh.ts";

export interface AppProps {
  dir: string;
  theme?: "light" | "dark";
}

/**
 * Fixed chrome reserved around the stack-map viewport. Current total:
 * HeaderBox (3) + body border (2) + detail pane (10, hard-coded in
 * `DetailPane`) + status bar (1) = 16. The optional gh-unavailable warning
 * adds one more line, applied on top of this base.
 */
const CHROME_HEIGHT_BASE = 3 + 2 + 10 + 1;

/**
 * Minimum stack-map viewport height. Each branch row is 2 lines (name +
 * info), so 2 is the smallest value that can fit the cursor's row. The
 * cursor-follow scroll logic falls back to cursor-only visibility when the
 * stack is taller than the viewport, so this is all we need to guarantee
 * the selected branch stays on screen.
 */
const MIN_STACK_MAP_HEIGHT = 2;

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

  // Primary focus color, theme-derived. Used as the "selected" border color
  // on the body wrapper and detail pane, and as a fallback by HeaderBox.
  const theme = props.theme ?? detectTheme(Deno.env.get("COLORFGBG"));
  const primaryColor = theme === "light" ? "black" : "white";

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
      worktreeByBranch: local.worktreeByBranch,
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
    if (!parent) {
      // Cursor is on the base branch (or a branch not in any stack tree).
      // Nothing to diff against, so record an empty commits list rather
      // than leaving the detail pane stuck in a "loading commits" state.
      dispatch({ type: "COMMITS_LOADED", branch, commits: [] });
      return;
    }
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
    // Minimum rows required to fit the fixed chrome (tab bar + detail pane +
    // status bar = 10) plus at least one 2-line branch row in the stack-map
    // viewport. Below this, the cursor-follow scroll logic can't guarantee
    // the selected branch stays visible, so we bail out with a message.
    const minHeight = CHROME_HEIGHT_BASE + MIN_STACK_MAP_HEIGHT;
    const check = () => {
      const cols = stdout?.columns ?? 80;
      const rows = stdout?.rows ?? 24;
      setTermSize({ cols, rows });
      dispatch({
        type: "TERMINAL_SIZE",
        tooNarrow: cols < minWidth || rows < minHeight,
      });
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
  // Ordered stack names + a stable string key so effects can depend on the
  // visible-stack set without re-running on every unrelated state change.
  const visibleStackNames = visibleTrees.map((t) => t.stackName);
  const visibleStacksKey = visibleStackNames.join("\x00");

  // Height reserved for the StackMap, computed from the terminal size minus
  // the fixed chrome around it. Keep this in sync with `CHROME_HEIGHT_BASE`
  // and the one-line guarantees in `HeaderBox` + the status bar `<Box>` below.
  // If either of those wraps, this math drifts and the cursor-follow scroll
  // effect can put the selected branch outside the visible region.
  const stackMapHeight = Math.max(
    MIN_STACK_MAP_HEIGHT,
    termSize.rows - CHROME_HEIGHT_BASE - (state.ghUnavailable ? 1 : 0),
  );

  // Map the loaded PR cells down to the shapes `planLand` / `executeLand`
  // expect. Computed every render, but the derivations are cheap and
  // memoizing would require deep comparison of the Map to avoid staleness.
  const prStateByBranch: PrStateByBranch = (() => {
    const map: PrStateByBranch = new Map();
    for (const [branch, cell] of state.prData) {
      if (cell.status !== "loaded") continue;
      if (cell.pr === null) map.set(branch, "NONE");
      else if (cell.pr.state === "MERGED") map.set(branch, "MERGED");
      else if (cell.pr.state === "CLOSED") map.set(branch, "CLOSED");
      else if (cell.pr.isDraft) map.set(branch, "DRAFT");
      else map.set(branch, "OPEN");
    }
    return map;
  })();

  const prInfoByBranch = (() => {
    const map = new Map<string, PrInfo>();
    for (const [branch, cell] of state.prData) {
      if (cell.status === "loaded" && cell.pr) {
        map.set(branch, cell.pr);
      }
    }
    return map;
  })();

  // Auto-dismiss transient notices after a short delay. Re-runs whenever a
  // new notice is raised (tracked by `id`) so back-to-back notices extend
  // the visible window instead of cutting each other off.
  useEffect(() => {
    const current = state.notice;
    if (!current) return;
    const timer = setTimeout(() => {
      dispatch({ type: "NOTICE_CLEAR", id: current.id });
    }, 2500);
    return () => clearTimeout(timer);
  }, [state.notice?.id]);

  // Planning: build a LandPlan when the land state slice enters "planning".
  // UnsupportedLandShape is surfaced as a transient notice rather than an
  // error modal because it is an expected no-op, not a failure.
  useEffect(() => {
    if (state.land.phase !== "planning") return;
    const stackName = state.land.stackName;
    let cancelled = false;
    (async () => {
      try {
        const plan = await planLand(
          props.dir,
          stackName,
          prStateByBranch,
          prInfoByBranch,
        );
        if (cancelled) return;
        dispatch({ type: "LAND_PLAN_LOADED", plan });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnsupportedLandShape) {
          dispatch({ type: "LAND_DISMISS" });
          dispatch({
            type: "NOTICE_SHOW",
            message: `Cannot land ${stackName}: ${err.message}`,
          });
          return;
        }
        dispatch({
          type: "LAND_ERROR",
          plan: null,
          message: (err as Error).message,
          rollback: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.land.phase === "planning" ? state.land.stackName : null]);

  // Executing: run executeLand and stream progress events back into the
  // reducer. freshPrStates re-reads gh pr list for every plan branch so
  // stale plans (PR reopened while the modal was up) abort before mutating
  // anything.
  useEffect(() => {
    if (state.land.phase !== "executing") return;
    const plan = state.land.plan;
    let cancelled = false;
    (async () => {
      try {
        const result = await executeLand(props.dir, plan, {
          onProgress: (event) => {
            if (cancelled) return;
            dispatch({ type: "LAND_PROGRESS", event });
          },
          freshPrStates: async (branches) => {
            const fresh: PrStateByBranch = new Map();
            await Promise.all(branches.map(async (b) => {
              try {
                const out = await gh(
                  "pr",
                  "list",
                  "--head",
                  b,
                  "--state",
                  "all",
                  "--json",
                  "number,url,state,isDraft,createdAt",
                );
                const rows = JSON.parse(out) as Array<{
                  state: string;
                  isDraft: boolean;
                  createdAt?: string;
                }>;
                const best = selectBestPr(rows);
                if (!best) fresh.set(b, "NONE");
                else if (best.state === "MERGED") fresh.set(b, "MERGED");
                else if (best.state === "CLOSED") fresh.set(b, "CLOSED");
                else if (best.isDraft) fresh.set(b, "DRAFT");
                else fresh.set(b, "OPEN");
              } catch {
                fresh.set(b, "NONE");
              }
            }));
            return fresh;
          },
        });
        if (cancelled) return;
        dispatch({ type: "LAND_DONE", result });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof LandError) {
          dispatch({
            type: "LAND_ERROR",
            plan: err.plan,
            message: err.message,
            rollback: err.rollback,
          });
          return;
        }
        dispatch({
          type: "LAND_ERROR",
          plan,
          message: (err as Error).message,
          rollback: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.land.phase === "executing" ? state.land.plan : null]);

  // Auto-refresh the tree once a land succeeds, then auto-dismiss the modal
  // after a short delay so the user sees the "Landed" summary briefly.
  useEffect(() => {
    if (state.land.phase !== "done") return;
    doInitialLoad().catch(() => {});
    const timer = setTimeout(() => {
      dispatch({ type: "LAND_DISMISS" });
    }, 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.land.phase]);

  // Keep the cursor's branch name fully visible horizontally. The content
  // x of a branch name is `stackCount * 3` (contentPrefix filler) plus
  // `depth * 3` (ladder rails + corner) — see `branchNameContentX` for the
  // single source of truth. Using just `depth * 3` here, as we did before,
  // clipped the cursor's trailing characters whenever the content row was
  // wider than the terminal. `computeScrollX` encapsulates the minimal-
  // movement policy so it's unit-testable in isolation.
  // First visible stack's base branch is the one rendered at the top of the
  // stack map. The cursor can land on it as a selectable target even though
  // it is not part of the grid.
  const baseBranch: string | undefined = visibleTrees[0]?.baseBranch;

  useEffect(() => {
    if (!state.cursor) return;
    // Base-branch cursor: snap both scroll axes to 0 so the top label and all
    // trunk rails stay visible.
    if (state.cursor.branch === baseBranch) {
      setScrollX(0);
      return;
    }
    const cell = state.grid.byBranch.get(state.cursor.branch);
    if (!cell) return;
    // At depth 0 (root of a stack) snap scrollX to 0 so all of the vertical
    // trunk rails for other stacks stay visible to the left of the cursor.
    if (cell.depth === 0) {
      setScrollX(0);
      return;
    }
    const stackCount = visibleTrees.length;
    const cursorX = branchNameContentX(stackCount, cell.depth);
    setScrollX((prev: number) =>
      computeScrollX({
        cursorX,
        cursorWidth: cell.branch.length,
        viewportWidth: termSize.cols - 2,
        prev,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.cursor?.branch,
    termSize.cols,
    state.grid,
    visibleStacksKey,
  ]);

  // Keep the cursor's vertical position inside the StackMap viewport. The
  // actual math lives in `lib/scroll.ts` so it can be unit-tested against
  // synthetic grids; this effect just wires it to the live state and the
  // resize handler. The dep list covers every input `computeScrollY` reads
  // so a cursor move, resize, tab switch, or grid reload all re-scroll.
  useEffect(() => {
    const cursorBranch = state.cursor?.branch;
    if (!cursorBranch) return;
    // Base-branch row sits at y=0, so snap scrollY to 0 when it is focused.
    if (cursorBranch === baseBranch) {
      setScrollY(0);
      return;
    }
    setScrollY((prev: number) =>
      computeScrollY({
        visibleStacks: visibleStackNames,
        grid: state.grid,
        cursorBranch,
        viewportHeight: stackMapHeight,
        prev,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.cursor?.branch,
    stackMapHeight,
    state.grid,
    visibleStacksKey,
  ]);

  useInput((input, key) => {
    // Land modal captures most input. Accept only y/n/esc in the confirming
    // phase and esc in the error/done phases; swallow everything else so
    // background navigation can't run while a land is in flight.
    if (state.land.phase !== "idle") {
      if (state.land.phase === "confirming") {
        if (input === "y") {
          dispatch({ type: "LAND_CONFIRM" });
          return;
        }
        if (input === "n" || key.escape) {
          dispatch({ type: "LAND_CANCEL" });
          return;
        }
        return;
      }
      if (
        (state.land.phase === "error" || state.land.phase === "done") &&
        key.escape
      ) {
        dispatch({ type: "LAND_DISMISS" });
        return;
      }
      return;
    }

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

    // Tab cycles focus between header / body / detail. Shift-tab reverses.
    if (key.tab) {
      const order: Array<"header" | "body" | "detail"> = [
        "header",
        "body",
        "detail",
      ];
      const idx = order.indexOf(state.focusedSection);
      const nextIdx = key.shift
        ? (idx - 1 + order.length) % order.length
        : (idx + 1) % order.length;
      dispatch({ type: "FOCUS_SET", section: order[nextIdx] });
      return;
    }

    // Global actions (work from any focused section).
    if (input === "r") {
      doInitialLoad().catch(() => {});
      return;
    }
    if (input === "p") {
      if (!state.cursor) return;
      const branch = state.cursor.branch;
      const prCell = state.prData.get(branch);
      if (prCell?.status === "loaded" && prCell.pr) {
        const pr = prCell.pr;
        gh("pr", "view", "--web", String(pr.number)).catch(() => {});
        dispatch({
          type: "NOTICE_SHOW",
          message: `Opening PR #${pr.number} in browser`,
        });
        return;
      }
      const message = prCell?.status === "loading"
        ? `PR info still loading for ${branch}`
        : prCell?.status === "error"
        ? `PR lookup failed for ${branch}`
        : `No PR to open for ${branch}`;
      dispatch({ type: "NOTICE_SHOW", message });
      return;
    }
    if (input === "L") {
      if (!state.cursor) return;
      const cell = state.grid.byBranch.get(state.cursor.branch);
      if (!cell) return;
      dispatch({ type: "LAND_START", stackName: cell.stackName });
      return;
    }
    if (input === "b") {
      if (!state.cursor) return;
      const branch = state.cursor.branch;
      copyToClipboard(branch).then((ok) => {
        dispatch({
          type: "NOTICE_SHOW",
          message: ok
            ? `Copied ${branch} to clipboard`
            : `Failed to copy ${branch} to clipboard`,
        });
      }).catch(() => {
        dispatch({
          type: "NOTICE_SHOW",
          message: `Failed to copy ${branch} to clipboard`,
        });
      });
      return;
    }

    // Section-specific arrow handling.
    if (state.focusedSection === "header") {
      if (key.leftArrow || key.rightArrow) {
        const tabs: TabId[] = [
          "all",
          ...state.trees.map((t: StackTree): TabId => ({
            stack: t.stackName,
          })),
        ];
        if (tabs.length === 0) return;
        const currentIdx = tabs.findIndex((t) =>
          t === "all"
            ? state.activeTab === "all"
            : state.activeTab !== "all" && state.activeTab.stack === t.stack
        );
        const nextIdx = key.leftArrow
          ? (currentIdx - 1 + tabs.length) % tabs.length
          : (currentIdx + 1) % tabs.length;
        dispatch({ type: "TAB_SWITCH", tab: tabs[nextIdx] });
      }
      return;
    }

    if (state.focusedSection === "detail") {
      const { scrollX: dx, scrollY: dy } = state.detailScroll;
      if (key.upArrow) {
        dispatch({
          type: "DETAIL_SCROLL",
          viewport: { scrollX: dx, scrollY: Math.max(0, dy - 1) },
        });
      } else if (key.downArrow) {
        dispatch({
          type: "DETAIL_SCROLL",
          viewport: { scrollX: dx, scrollY: dy + 1 },
        });
      } else if (key.leftArrow) {
        dispatch({
          type: "DETAIL_SCROLL",
          viewport: { scrollX: Math.max(0, dx - 1), scrollY: dy },
        });
      } else if (key.rightArrow) {
        dispatch({
          type: "DETAIL_SCROLL",
          viewport: { scrollX: dx + 1, scrollY: dy },
        });
      }
      return;
    }

    // Body section: navigate branches in the stack tree.
    if (!state.cursor) return;
    const grid = state.grid;
    const cursor = state.cursor;

    // When a specific stack tab is active, constrain vertical navigation so
    // j/k/↑/↓ cannot walk out of the visible stack.
    const scopedStack = state.activeTab === "all"
      ? undefined
      : state.activeTab.stack;

    // Base-branch cursor: the only valid moves are down / right into the
    // first root of the first visible stack. Left / up / g / G / pgup /
    // pgdn are no-ops.
    if (cursor.branch === baseBranch && !grid.byBranch.has(cursor.branch)) {
      if (key.downArrow || key.rightArrow) {
        const firstStack = visibleTrees[0];
        if (firstStack) {
          const target = moveToStackStart(grid, firstStack.stackName);
          if (target) dispatch({ type: "CURSOR_SET", cursor: target });
        }
      }
      return;
    }

    if (key.leftArrow) {
      dispatch({ type: "CURSOR_SET", cursor: moveLeft(grid, cursor) });
    } else if (key.rightArrow) {
      dispatch({ type: "CURSOR_SET", cursor: moveRight(grid, cursor) });
    } else if (key.upArrow) {
      const next = moveUp(grid, cursor, scopedStack);
      if (next.branch === cursor.branch && baseBranch) {
        // Already at the top of the visible grid: step up onto the base
        // branch label.
        dispatch({ type: "CURSOR_SET", cursor: { branch: baseBranch } });
      } else {
        dispatch({ type: "CURSOR_SET", cursor: next });
      }
    } else if (key.downArrow) {
      dispatch({
        type: "CURSOR_SET",
        cursor: moveDown(grid, cursor, scopedStack),
      });
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
    } else if (key.pageUp) {
      const stackNames = [...grid.byStack.keys()];
      const c = grid.byBranch.get(cursor.branch);
      if (c) {
        const i = stackNames.indexOf(c.stackName);
        if (i > 0) {
          const target = moveToStack(grid, stackNames[i - 1], cursor);
          if (target) dispatch({ type: "CURSOR_SET", cursor: target });
        }
      }
    } else if (key.pageDown) {
      const stackNames = [...grid.byStack.keys()];
      const c = grid.byBranch.get(cursor.branch);
      if (c) {
        const i = stackNames.indexOf(c.stackName);
        if (i >= 0 && i < stackNames.length - 1) {
          const target = moveToStack(grid, stackNames[i + 1], cursor);
          if (target) dispatch({ type: "CURSOR_SET", cursor: target });
        }
      }
    }
  });

  if (state.terminalTooNarrow) {
    const minHeight = CHROME_HEIGHT_BASE + MIN_STACK_MAP_HEIGHT;
    return (
      <Box flexDirection="column" padding={1}>
        <Text>
          terminal too small (need at least 40 cols, {minHeight} rows)
        </Text>
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
      <HeaderBox
        stacks={stackNames}
        activeTab={state.activeTab}
        loadingCount={state.loadingCount}
        totalLoadCount={state.totalLoadCount}
        focused={state.focusedSection === "header"}
        colorByStack={state.colorByStack}
        primaryColor={primaryColor}
      />
      {state.ghUnavailable && (
        <Text dimColor>gh unavailable - showing topology only</Text>
      )}
      {state.land.phase !== "idle"
        ? (
          <Box flexGrow={1} width={termSize.cols} overflowY="hidden">
            <LandModal phase={state.land} />
          </Box>
        )
        : state.showHelp
        ? (
          <Box flexGrow={1} width={termSize.cols} overflowY="hidden">
            <HelpOverlay />
          </Box>
        )
        : (
          <>
            {
              /*
              Body wrapper. `stackMapHeight` is the INNER content height
              <StackMap> receives. The wrapper adds 2 for its own border rows
              (top + bottom), and those 2 rows are already accounted for in
              CHROME_HEIGHT_BASE. Do not subtract the border from
              `stackMapHeight` inside <StackMap> or feed `stackMapHeight + 2`
              into scroll math — computeScrollY uses the inner viewport height.
            */
            }
            <Box
              borderStyle="single"
              borderColor={state.focusedSection === "body"
                ? primaryColor
                : "gray"}
              flexDirection="column"
              flexShrink={0}
              width={termSize.cols}
              height={stackMapHeight + 2}
              overflowX="hidden"
              overflowY="hidden"
            >
              <StackMap
                state={state}
                viewportWidth={termSize.cols - 2}
                viewportHeight={stackMapHeight}
                scrollX={scrollX}
                scrollY={scrollY}
              />
            </Box>
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
              worktree={focusedBranch
                ? state.worktreeByBranch.get(focusedBranch)
                : undefined}
              focused={state.focusedSection === "detail"}
              scrollX={state.detailScroll.scrollX}
              scrollY={state.detailScroll.scrollY}
              primaryColor={primaryColor}
            />
          </>
        )}
      {
        /* Status bar is pinned to exactly one line. `stackMapHeight` reserves
          a single row for it, so any wrap here would desync the viewport
          math from what is actually on screen. */
      }
      <Box height={1} flexShrink={0} overflowX="hidden">
        {state.notice
          ? (
            <Text color="yellow" wrap="truncate-end">
              {state.notice.message}
            </Text>
          )
          : (
            <Text dimColor wrap="truncate-end">
              {buildStatusBar(termSize.cols)}
            </Text>
          )}
      </Box>
    </Box>
  );
}
