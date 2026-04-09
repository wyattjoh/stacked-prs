import React from "react";
import { Box, Text } from "ink";
import type { TabId } from "../types.ts";

export interface HeaderBoxProps {
  stacks: string[];
  activeTab: TabId;
  loadingCount: number;
  totalLoadCount: number;
  focused: boolean;
  colorByStack: Map<string, string>;
  primaryColor: string;
}

/**
 * Three-line boxed header rendered above the stack map. Shows only the
 * currently active view (not the full tab list). Border color signals focus
 * and uses the active stack's color when the header is focused and a stack
 * tab is active; muted gray otherwise.
 *
 * Renders in exactly 3 rows: top border + content line + bottom border.
 * `app.tsx` reserves 3 rows of chrome for it.
 */
export function HeaderBox(props: HeaderBoxProps): React.ReactElement {
  const order: TabId[] = ["all", ...props.stacks.map((s) => ({ stack: s }))];
  const activeIdx = order.findIndex((t) =>
    t === "all" ? props.activeTab === "all" : props.activeTab !== "all" &&
      props.activeTab.stack === (t as { stack: string }).stack
  );
  const position = `[${activeIdx + 1}/${order.length}]`;

  const isAll = props.activeTab === "all";
  const activeStackName = isAll
    ? null
    : (props.activeTab as { stack: string }).stack;
  const activeStackColor = activeStackName
    ? (props.colorByStack.get(activeStackName) ?? "white")
    : "gray";

  // Border: active stack color when focused on a stack tab; gray otherwise
  // (unfocused, or All tab active).
  const borderColor = props.focused && !isAll ? activeStackColor : "gray";

  const label = isAll ? "All stacks" : activeStackName!;
  const dotColor = isAll ? "gray" : activeStackColor;

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      flexDirection="row"
      justifyContent="space-between"
      height={3}
      flexShrink={0}
      overflowX="hidden"
    >
      <Box flexDirection="row" flexShrink={0}>
        <Text dimColor>{`stacked-prs   `}</Text>
        <Text color={dotColor}>{`● `}</Text>
        <Text bold color={props.focused ? props.primaryColor : undefined}>
          {label}
        </Text>
        <Text dimColor>{`  ${position}`}</Text>
      </Box>
      {props.loadingCount > 0
        ? (
          <Box flexShrink={0}>
            <Text dimColor>
              ↻ loading {props.loadingCount}/{props.totalLoadCount}
            </Text>
          </Box>
        )
        : null}
      <Box flexShrink={0}>
        <Text dimColor>← → views</Text>
      </Box>
    </Box>
  );
}
