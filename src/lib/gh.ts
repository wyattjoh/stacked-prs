/** Current mock directory, if set. */
let _mockDir: string | undefined;

/** Set mock directory for testing. Pass undefined to disable. */
export function setMockDir(dir: string | undefined): void {
  _mockDir = dir;
}

/**
 * Optional call log. When set by tests, every `gh(...)` invocation
 * appends its args (copied) to this array, regardless of whether a
 * mock fixture is active. Pass `undefined` to disable.
 */
let _callLog: string[][] | undefined;

/** Set a call log sink for testing. Pass undefined to disable. */
export function setCallLog(log: string[][] | undefined): void {
  _callLog = log;
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

  if (_callLog) _callLog.push([...args]);

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

export interface GhPrListInfo {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt?: string;
}

export interface ListPrsForBranchOptions extends GhOptions {
  owner?: string;
  repo?: string;
}

/**
 * Query `gh pr list --head <branch> --state all` and return the best PR
 * via `selectBestPr`. Consolidates the identical query + parse + select
 * pattern that otherwise lives in pr.ts, status.ts, loader.ts, and
 * land's cli fetch loop. Pass `{owner, repo}` to scope the query to a
 * specific repo (required when `gh` can't infer it from the cwd).
 */
export async function listPrsForBranch(
  branch: string,
  opts: ListPrsForBranchOptions = {},
): Promise<GhPrListInfo | null> {
  const args = ["pr", "list", "--head", branch];
  if (opts.owner && opts.repo) {
    args.push("--repo", `${opts.owner}/${opts.repo}`);
  }
  args.push("--state", "all");
  args.push("--json", "number,url,state,isDraft,createdAt");
  const result = opts.signal
    ? await gh({ signal: opts.signal }, ...args)
    : await gh(...args);
  const parsed = JSON.parse(result) as GhPrListInfo[];
  return selectBestPr(parsed);
}

/**
 * Resolve the GitHub owner and repo name for the current repository.
 *
 * Accepts optional explicit overrides; when both are provided the gh CLI
 * is never called. Otherwise shells out to `gh repo view --json owner,name`
 * and extracts the scalar `owner.login` string. The nested object shape is
 * a common source of bugs — callers that inline-parse the JSON and forget
 * `.login` end up with "[object Object]" in template literals.
 */
export async function resolveRepo(
  explicitOwner?: string,
  explicitRepo?: string,
): Promise<{ owner: string; repo: string }> {
  if (explicitOwner && explicitRepo) {
    return { owner: explicitOwner, repo: explicitRepo };
  }

  const result = await gh("repo", "view", "--json", "owner,name");
  const parsed = JSON.parse(result) as {
    owner: { login: string };
    name: string;
  };
  return { owner: parsed.owner.login, repo: parsed.name };
}

/**
 * Same as `resolveRepo` but returns null instead of throwing when the repo
 * cannot be resolved (e.g. no gh auth, no remote, etc.). Convenience for
 * code paths that degrade gracefully without owner/repo info.
 */
export async function resolveRepoOrNone(): Promise<
  { owner: string; repo: string } | null
> {
  try {
    return await resolveRepo();
  } catch {
    return null;
  }
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
