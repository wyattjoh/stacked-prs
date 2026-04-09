import React from "react";
import { Box, Text } from "ink";
import type { CommitsCellState, PrCellState, SyncStatus } from "../types.ts";

const VISIBLE_COMMITS = 5;

export interface DetailPaneProps {
  branch: string | null;
  prCell: PrCellState | undefined;
  syncStatus: SyncStatus | undefined;
  commitsCell: CommitsCellState | undefined;
  focused?: boolean;
  scrollX?: number;
  scrollY?: number;
}

function headerLine(
  branch: string,
  prCell: PrCellState | undefined,
  sync: SyncStatus | undefined,
): string {
  const parts: string[] = [branch];
  if (prCell?.status === "loaded" && prCell.pr) {
    parts.push(`#${prCell.pr.number}`);
    parts.push(prCell.pr.isDraft ? "draft" : prCell.pr.state.toLowerCase());
  } else if (prCell?.status === "loaded") {
    parts.push("(no PR)");
  } else if (prCell?.status === "loading") {
    parts.push("(loading PR)");
  } else if (prCell?.status === "error") {
    parts.push("(gh error)");
  }
  if (sync) parts.push(sync);
  return parts.join("  ");
}

export function DetailPane(props: DetailPaneProps): React.ReactElement {
  const borderColor = props.focused ? "cyan" : undefined;

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

  const header = headerLine(props.branch, props.prCell, props.syncStatus);
  const scrollX = Math.max(0, props.scrollX ?? 0);
  const scrollY = Math.max(0, props.scrollY ?? 0);

  let body: React.ReactNode;
  if (!props.commitsCell || props.commitsCell.status === "loading") {
    body = <Text dimColor>loading commits...</Text>;
  } else if (props.commitsCell.status === "error") {
    body = <Text dimColor>error loading commits</Text>;
  } else {
    const commits = props.commitsCell.commits;
    const start = Math.min(scrollY, Math.max(0, commits.length - 1));
    const shown = commits.slice(start, start + VISIBLE_COMMITS);
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

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      flexDirection="column"
      height={8}
    >
      <Text>{header}</Text>
      {body}
    </Box>
  );
}
