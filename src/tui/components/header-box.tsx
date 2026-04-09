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
  const total = props.stacks.length + 1;
  const activeIdx = props.activeTab === "all"
    ? 0
    : Math.max(0, props.stacks.indexOf(props.activeTab.stack) + 1);
  const position = `[${activeIdx + 1}/${total}]`;

  const active = props.activeTab === "all"
    ? { kind: "all" as const, label: "All stacks", color: "gray" }
    : {
      kind: "stack" as const,
      label: props.activeTab.stack,
      color: props.colorByStack.get(props.activeTab.stack) ?? "gray",
    };

  // Border: active stack color when focused on a stack tab; gray otherwise.
  const borderColor = props.focused && active.kind === "stack"
    ? active.color
    : "gray";

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
        <Text color={active.color}>{`● `}</Text>
        <Text bold color={props.focused ? props.primaryColor : undefined}>
          {active.label}
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
