import React from "react";
import { Box, Text } from "ink";
import type { TabId } from "../types.ts";

export interface TabBarProps {
  stacks: string[];
  activeTab: TabId;
  loadingCount: number;
  totalLoadCount: number;
}

function isActive(active: TabId, tab: TabId): boolean {
  if (active === "all" && tab === "all") return true;
  if (active !== "all" && tab !== "all") return active.stack === tab.stack;
  return false;
}

export function TabBar(props: TabBarProps): React.ReactElement {
  const tabs: TabId[] = ["all", ...props.stacks.map((s) => ({ stack: s }))];

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">
        <Text>stacked-prs</Text>
        {tabs.map((tab, i) => {
          const label = tab === "all" ? "[All]" : tab.stack;
          const active = isActive(props.activeTab, tab);
          return (
            <Box key={i}>
              <Text inverse={active}>
                {" "}
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {props.loadingCount > 0 && (
        <Text dimColor>
          loading PRs {props.loadingCount}/{props.totalLoadCount}
        </Text>
      )}
    </Box>
  );
}
