import React from "react";
import { Box, Text } from "ink";
import type { State } from "../types.ts";
import { StackBand } from "./stack-band.tsx";

export interface StackMapProps {
  state: State;
  viewportWidth?: number;
  scrollX?: number;
  nodeWidth?: number;
}

export function StackMap(props: StackMapProps): React.ReactElement {
  const { trees, grid, colorByStack, activeTab, cursor, prData } = props.state;

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
  const nodeWidth = props.nodeWidth ?? 16;

  // The inner box needs an explicit width wider than any row; otherwise
  // Yoga inherits the viewport width and squeezes the row children even
  // though each Node has flexShrink=0. We overestimate from grid.totalCols
  // so the widest row always fits, and the outer box clips the overflow.
  const contentWidth = Math.max(
    props.viewportWidth ?? 0,
    nodeWidth * (grid.totalCols + 1) + grid.totalCols * 5 + 8,
  );

  // Outer box owns the visible viewport width and clips overflow. The inner
  // box holds the full-width content and is shifted left via a negative
  // margin when scrolled, so rows stay at their natural width instead of
  // being squeezed to fit.
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      width={props.viewportWidth}
      overflowX="hidden"
    >
      <Box
        flexDirection="column"
        flexShrink={0}
        width={contentWidth}
        marginLeft={-scrollX}
      >
        {visible.map((tree) => {
          const cells = grid.byStack.get(tree.stackName) ?? [];
          const color = colorByStack.get(tree.stackName) ?? "white";
          return (
            <Box key={tree.stackName} flexDirection="column" flexShrink={0}>
              <StackBand
                stackName={tree.stackName}
                mergeStrategy={tree.mergeStrategy}
                color={color}
                cells={cells}
                focusedBranch={cursor?.branch ?? null}
                prData={prData}
                nodeWidth={props.nodeWidth}
              />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
