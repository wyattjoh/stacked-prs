import React from "react";
import { Box, Text } from "ink";
import type { PrCellState, PrInfo } from "../types.ts";

export interface NodeProps {
  branch: string;
  stackColor: string;
  focused: boolean;
  prCell: PrCellState | undefined;
}

const NODE_WIDTH = 16;
const SPINNER = "⠋";

function glyphFor(pr: PrInfo | null): string {
  if (!pr) return "○";
  if (pr.isDraft) return "◐";
  const s = pr.state.toUpperCase();
  if (s === "MERGED") return "◉";
  if (s === "CLOSED") return "✗";
  return "●";
}

function stateLabel(pr: PrInfo | null): string {
  if (!pr) return "no PR";
  if (pr.isDraft) return "draft";
  return pr.state.toLowerCase();
}

function bottomLine(cell: PrCellState | undefined): string {
  if (!cell || cell.status === "loading") return `${SPINNER} loading`;
  if (cell.status === "error") return "gh error";
  const pr = cell.pr;
  if (!pr) return "○ no PR";
  return `#${pr.number} ${glyphFor(pr)} ${stateLabel(pr)}`;
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 1) return "…";
  return s.slice(0, width - 1) + "…";
}

export function Node(props: NodeProps): React.ReactElement {
  const topStyle = props.focused ? { inverse: true } : {};
  const bottomStyle = props.focused ? { inverse: true } : {};
  const top = truncate(props.branch, NODE_WIDTH);
  const bottom = truncate(bottomLine(props.prCell), NODE_WIDTH);
  return (
    <Box width={NODE_WIDTH} flexShrink={0} flexDirection="column">
      <Text {...topStyle}>{top.padEnd(NODE_WIDTH)}</Text>
      <Text {...bottomStyle}>{bottom.padEnd(NODE_WIDTH)}</Text>
    </Box>
  );
}
