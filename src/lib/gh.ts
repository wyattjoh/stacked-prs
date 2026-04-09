/** Current mock directory, if set. */
let _mockDir: string | undefined;

/** Set mock directory for testing. Pass undefined to disable. */
export function setMockDir(dir: string | undefined): void {
  _mockDir = dir;
}

/** Lazily read mock dir. Catches permission errors when --allow-env is missing. */
function getMockDir(): string | undefined {
  if (_mockDir !== undefined) return _mockDir;
  try {
    return Deno.env.get("GH_MOCK_DIR");
  } catch {
    return undefined;
  }
}

/** Derive a fixture filename from gh CLI arguments. */
export function fixtureKey(args: string[]): string {
  // Strip query-modifier flags and their following values. These describe
  // *how* a query is shaped (which fields, which states) rather than *what*
  // is being queried, so a fixture keyed by "branch X" should match regardless
  // of the field/state modifiers the caller used.
  const STRIPPED_FLAGS = new Set(["--json", "--state"]);
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (STRIPPED_FLAGS.has(args[i])) {
      i++; // skip the value too
      continue;
    }
    filtered.push(args[i]);
  }

  return filtered
    .join("-")
    .replace(/\//g, "-") // slashes to dashes
    .replace(/[^a-zA-Z0-9\-_]/g, "-") // non-alphanumeric (except - and _) to dash
    .replace(/-{3,}/g, "--") // collapse 3+ consecutive dashes to double-dash (preserves -- from flags)
    .replace(/^-|-$/g, ""); // trim leading/trailing dashes
}

/** Options accepted by the `gh` function's overloaded form. */
export interface GhOptions {
  signal?: AbortSignal;
}

/**
 * Run a gh command. Returns stdout as string.
 *
 * Two call shapes are supported:
 *   gh("repo", "view")                              // existing rest-arg form
 *   gh({ signal }, "repo", "view")                  // with cancellation
 */
export function gh(...args: string[]): Promise<string>;
export function gh(
  options: GhOptions,
  ...args: string[]
): Promise<string>;
export async function gh(
  optionsOrFirstArg: GhOptions | string,
  ...rest: string[]
): Promise<string> {
  let signal: AbortSignal | undefined;
  let args: string[];
  if (typeof optionsOrFirstArg === "string") {
    args = [optionsOrFirstArg, ...rest];
  } else {
    signal = optionsOrFirstArg.signal;
    args = rest;
  }

  if (signal?.aborted) {
    const err = new Error("gh call aborted");
    err.name = "AbortError";
    throw err;
  }

  const mockDir = getMockDir();

  if (mockDir) {
    const key = fixtureKey(args);
    const path = `${mockDir}/${key}.json`;
    try {
      return await Deno.readTextFile(path);
    } catch {
      return "[]";
    }
  }

  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
    signal,
  });
  const { stdout, success, stderr } = await cmd.output();
  if (!success) {
    throw new Error(new TextDecoder().decode(stderr));
  }
  return new TextDecoder().decode(stdout);
}

/**
 * Pick a single PR to surface from a `gh pr list --state all` result.
 *
 * Precedence (newest-first within each state, by `createdAt`):
 *   OPEN > MERGED > CLOSED
 *
 * An open PR shadows any prior merged/closed PR on the same head ref, so a
 * reopened workflow reads as "open" rather than flickering to "merged". When
 * there's no open PR, the most recent MERGED surfaces — this is the fix for
 * branches whose GitHub PR has been squash-merged and whose remote head ref
 * is gone.
 */
export function selectBestPr<
  T extends { state: string; createdAt?: string },
>(prs: T[]): T | null {
  if (prs.length === 0) return null;
  const byPriority = (s: string): number => {
    const u = s.toUpperCase();
    if (u === "OPEN") return 0;
    if (u === "MERGED") return 1;
    return 2; // CLOSED / anything else
  };
  const sorted = [...prs].sort((a, b) => {
    const pa = byPriority(a.state);
    const pb = byPriority(b.state);
    if (pa !== pb) return pa - pb;
    const ca = a.createdAt ?? "";
    const cb = b.createdAt ?? "";
    // Newest first within the same bucket.
    if (ca !== cb) return cb.localeCompare(ca);
    return 0;
  });
  return sorted[0];
}

/** Write a fixture file for tests. */
export async function writeFixture(
  mockDir: string,
  args: string[],
  data: unknown,
): Promise<void> {
  const key = fixtureKey(args);
  await Deno.writeTextFile(`${mockDir}/${key}.json`, JSON.stringify(data));
}
