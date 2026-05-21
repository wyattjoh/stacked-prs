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
 * Assign a color to each name (typically a root branch name).
 *
 * Names are sorted alphabetically before assignment so the mapping is stable
 * regardless of input order. Each name hashes to a starting palette slot via
 * FNV-1a and linear-probes forward to avoid collisions. When all slots are
 * taken (more names than palette entries), the collision is accepted and the
 * hash slot is reused.
 */
export function assignColors(
  names: string[],
  theme: ThemeName,
): Map<string, string> {
  const palette = theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const result = new Map<string, string>();
  const used = new Set<string>();

  const sorted = names.slice().sort();
  for (const name of sorted) {
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
