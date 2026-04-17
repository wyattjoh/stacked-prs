import DataLoader from "dataloader";

/**
 * Per-command git ref batcher. Callers issue `load(ref)` (e.g.
 * `refs/heads/feat/a`, `refs/remotes/origin/main`); concurrent requests
 * that fire in the same microtask tick coalesce into a single
 * `git cat-file --batch-check='%(objectname)'` subprocess instead of
 * one `git rev-parse` subprocess per caller. Unknown refs resolve to
 * `null` (DataLoader treats `Error` instances as per-key failures, but
 * an absent ref is an expected outcome for us, not an error).
 */
export type RefLoader = DataLoader<string, string | null>;

/**
 * Build a ref loader for `dir`. The underlying batch function uses
 * `git cat-file --batch-check` so DataLoader can ask about arbitrary
 * ref names (branches, remote-tracking refs, tags, raw SHAs) in one
 * git subprocess regardless of how many keys are in the batch.
 */
export function createRefLoader(dir: string): RefLoader {
  return new DataLoader<string, string | null>(
    async (refs) => {
      const input = refs.join("\n") + "\n";
      const cmd = new Deno.Command("git", {
        args: ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd: dir,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const child = cmd.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
      const { stdout, success } = await child.output();
      if (!success) {
        return refs.map(() => null);
      }
      const lines = new TextDecoder().decode(stdout).split("\n");
      // `cat-file --batch-check` emits one line per input ref in order:
      // "<sha> <type>" for resolvable refs, "<ref> missing" otherwise.
      return refs.map((_, i) => {
        const line = lines[i] ?? "";
        if (!line || line.endsWith("missing")) return null;
        const [sha] = line.split(" ");
        return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
      });
    },
    {
      // Hot-path planners ask for the same ref repeatedly (for example,
      // every `getStackTree` walk re-resolves `origin/<base>`). Enable
      // per-key caching within the loader's lifetime so the repeat
      // requests are free after the first batch.
      cache: true,
    },
  );
}

// Per-invocation active loader slot. Mirrors the PR-index pattern in
// `gh.ts`: CLI handlers install a loader, every downstream caller of
// `tryResolveRef` / `revParse` benefits transparently, and the slot
// clears when the handler returns.
let _activeRefLoader: RefLoader | null = null;

/**
 * Install a ref loader so `tryResolveRef` / `revParse` coalesce their
 * subprocess calls through it. Returns a disposer that restores the
 * previous slot; callers should invoke it in a finally block so nested
 * commands don't leak state.
 */
export function setActiveRefLoader(loader: RefLoader | null): () => void {
  const prev = _activeRefLoader;
  _activeRefLoader = loader;
  return () => {
    _activeRefLoader = prev;
  };
}

/** Current active loader, or null if none. Exposed for `stack.ts`. */
export function getActiveRefLoader(): RefLoader | null {
  return _activeRefLoader;
}

/**
 * Wrap `fn` so every `tryResolveRef` / `revParse` call inside it
 * batches through a shared loader. Disposes the slot on exit.
 */
export async function withRefLoader<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const loader = createRefLoader(dir);
  const dispose = setActiveRefLoader(loader);
  try {
    return await fn();
  } finally {
    dispose();
    loader.clearAll();
  }
}

/**
 * Invalidate cached entries for specific refs. Execution-phase code
 * calls this after mutations (push, rebase, branch delete) so
 * subsequent `tryResolveRef` / `revParse` sees the fresh SHA instead of
 * a cached stale one.
 */
export function invalidateRefs(refs: readonly string[]): void {
  if (!_activeRefLoader) return;
  for (const ref of refs) {
    _activeRefLoader.clear(ref);
  }
}
