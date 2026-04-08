import React from "react";
import { Box, Text } from "ink";
import type { PrCellState, PrInfo } from "../types.ts";

export interface NodeProps {
  branch: string;
  stackColor: string;
  focused: boolean;
  prCell: PrCellState | undefined;
  width?: number;
}

const DEFAULT_NODE_WIDTH = 16;
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

export function Node(props: NodeProps): React.ReactElement {
  const topStyle = props.focused ? { inverse: true } : {};
  const bottomStyle = props.focused ? { inverse: true } : {};
  const top = props.branch;
  const bottom = bottomLine(props.prCell);
  // Never truncate: expand to fit the longest line, and honour the width
  // passed down from the band so sibling nodes align.
  const width = Math.max(
    props.width ?? DEFAULT_NODE_WIDTH,
    top.length,
    bottom.length,
  );
  return (
    <Box width={width} flexShrink={0} flexDirection="column">
      <Text {...topStyle}>{top.padEnd(width)}</Text>
      <Text {...bottomStyle}>{bottom.padEnd(width)}</Text>
    </Box>
  );
}
