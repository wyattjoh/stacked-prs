import React from "react";
import { Box, Text } from "ink";
import type { TabId } from "../types.ts";

export interface TabBarProps {
  stacks: string[];
  activeTab: TabId;
  loadingCount: number;
  totalLoadCount: number;
  focused?: boolean;
}

function isActive(active: TabId, tab: TabId): boolean {
  if (active === "all" && tab === "all") return true;
  if (active !== "all" && tab !== "all") return active.stack === tab.stack;
  return false;
}

export function TabBar(props: TabBarProps): React.ReactElement {
  const tabs: TabId[] = ["all", ...props.stacks.map((s) => ({ stack: s }))];

  // The tab bar must render as exactly one row: `app.tsx` reserves a fixed
  // single line of chrome for it when computing the stack-map viewport
  // height, and the cursor-follow scroll effect breaks if the tab bar wraps.
  // `overflowX="hidden"` + `flexShrink={0}` on every child keeps long tab
  // labels on one line and lets the right edge get clipped instead of wrapped.
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      overflowX="hidden"
      height={1}
      flexShrink={0}
    >
      <Box flexDirection="row" flexShrink={0}>
        <Box flexShrink={0}>
          <Text bold={props.focused} wrap="truncate-end">
            {props.focused ? "▶ stacked-prs" : "  stacked-prs"}
          </Text>
        </Box>
        {tabs.map((tab, i) => {
          const label = tab === "all" ? "[All]" : tab.stack;
          const active = isActive(props.activeTab, tab);
          return (
            <Box key={i} flexShrink={0}>
              <Text inverse={active} wrap="truncate-end">
                {" "}
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {props.loadingCount > 0 && (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            loading PRs {props.loadingCount}/{props.totalLoadCount}
          </Text>
        </Box>
      )}
    </Box>
  );
}
