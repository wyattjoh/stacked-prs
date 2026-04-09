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
 * currently active view (not the full tab list). Border color matches the
 * body wrapper: primary (white on dark, black on light) when focused, muted
 * gray otherwise. The active stack's identity color shows up on the `●` dot
 * and in the stack label's color accent instead of on the border.
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

  // Border: primary focus color when focused (matches the body wrapper),
  // gray otherwise. The active stack color lives on the `●` dot instead.
  const borderColor = props.focused ? props.primaryColor : "gray";

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
        <Text dimColor={!props.focused}>{`stacked-prs   `}</Text>
        <Text color={active.color}>{`● `}</Text>
        <Text bold color={props.focused ? props.primaryColor : undefined}>
          {active.label}
        </Text>
        <Text dimColor={!props.focused}>{`  ${position}`}</Text>
      </Box>
      {props.loadingCount > 0
        ? (
          <Box flexShrink={0}>
            <Text dimColor={!props.focused}>
              ↻ loading {props.loadingCount}/{props.totalLoadCount}
            </Text>
          </Box>
        )
        : null}
      <Box flexShrink={0}>
        <Text dimColor={!props.focused}>← → views</Text>
      </Box>
    </Box>
  );
}
