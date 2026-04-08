import React from "react";
import { Box, Text } from "ink";
import type { ConnectorStyle, GridCell, PrCellState } from "../types.ts";
import { Node } from "./node.tsx";

export interface StackBandProps {
  stackName: string;
  mergeStrategy: string | undefined;
  color: string;
  cells: GridCell[];
  focusedBranch: string | null;
  prData: Map<string, PrCellState>;
  nodeWidth?: number;
}

const DEFAULT_NODE_WIDTH = 16;

function connectorChars(style: ConnectorStyle, span: number): string {
  const ch = style === "dashed" ? "╌" : style === "double" ? "═" : "─";
  return ch.repeat(Math.max(0, span));
}

function renderRow(
  cells: GridCell[],
  color: string,
  focusedBranch: string | null,
  prData: Map<string, PrCellState>,
  isForkRow: boolean,
  nodeWidth: number,
): React.ReactElement {
  const sorted = [...cells].sort((a, b) => a.col - b.col);
  const parts: React.ReactNode[] = [];

  const firstCol = isForkRow && sorted[0].parentCol !== null
    ? sorted[0].parentCol + 1
    : 0;

  // Fork corner at the very start of a fork row.
  if (isForkRow && sorted[0].parentCol !== null) {
    parts.push(
      <Box key="pad">
        <Text color={color}>
          {"  ".repeat(sorted[0].parentCol)}
          {"└─ "}
        </Text>
      </Box>,
    );
  } else if (firstCol > 0) {
    parts.push(
      <Box key="pad">
        <Text>{"  ".repeat(firstCol)}</Text>
      </Box>,
    );
  }

  for (let i = 0; i < sorted.length; i++) {
    const cell = sorted[i];
    if (i > 0) {
      const prev = sorted[i - 1];
      const gap = cell.col - prev.col - 1;
      const line = connectorChars(cell.connectorStyle, 3 + gap * nodeWidth);
      parts.push(
        <Box key={`c${i}`}>
          <Text color={color}>
            {` ${line} `}
          </Text>
        </Box>,
      );
    }
    parts.push(
      <Box key={`n${i}`} flexDirection="column">
        <Node
          branch={cell.branch}
          stackColor={color}
          focused={focusedBranch === cell.branch}
          prCell={prData.get(cell.branch)}
          width={nodeWidth}
        />
      </Box>,
    );
  }

  return <Box flexDirection="row">{parts}</Box>;
}

export function StackBand(props: StackBandProps): React.ReactElement {
  const header = props.mergeStrategy
    ? `Stack: ${props.stackName} (${props.mergeStrategy})`
    : `Stack: ${props.stackName}`;

  // Fall back to a width wide enough to hold every branch name in this band
  // so the App can omit nodeWidth in isolated tests.
  const nodeWidth = props.nodeWidth ?? Math.max(
    DEFAULT_NODE_WIDTH,
    ...props.cells.map((c) => c.branch.length),
  );

  // Group cells by row.
  const rows = new Map<number, GridCell[]>();
  for (const cell of props.cells) {
    const list = rows.get(cell.row) ?? [];
    list.push(cell);
    rows.set(cell.row, list);
  }
  const sortedRows = [...rows.entries()].sort(([a], [b]) => a - b);

  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Text>{header}</Text>
      {sortedRows.map(([row, cells], i) => (
        <Box key={row} flexShrink={0}>
          {renderRow(
            cells,
            props.color,
            props.focusedBranch,
            props.prData,
            i > 0,
            nodeWidth,
          )}
        </Box>
      ))}
    </Box>
  );
}
