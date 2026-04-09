import React from "react";
import { Box, Text } from "ink";
import type { ConnectorStyle, State, SyncStatus } from "../types.ts";
import { StackBand, type TrunkSegment } from "./stack-band.tsx";

export interface StackMapProps {
  state: State;
  viewportWidth?: number;
  viewportHeight?: number;
  scrollX?: number;
  scrollY?: number;
}

function trunkVertical(style: ConnectorStyle): string {
  if (style === "dashed") return "╎";
  if (style === "double") return "║";
  return "│";
}

function cornerHoriz(style: ConnectorStyle): string {
  if (style === "dashed") return "╌";
  if (style === "double") return "═";
  return "─";
}

function connectorStyleFromSync(sync: SyncStatus | undefined): ConnectorStyle {
  if (sync === "behind-parent") return "dashed";
  if (sync === "diverged") return "double";
  return "solid";
}

/**
 * Trunk segments for a content row *inside* stack `S`.
 *
 * Stacks are indexed 0..N-1 in render order (top to bottom). Stack N-1
 * (the last one) has the leftmost bar at col 0; each earlier stack's bar
 * is 3 cols further right. All stacks share a common content column at
 * col `3*N` so branch names line up vertically across stacks.
 *
 * On a content row, bars for every stack rendered *below* S (still
 * active) appear at slots `0..N-2-S`. The remaining `S+1` slots — the
 * area previously occupied by S's own bar and its extended corner —
 * are blank.
 */
function contentTrunkSegments(
  S: number,
  stackCount: number,
  colors: string[],
  styles: ConnectorStyle[],
): TrunkSegment[] {
  const N = stackCount;
  const segs: TrunkSegment[] = [];
  for (let j = 0; j < N - 1 - S; j++) {
    const barIdx = N - 1 - j;
    segs.push({
      text: `${trunkVertical(styles[barIdx])}  `,
      color: colors[barIdx],
    });
  }
  // Remaining (S+1) slots = blank filler to reach the shared content col.
  if (S + 1 > 0) {
    segs.push({ text: "   ".repeat(S + 1) });
  }
  return segs;
}

/**
 * Trunk segments for stack `S`'s header row. Bars for stacks below S are
 * drawn first, then a single corner glyph that extends horizontally from
 * S's own bar column across the `S+1` slots to the shared content col.
 */
function headerTrunkSegments(
  S: number,
  stackCount: number,
  colors: string[],
  styles: ConnectorStyle[],
): TrunkSegment[] {
  const N = stackCount;
  const segs: TrunkSegment[] = [];
  for (let j = 0; j < N - 1 - S; j++) {
    const barIdx = N - 1 - j;
    segs.push({
      text: `${trunkVertical(styles[barIdx])}  `,
      color: colors[barIdx],
    });
  }
  // Corner spans 3*(S+1) chars: `└` + horiz fill + trailing space.
  const width = 3 * (S + 1);
  const horiz = cornerHoriz(styles[S]);
  const corner = `└${horiz.repeat(width - 2)} `;
  segs.push({ text: corner, color: colors[S] });
  return segs;
}

/**
 * Canopy row: joins all stack bars into a single horizontal line under
 * `main`, so every stack visually flows into the base branch rather than
 * each bar dangling in space.
 *
 * For `N=1` we fall back to a plain vertical bar — there's nothing to join.
 * For `N>1` the row is `┌──┬──┬──┐` (solid) with one T-glyph per middle
 * bar, `┌` at the leftmost bar col, and `┐` at the rightmost. Each glyph is
 * colored with its owning stack so the transition into the per-stack bar
 * below reads as continuous. Horizontal connectors between bar cols inherit
 * the color of the stack to their left.
 */
