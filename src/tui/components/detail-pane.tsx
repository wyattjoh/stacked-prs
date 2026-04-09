import React from "react";
import { Box, Text } from "ink";
import type {
  CommitsCellState,
  PrCellState,
  PrInfo,
  SyncStatus,
  WorktreeInfo,
} from "../types.ts";

/**
 * Row budget for the commits body. The fixed pane height of 10 gives an
 * inner content area of 8 rows; we reserve 2 for the header + worktree
 * metadata and 1 for the blank separator, leaving 5 rows for commits.
 * When both scroll markers are visible the shown-commit count drops so
 * the markers still fit inside the box. Keep `CHROME_HEIGHT_BASE` in
 * `app.tsx` in sync with `PANE_HEIGHT`.
 */
const PANE_HEIGHT = 10;
const BODY_BUDGET = PANE_HEIGHT - 2 /* border */ - 2 /* header + worktree */ -
  1 /* blank separator */;

interface PrSegment {
  text: string;
  color?: string;
  dim?: boolean;
}

function prSegment(cell: PrCellState | undefined): PrSegment | null {
  if (!cell) return null;
  if (cell.status === "loading") return { text: "(loading PR)", dim: true };
  if (cell.status === "error") return { text: "(gh error)", dim: true };
  // status === "loaded"
  const pr = cell.pr;
  if (!pr) return { text: "○ no PR", dim: true };
  const text = `#${pr.number} ${glyphFor(pr)} ${
    pr.isDraft ? "draft" : pr.state.toLowerCase()
  }`;
  if (pr.isDraft) return { text, color: "yellow" };
  const s = pr.state.toUpperCase();
  if (s === "MERGED") return { text, color: "magenta" };
  if (s === "OPEN") return { text, color: "green" };
  return { text, dim: true };
}

function glyphFor(pr: PrInfo): string {
  if (pr.isDraft) return "◐";
  const s = pr.state.toUpperCase();
  if (s === "MERGED") return "◉";
  if (s === "CLOSED") return "✗";
  return "●";
}

function syncColor(sync: SyncStatus | undefined): string | undefined {
  if (sync === "up-to-date") return "green";
  if (sync === "behind-parent") return "yellow";
  if (sync === "diverged") return "red";
  return undefined;
}

function worktreePathColor(wt: WorktreeInfo | undefined): string | undefined {
  if (!wt) return undefined;
  return wt.dirty ? "yellow" : "green";
}

export interface DetailPaneProps {
  branch: string | null;
  prCell: PrCellState | undefined;
  syncStatus: SyncStatus | undefined;
  commitsCell: CommitsCellState | undefined;
  worktree: WorktreeInfo | undefined;
  focused?: boolean;
  scrollX?: number;
  scrollY?: number;
  primaryColor?: string;
}

export function DetailPane(props: DetailPaneProps): React.ReactElement {
  const borderColor = props.focused ? (props.primaryColor ?? "white") : "gray";

  if (!props.branch) {
    return (
      <Box
        borderStyle="single"
        borderColor={borderColor}
        flexDirection="column"
        height={3}
      >
        <Text dimColor>no branch selected</Text>
      </Box>
    );
  }

  const scrollX = Math.max(0, props.scrollX ?? 0);
  const scrollY = Math.max(0, props.scrollY ?? 0);

  const pr = prSegment(props.prCell);
  const sync = props.syncStatus;

  // Commits body: cap shown rows so that any combination of above/below
  // markers still fits inside the body budget. We reserve marker slots
  // unconditionally when the full commit list exceeds the budget.
  let body: React.ReactNode;
  if (!props.commitsCell || props.commitsCell.status === "loading") {
    body = <Text dimColor>loading commits...</Text>;
  } else if (props.commitsCell.status === "error") {
    body = <Text dimColor>error loading commits</Text>;
  } else {
    const commits = props.commitsCell.commits;
    if (commits.length === 0) {
      body = null;
    } else {
      const fitsInBudget = commits.length <= BODY_BUDGET;
      const cap = fitsInBudget ? BODY_BUDGET : Math.max(1, BODY_BUDGET - 2);
      const start = Math.min(scrollY, Math.max(0, commits.length - cap));
      const shown = commits.slice(start, start + cap);
      const above = start;
      const below = Math.max(0, commits.length - (start + shown.length));
      body = (
        <Box flexDirection="column">
          {above > 0 && <Text dimColor>↑ {above} more</Text>}
          {shown.map((c, i) => {
            const line = `${c.sha} ${c.subject}`;
            const clipped = scrollX > 0 ? line.slice(scrollX) : line;
            return (
              <Box key={i}>
                <Text>{clipped}</Text>
              </Box>
            );
          })}
          {below > 0 && <Text dimColor>↓ {below} more</Text>}
        </Box>
      );
    }
  }

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      flexDirection="column"
      height={PANE_HEIGHT}
    >
      {
        /* Row 1: branch name + PR badge + sync status, each with its own color.
          Using a single <Text> with nested <Text> children keeps this on one
          flex line so long branch names don't get flex-shrunk by Ink. */
      }
      <Text>
        {props.branch}
        {pr && <Text color={pr.color} dimColor={pr.dim}>{`  ${pr.text}`}</Text>}
        {sync && <Text color={syncColor(sync)}>{`  ${sync}`}</Text>}
      </Text>
      {/* Row 2: worktree. Label muted, value colored by dirty state. */}
      <Text>
        <Text dimColor>worktree</Text>
        {props.worktree
          ? (
            <Text color={worktreePathColor(props.worktree)}>
              {`  ${props.worktree.displayPath}${
                props.worktree.dirty ? " *" : ""
              }`}
            </Text>
          )
          : <Text dimColor>{`  (none)`}</Text>}
      </Text>
      {/* Row 3: blank separator between metadata and commits body. */}
      <Box height={1} />
      {body}
    </Box>
  );
}
