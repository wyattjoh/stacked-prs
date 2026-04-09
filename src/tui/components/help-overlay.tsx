import React from "react";
import { Box, Text } from "ink";

export interface KeyBinding {
  keys: string;
  action: string;
}

/**
 * Compact status-bar entries in priority order. Each entry is a bracketed
 * key hint. The status bar greedily fits as many as will fit in the terminal
 * width, left-to-right. Full descriptions live in {@link KEY_BINDINGS_BY_SECTION}
 * and are shown via the help overlay (`?`).
 */
export const STATUS_BAR_ITEMS: readonly string[] = [
  "[?]",
  "[q]",
  "[tab]",
  "[←↑↓→]",
  "[L]",
  "[p]",
  "[b]",
  "[r]",
  "[g/G]",
  "[pgup/pgdn]",
];

/**
 * Build a status bar line that fits in `width` columns. Items are joined
 * with a single space and truncated greedily when the next item would
 * overflow. Always renders at least the first item.
 */
export function buildStatusBar(width: number): string {
  const sep = " ";
  const parts: string[] = [];
  let used = 0;
  for (const item of STATUS_BAR_ITEMS) {
    const next = parts.length === 0
      ? item.length
      : used + sep.length + item.length;
    if (parts.length > 0 && next > width) break;
    parts.push(item);
    used = next;
  }
  return parts.join(sep);
}

export interface KeyBindingSection {
  title: string;
  bindings: KeyBinding[];
}

export const KEY_BINDINGS_BY_SECTION: readonly KeyBindingSection[] = [
  {
    title: "Navigation",
    bindings: [
      { keys: "tab / shift-tab", action: "cycle focus header / body / detail" },
      { keys: "↑ ↓ ← →", action: "navigate within focused section" },
      { keys: "g / G", action: "first / last branch in stack (body)" },
      { keys: "pgup / pgdn", action: "previous / next stack (body)" },
    ],
  },
  {
    title: "Actions",
    bindings: [
      { keys: "L", action: "land stack (merged root or all merged)" },
      { keys: "p", action: "open focused PR in browser" },
      { keys: "b", action: "copy branch name to clipboard" },
      { keys: "r", action: "refresh all" },
    ],
  },
  {
    title: "View",
    bindings: [
      { keys: "?", action: "toggle this help" },
      { keys: "q / esc / ctrl-c", action: "quit" },
    ],
  },
];

export function HelpOverlay(): React.ReactElement {
  return (
    <Box borderStyle="double" flexDirection="column" padding={1}>
      <Text bold>Key Bindings</Text>
      {KEY_BINDINGS_BY_SECTION.map((section) => (
        <Box key={section.title} flexDirection="column" marginTop={1}>
          <Text bold underline>{section.title}</Text>
          {section.bindings.map((b, i) => (
            <Box key={`${section.title}-${i}`}>
              <Text>
                {b.keys.padEnd(24)}
                {b.action}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