function initialTrunkSegments(
  stackCount: number,
  colors: string[],
  styles: ConnectorStyle[],
): TrunkSegment[] {
  const N = stackCount;
  const segs: TrunkSegment[] = [];
  if (N === 1) {
    segs.push({
      text: `${trunkVertical(styles[0])}  `,
      color: colors[0],
    });
    return segs;
  }
  for (let j = 0; j < N; j++) {
    const barIdx = N - 1 - j;
    let glyph: string;
    if (j === 0) glyph = "┌";
    else if (j === N - 1) glyph = "┐";
    else glyph = "┬";
    const suffix = j === N - 1 ? "  " : "──";
    segs.push({
      text: `${glyph}${suffix}`,
      color: colors[barIdx],
    });
  }
  return segs;
}

export function StackMap(props: StackMapProps): React.ReactElement {
  const { trees, grid, colorByStack, activeTab, cursor, prData, syncByBranch } =
    props.state;

  if (trees.length === 0) {
    return (
      <Box flexGrow={1} justifyContent="center" alignItems="center">
        <Text dimColor>
          No stacks found. Create one with /stacked-prs create.
        </Text>
      </Box>
    );
  }

  const visible = activeTab === "all"
    ? trees
    : trees.filter((t) => t.stackName === activeTab.stack);

  const scrollX = props.scrollX ?? 0;
  const scrollY = props.scrollY ?? 0;

  const stackCount = visible.length;
  const colors = visible.map((t) => colorByStack.get(t.stackName) ?? "cyan");
  const styles: ConnectorStyle[] = visible.map((t) => {
    const root = (grid.byStack.get(t.stackName) ?? [])
      .filter((c) => c.depth === 0)
      .sort((a, b) => a.row - b.row)[0];
    return connectorStyleFromSync(syncByBranch.get(root?.branch ?? ""));
  });

  // Widest row = trunk prefix for stack 0 (max width) + internal ladder +
  // branch name + slack for the PR info line.
  let maxDepth = 0;
  let maxBranch = 0;
  for (const cell of grid.cells) {
    if (cell.depth > maxDepth) maxDepth = cell.depth;
    if (cell.branch.length > maxBranch) maxBranch = cell.branch.length;
  }
  const contentWidth = Math.max(
    props.viewportWidth ?? 0,
    stackCount * 3 + maxDepth * 3 + maxBranch + 16,
  );

  return (
    <Box
      flexDirection="column"
      width={props.viewportWidth}
      height={props.viewportHeight}
      overflowX="hidden"
      overflowY="hidden"
    >
      <Box
        flexDirection="column"
        flexShrink={0}
        width={contentWidth}
        marginLeft={-scrollX}
        marginTop={-scrollY}
      >
        {/* Shared base-branch label. */}
        <Box flexShrink={0}>
          <Text dimColor>{visible[0].baseBranch}</Text>
        </Box>
        {/* Initial trunk row: all bars originate here, one per stack. */}
        <Box flexDirection="row" flexShrink={0}>
          {initialTrunkSegments(stackCount, colors, styles).map((s, i) => (
            <Box key={i} flexShrink={0}>
              <Text color={s.color}>{s.text}</Text>
            </Box>
          ))}
        </Box>
        {visible.map((tree, S) => {
          const cells = grid.byStack.get(tree.stackName) ?? [];
          const headerPrefix = headerTrunkSegments(
            S,
            stackCount,
            colors,
            styles,
          );
          const contentPrefix = contentTrunkSegments(
            S,
            stackCount,
            colors,
            styles,
          );
          const isLast = S === stackCount - 1;
          return (
            <Box key={tree.stackName} flexDirection="column" flexShrink={0}>
              <StackBand
                stackName={tree.stackName}
                mergeStrategy={tree.mergeStrategy}
                color={colors[S]}
                cells={cells}
                focusedBranch={cursor?.branch ?? null}
                prData={prData}
                headerPrefix={headerPrefix}
                contentPrefix={contentPrefix}
              />
              {
                /* Gap row between stacks — still shows the trunk bars for
                  stacks rendered below, so the trunk stays continuous. */
              }
              {!isLast && (
                <Box flexDirection="row" flexShrink={0}>
                  {contentPrefix.map((s, i) => (
                    <Box key={i} flexShrink={0}>
                      <Text color={s.color}>{s.text}</Text>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
