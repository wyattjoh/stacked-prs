import React from "react";
import { Box, Text } from "ink";
import type { CommitsCellState, PrCellState, SyncStatus } from "../types.ts";

const MAX_COMMITS = 6;

export interface DetailPaneProps {
  branch: string | null;
  prCell: PrCellState | undefined;
  syncStatus: SyncStatus | undefined;
  commitsCell: CommitsCellState | undefined;
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
  if (!props.branch) {
    return (
      <Box borderStyle="single" flexDirection="column" height={3}>
        <Text dimColor>no branch selected</Text>
      </Box>
    );
  }

  const header = headerLine(props.branch, props.prCell, props.syncStatus);

  let body: React.ReactNode;
  if (!props.commitsCell || props.commitsCell.status === "loading") {
    body = <Text dimColor>loading commits...</Text>;
  } else if (props.commitsCell.status === "error") {
    body = <Text dimColor>error loading commits</Text>;
  } else {
    const commits = props.commitsCell.commits;
    const shown = commits.slice(0, MAX_COMMITS);
    const extra = commits.length - shown.length;
    body = (
      <Box flexDirection="column">
        {shown.map((c, i) => (
          <Box key={i}>
            <Text>
              {c.sha} {c.subject}
            </Text>
          </Box>
        ))}
        {extra > 0 && <Text dimColor>... {extra} more</Text>}
      </Box>
    );
  }

  return (
    <Box borderStyle="single" flexDirection="column" height={8}>
      <Text>{header}</Text>
      {body}
    </Box>
  );
}
