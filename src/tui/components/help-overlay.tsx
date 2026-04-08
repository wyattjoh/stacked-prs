import React from "react";
import { Box, Text } from "ink";

export interface KeyBinding {
  keys: string;
  action: string;
}

/**
 * Compact status-bar entries in priority order. The status bar shows as
 * many of these as fit in the terminal width, left-to-right. Keep each
 * label short; full descriptions live in {@link KEY_BINDINGS}.
 */
export const STATUS_BAR_ITEMS: KeyBinding[] = [
  { keys: "?", action: "help" },
  { keys: "q", action: "quit" },
  { keys: "o", action: "open" },
  { keys: "y", action: "yank" },
  { keys: "Y", action: "yank url" },
  { keys: "r", action: "refresh" },
  { keys: "R", action: "refresh all" },
  { keys: "g/G", action: "top/bot" },
  { keys: "[/]", action: "prev/next stack" },
  { keys: "tab", action: "next tab" },
  { keys: "1-9", action: "tab N" },
  { keys: "hjkl", action: "move" },
];

/**
 * Build a status bar line that fits in `width` columns. Items are joined
 * with a two-space separator and truncated greedily when the next item
 * would overflow. Always renders at least the first item to keep the bar
 * from ever being empty.
 */
export function buildStatusBar(width: number): string {
  const sep = "  ";
  const parts: string[] = [];
  let used = 0;
  for (const item of STATUS_BAR_ITEMS) {
    const piece = `${item.keys} ${item.action}`;
    const next = parts.length === 0
      ? piece.length
      : used + sep.length + piece.length;
    if (parts.length > 0 && next > width) break;
    parts.push(piece);
    used = next;
  }
  return parts.join(sep);
}

export const KEY_BINDINGS: KeyBinding[] = [
  { keys: "↑ ↓ ← →", action: "move cursor" },
  { keys: "h j k l", action: "vim aliases for movement" },
  { keys: "tab / shift-tab", action: "next / previous tab" },
  { keys: "1-9", action: "jump to tab N" },
  { keys: "r", action: "refresh current tab" },
  { keys: "R", action: "refresh all tabs" },
  { keys: "g / G", action: "first / last branch in stack" },
  { keys: "[ / ] or pgup/pgdn", action: "previous / next stack" },
  { keys: "o", action: "open focused PR in browser" },
  { keys: "y", action: "copy branch name to clipboard" },
  { keys: "Y", action: "copy PR URL to clipboard" },
  { keys: "?", action: "toggle this help" },
  { keys: "q / esc / ctrl-c", action: "quit" },
];

export function HelpOverlay(): React.ReactElement {
  return (
    <Box borderStyle="double" flexDirection="column" padding={1}>
      <Text bold>Key Bindings</Text>
      <Box flexDirection="column" marginTop={1}>
        {KEY_BINDINGS.map((b, i) => (
          <Box key={i}>
            <Text>
              {b.keys.padEnd(24)}
              {b.action}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
