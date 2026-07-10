import React from "react";
import { Box, Text } from "ink";
import { type MdSpan, wrapMarkdown } from "../../lib/markdown.ts";
import type {
  CommitsCellState,
  PrCellState,
  PrInfo,
  SyncStatus,
  WorktreeInfo,
} from "../types.ts";

/**
 * Row budget for the scrollable body (description + separator + commits).
 * The fixed pane height of 10 gives an inner content area of 8 rows; we
 * reserve 2 for the header + worktree metadata, leaving 6 body rows. When
 * both scroll markers are visible the shown-row count drops so the markers
 * still fit inside the box. Keep `CHROME_HEIGHT_BASE` in `app.tsx` in sync
 * with `PANE_HEIGHT`.
 */
const PANE_HEIGHT = 10;
const BODY_BUDGET = PANE_HEIGHT - 2 /* border */ - 2 /* header + worktree */;

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
  /** Raw markdown description for the focused branch, when set. */
  description?: string;
  /** Outer pane width in columns; used to wrap the description. */
  width?: number;
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

  type BodyLine =
    | { kind: "md"; spans: MdSpan[] }
    | { kind: "text"; text: string; dim?: boolean }
    | { kind: "blank" };

  const contentWidth = Math.max(10, (props.width ?? 80) - 2);
  const bodyLines: BodyLine[] = [];
  if (props.description) {
    for (const spans of wrapMarkdown(props.description, contentWidth)) {
      bodyLines.push(
        spans.length === 0 ? { kind: "blank" } : { kind: "md", spans },
      );
    }
  }
  bodyLines.push({ kind: "blank" });
  if (!props.commitsCell || props.commitsCell.status === "loading") {
    bodyLines.push({ kind: "text", text: "loading commits...", dim: true });
  } else if (props.commitsCell.status === "error") {
    bodyLines.push({ kind: "text", text: "error loading commits", dim: true });
  } else {
    for (const commit of props.commitsCell.commits) {
      bodyLines.push({
        kind: "text",
        text: `${commit.sha} ${commit.subject}`,
      });
    }
  }

  const fitsInBudget = bodyLines.length <= BODY_BUDGET;
  const cap = fitsInBudget ? BODY_BUDGET : Math.max(1, BODY_BUDGET - 2);
  const start = Math.min(scrollY, Math.max(0, bodyLines.length - cap));
  const shown = bodyLines.slice(start, start + cap);
  const above = start;
  const below = Math.max(0, bodyLines.length - (start + shown.length));

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
      <Box flexDirection="column">
        {above > 0 && <Text dimColor>↑ {above} more</Text>}
        {shown.map((line, i) => {
          if (line.kind === "blank") return <Box key={i} height={1} />;
          if (line.kind === "md") {
            return (
              <Box key={i}>
                <Text dimColor>
                  {line.spans.map((span, j) => (
                    <React.Fragment key={j}>
                      <Text
                        bold={span.bold}
                        italic={span.italic}
                        underline={span.underline || span.url !== undefined}
                        color={span.code ? "cyan" : undefined}
                        dimColor
                      >
                        {span.url !== undefined
                          ? `${span.text} (${span.url})`
                          : span.text}
                      </Text>
                    </React.Fragment>
                  ))}
                </Text>
              </Box>
            );
          }
          const clipped = scrollX > 0 ? line.text.slice(scrollX) : line.text;
          return (
            <Box key={i}>
              <Text dimColor={line.dim}>{clipped}</Text>
            </Box>
          );
        })}
        {below > 0 && (
          <Box justifyContent="space-between">
            <Text dimColor>↓ {below} more</Text>
            <Text dimColor>j/k for navigation</Text>
          </Box>
        )}
        {below === 0 && above > 0 && (
          <Box justifyContent="flex-end">
            <Text dimColor>j/k for navigation</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
