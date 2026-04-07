import React from "react";
import { Box, Text } from "ink";

export interface KeyBinding {
  keys: string;
  action: string;
}

export const KEY_BINDINGS: KeyBinding[] = [
  { keys: "↑ ↓ ← →", action: "move cursor" },
  { keys: "h j k l", action: "vim aliases for movement" },
  { keys: "tab / shift-tab", action: "next / previous tab" },
  { keys: "1-9", action: "jump to tab N" },
  { keys: "r", action: "refresh current tab" },
  { keys: "R", action: "refresh all tabs" },
  { keys: "g / G", action: "first / last branch in stack" },
  { keys: "[ / ]", action: "previous / next stack" },
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
              {b.keys.padEnd(20)}
              {b.action}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
