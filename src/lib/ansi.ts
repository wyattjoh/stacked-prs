import * as colors from "@std/fmt/colors";

/**
 * Map an Ink color name (as returned by `assignColors` in `./colors.ts`) to a
 * function that wraps text in the corresponding ANSI escape codes from
 * `@std/fmt/colors`. Falls back to identity for unknown names. `@std/fmt/colors`
 * honors `NO_COLOR` and TTY detection automatically, so callers do not need
 * to gate this themselves.
 */
export function ansiColor(name: string): (text: string) => string {
  switch (name) {
    case "black":
      return colors.black;
    case "red":
      return colors.red;
    case "green":
      return colors.green;
    case "yellow":
      return colors.yellow;
    case "blue":
      return colors.blue;
    case "magenta":
      return colors.magenta;
    case "cyan":
      return colors.cyan;
    case "white":
      return colors.white;
    case "gray":
    case "grey":
      return colors.gray;
    case "blackBright":
      return colors.brightBlack;
    case "redBright":
      return colors.brightRed;
    case "greenBright":
      return colors.brightGreen;
    case "yellowBright":
      return colors.brightYellow;
    case "blueBright":
      return colors.brightBlue;
    case "magentaBright":
      return colors.brightMagenta;
    case "cyanBright":
      return colors.brightCyan;
    case "whiteBright":
      return colors.brightWhite;
    default:
      return (text: string) => text;
  }
}
