import React from "react";
import { Box, Text } from "ink";
import type { State } from "../types.ts";
import { StackBand } from "./stack-band.tsx";

export interface StackMapProps {
  state: State;
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

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((tree) => {
        const cells = grid.byStack.get(tree.stackName) ?? [];
        const color = colorByStack.get(tree.stackName) ?? "white";
        return (
          <Box key={tree.stackName} flexDirection="column">
            <StackBand
              stackName={tree.stackName}
              mergeStrategy={tree.mergeStrategy}
              color={color}
              cells={cells}
              focusedBranch={cursor?.branch ?? null}
              prData={prData}
            />
          </Box>
        );
      })}
    </Box>
  );
}
