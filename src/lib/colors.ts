/** Light or dark terminal theme. Drives palette selection in `assignColors`. */
export type ThemeName = "light" | "dark";

export const DARK_PALETTE = [
  "cyan",
  "magenta",
  "blue",
  "cyanBright",
  "magentaBright",
  "blueBright",
  "green",
  "yellow",
] as const;

export const LIGHT_PALETTE = [
  "cyan",
  "magenta",
  "blue",
  "cyanBright",
  "magentaBright",
  "blueBright",
  "green",
  "red",
] as const;

/** FNV-1a 32-bit hash of a string. Deterministic, no external deps. */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Detect light/dark theme from the COLORFGBG env var. Defaults to dark. */
export function detectTheme(colorfgbg: string | undefined): ThemeName {
  if (!colorfgbg) return "dark";
  const parts = colorfgbg.split(";");
  if (parts.length < 2) return "dark";
  const bg = Number.parseInt(parts[parts.length - 1], 10);
  if (Number.isNaN(bg)) return "dark";
  return bg >= 7 ? "light" : "dark";
}

/**
 * Assign a color to each stack name.
 *
 * 1. Overrides from git config are applied first and their colors marked taken.
 * 2. Remaining stacks (sorted alphabetically) hash to a starting slot via FNV-1a,
 *    and linear-probe forward if the slot is taken.
 * 3. If all slots are taken (9+ stacks, no overrides), accept the collision.
 */
export function assignColors(
  stackNames: string[],
  overrides: Map<string, string>,
  theme: ThemeName,
): Map<string, string> {
  const palette = theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const result = new Map<string, string>();
  const used = new Set<string>();

  for (const [name, color] of overrides) {
    if (stackNames.includes(name)) {
      result.set(name, color);
      used.add(color);
    }
  }

  const remaining = stackNames.filter((n) => !result.has(n)).slice().sort();

  for (const name of remaining) {
    const start = fnv1a(name) % palette.length;
    let picked: string | undefined;
    for (let i = 0; i < palette.length; i++) {
      const candidate = palette[(start + i) % palette.length];
      if (!used.has(candidate)) {
        picked = candidate;
        break;
      }
    }
    if (picked === undefined) {
      picked = palette[start % palette.length];
    } else {
      used.add(picked);
    }
    result.set(name, picked);
  }

  return result;
}

/** Read color overrides from git config: `stack.<name>.color = <color>`. */
export async function readColorOverrides(
  stackNames: string[],
  runGit: (
    ...args: string[]
  ) => Promise<{ code: number; stdout: string }>,
): Promise<Map<string, string>> {
  const overrides = new Map<string, string>();
  for (const name of stackNames) {
    const { code, stdout } = await runGit(
      "config",
      `stack.${name}.color`,
    );
    if (code === 0 && stdout.trim()) {
      overrides.set(name, stdout.trim());
    }
  }
  return overrides;
}
