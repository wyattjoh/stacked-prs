import React from "react";
import { Box, Text } from "ink";
import type { GridCell, PrCellState, PrInfo } from "../types.ts";

export interface TrunkSegment {
  text: string;
  color?: string;
  dimColor?: boolean;
}

export interface StackBandProps {
  stackName: string;
  mergeStrategy: string | undefined;
  color: string;
  cells: GridCell[];
  focusedBranch: string | null;
  prData: Map<string, PrCellState>;
  /** Rendered before the stack header text (multi-color trunk segments). */
  headerPrefix: TrunkSegment[];
  /** Rendered before every content row (branch name / info / rail). */
  contentPrefix: TrunkSegment[];
}

const SLOT = "   ";
const RAIL = "│  ";
const CORNER_MID = "├─ ";
const CORNER_LAST = "└─ ";
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

function infoLine(cell: PrCellState | undefined): string {
  if (!cell || cell.status === "loading") return `${SPINNER} loading`;
  if (cell.status === "error") return "gh error";
  const pr = cell.pr;
  if (!pr) return "○ no PR";
  return `#${pr.number} ${glyphFor(pr)} ${stateLabel(pr)}`;
}

function topPrefix(cell: GridCell): string {
  if (cell.depth === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < cell.depth - 1; i++) {
    parts.push(cell.ancestorRails[i] ? RAIL : SLOT);
  }
  parts.push(cell.isLastSibling ? CORNER_LAST : CORNER_MID);
  return parts.join("");
}

function bottomPrefix(cell: GridCell): string {
  if (cell.depth === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < cell.depth - 1; i++) {
    parts.push(cell.ancestorRails[i] ? RAIL : SLOT);
  }
  parts.push(cell.isLastSibling ? SLOT : RAIL);
  return parts.join("");
}

function railPrefix(cell: GridCell): string {
  const parts: string[] = [];
  for (let i = 0; i < cell.depth - 1; i++) {
    parts.push(cell.ancestorRails[i] ? RAIL : SLOT);
  }
  if (cell.depth >= 1) {
    parts.push(cell.isLastSibling ? SLOT : RAIL);
  }
  if (cell.hasChildren) {
    parts.push(RAIL);
  }
  return parts.join("").replace(/\s+$/u, "");
}

/** Renders a list of trunk segments as a row of colored Text elements. */
export function TrunkSegments(
  props: { segs: TrunkSegment[] },
): React.ReactElement {
  return (
    <>
      {props.segs.map((s, i) => (
        <Box key={i} flexShrink={0}>
          <Text color={s.color} dimColor={s.dimColor}>{s.text}</Text>
        </Box>
      ))}
    </>
  );
}

export function StackBand(props: StackBandProps): React.ReactElement {
  const header = props.mergeStrategy
    ? `Stack: ${props.stackName} (${props.mergeStrategy})`
    : `Stack: ${props.stackName}`;

  const sorted = [...props.cells].sort((a, b) => a.row - b.row);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Stack header row */}
      <Box flexDirection="row" flexShrink={0}>
        <TrunkSegments segs={props.headerPrefix} />
        <Text color={props.color} bold>{header}</Text>
      </Box>
      {sorted.map((cell, i) => {
        const top = topPrefix(cell);
        const bottom = bottomPrefix(cell);
        const info = infoLine(props.prData.get(cell.branch));
        const focused = props.focusedBranch === cell.branch;
        const nameStyle = focused ? { inverse: true } : {};
        const railStr = i < sorted.length - 1 ? railPrefix(cell) : "";
        return (
          <Box key={cell.branch} flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" flexShrink={0}>
              <TrunkSegments segs={props.contentPrefix} />
              {top.length > 0 && <Text color={props.color}>{top}</Text>}
              <Text color={props.color} {...nameStyle}>{cell.branch}</Text>
            </Box>
            <Box flexDirection="row" flexShrink={0}>
              <TrunkSegments segs={props.contentPrefix} />
              {bottom.length > 0 && <Text color={props.color}>{bottom}</Text>}
              <Text dimColor {...nameStyle}>{info}</Text>
            </Box>
            {i < sorted.length - 1 && (
              <Box flexDirection="row" flexShrink={0}>
                <TrunkSegments segs={props.contentPrefix} />
                {railStr.length > 0 && (
                  <Text color={props.color}>{railStr}</Text>
                )}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
