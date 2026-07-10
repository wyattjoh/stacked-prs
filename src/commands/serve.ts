import { basename, isAbsolute, join, normalize } from "@std/path";
import {
  type AllStacksStatus,
  type BranchStatus,
  getAllStackStatuses,
  type StackStatus,
} from "./status.ts";
import { createPrIndex, type PrIndex } from "../lib/gh.ts";
import { type LaneTreeNode, layoutLanes } from "../lib/graph.ts";
import { runGitCommand } from "../lib/stack.ts";
import { firstLine, renderHtml, stripInline } from "../lib/markdown.ts";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { streamSSE } from "hono/streaming";

/**
 * A Git repository rendered by the browser UI.
 */
export interface ServeRepository {
  name: string;
  path: string;
}

/**
 * GitHub repository coordinates parsed from a remote URL.
 */
export interface ServeGitHubRepository {
  owner: string;
  repo: string;
}

/**
 * Fork target drawn from one lane into another in the browser branch graph.
 */
export interface ServeBranchGraphTarget {
  lane: number;
  /** Dashed when the branching child has diverged from its parent. */
  dashed: boolean;
}

/**
 * Vertical trunk rail passing through one row in a single lane. `up`/`down` are
 * the halves above/below the row's midline, set independently so two separate
 * segments that happen to be vertically adjacent in the same lane never join.
 */
export interface ServeBranchGraphRail {
  lane: number;
  up: boolean;
  down: boolean;
  upDashed: boolean;
  downDashed: boolean;
}

/**
 * Kind of node rendered in a browser branch graph.
 */
export type ServeBranchGraphNodeKind = "repository" | "base" | "branch";

/**
 * Browser-ready branch graph row with lane and connector metadata.
 */
export interface ServeBranchGraphRow {
  id: string;
  label: string;
  branch: string;
  parent: string;
  nodeKind: ServeBranchGraphNodeKind;
  repositoryName: string | null;
  sourceBranch: string | null;
  branchStatus: ServeBranchStatus | null;
  lane: number;
  isFork: boolean;
  forkTargets: ServeBranchGraphTarget[];
  /**
   * Vertical trunk rails passing through this row, one entry per occupied lane,
   * giving the client an explicit map of which half-segments to draw.
   */
  rails: ServeBranchGraphRail[];
}

/**
 * Browser-ready branch graph for one stack.
 */
export interface ServeBranchGraph {
  rows: ServeBranchGraphRow[];
  maxLane: number;
}

/**
 * Branch status enriched with server-rendered description variants.
 */
export type ServeBranchStatus = BranchStatus & {
  /** Escaped HTML of the full markdown description. */
  descriptionHtml?: string;
  /** Plain-text first line for the collapsed row. */
  descriptionSummary?: string;
};

/**
 * Stack status enriched with browser graph metadata.
 */
export interface ServeStackStatus extends Omit<StackStatus, "branches"> {
  branches: ServeBranchStatus[];
  graph: ServeBranchGraph;
}

/**
 * CLI status payload enriched for the browser UI.
 */
export interface ServeAllStacksStatus extends Omit<AllStacksStatus, "stacks"> {
  stacks: ServeStackStatus[];
}

/**
 * Repository contributing to a shared stack-name graph.
 */
export interface ServeSharedStackRepository {
  name: string;
  path: string;
  branchCount: number;
}

/**
 * Combined graph for a stack name present in more than one repository.
 */
export interface ServeSharedStackGroup {
  stackName: string;
  repositories: ServeSharedStackRepository[];
  graph: ServeBranchGraph;
}

/**
 * Status payload returned for a rendered repository.
 */
export interface ServeRepositoryStatus extends ServeRepository {
  github: ServeGitHubRepository | null;
  status: ServeAllStacksStatus | null;
  prMetadata: "loaded" | "unavailable" | "not-github";
  error: string | null;
}

/**
 * Git file-watch detail that explains why a watched repository should refresh.
 */
export interface ServeGitWatchChange {
  eventKind: string;
  path: string;
  category: string;
}

/**
 * Cause of a live `serve` repository refresh.
 */
export type ServeReloadReason =
  | { kind: "git-watch"; changes: ServeGitWatchChange[] }
  | { kind: "pr-poll"; intervalMs: number };

/**
 * Debug callback invoked immediately before a live repository refresh starts.
 */
export type ServeDebugLog = (
  repo: ServeRepository,
  reason: ServeReloadReason,
) => void;

/**
 * Aggregate browser data for all rendered repositories.
 */
export interface ServeStatusPayload {
  repositories: ServeRepositoryStatus[];
  sharedStacks: ServeSharedStackGroup[];
}

/**
 * Live-watch configuration for the local browser server. When `enabled` is
 * false the `/api/watch` route is not registered and the client does not open
 * it. `pollIntervalMs` of 0 disables PR polling while keeping the filesystem
 * watch. `debounceMs` collapses filesystem event bursts per repository.
 */
export interface ServeWatchConfig {
  enabled: boolean;
  pollIntervalMs: number;
  debounceMs: number;
  debugLog?: ServeDebugLog;
}

const WATCH_DISABLED: ServeWatchConfig = {
  enabled: false,
  pollIntervalMs: 0,
  debounceMs: 300,
};

/**
 * Runtime options for the local browser server.
 */
export interface ServeServerOptions {
  rootDir: string;
  repositories: ServeRepository[];
  host: string;
  port: number;
  watch: ServeWatchConfig;
}

/**
 * Running local browser server.
 */
export interface ServeServer {
  url: string;
  finished: Promise<void>;
  shutdown: () => Promise<void>;
}

interface ServeBranchGraphSourceNode {
  id: string;
  label: string;
  parentId: string | null;
  parentLabel: string;
  nodeKind: ServeBranchGraphNodeKind;
  repositoryName: string | null;
  sourceBranch: string | null;
  branchStatus: ServeBranchStatus | null;
  indentChildren: boolean;
}

interface ServeBranchGraphNode extends ServeBranchGraphSourceNode {
  children: ServeBranchGraphNode[];
}

function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Describe whether a filesystem path under a watched git dir represents a
 * stack-relevant change. Ref updates (anywhere under `refs/`), `packed-refs`,
 * `config` (stack metadata lives here), `HEAD`, and `ORIG_HEAD` count; object
 * store churn, the index, lock files, and transient files do not. Matches on
 * path segments so it is OS-agnostic.
 */
export function describeRelevantGitChange(path: string): string | null {
  const segments = path.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  if (last.endsWith(".lock")) return null;
  if (last === "index" || last === "FETCH_HEAD" || last === "COMMIT_EDITMSG") {
    return null;
  }
  // Check refs before objects so a ref named "objects" is not discarded.
  if (segments.includes("refs")) return "refs";
  if (segments.includes("objects")) return null;
  return last === "config" || last === "packed-refs" || last === "HEAD" ||
      last === "ORIG_HEAD"
    ? last
    : null;
}

/**
 * Decide whether a filesystem path under a watched git dir represents a
 * stack-relevant change.
 */
export function isRelevantGitChange(path: string): boolean {
  return describeRelevantGitChange(path) !== null;
}

/**
 * Resolve the git directories to watch for a repository: the common dir (holds
 * `refs/`, `packed-refs`, `config`) and, for a linked worktree, the worktree's
 * own git dir (holds `HEAD`). Returns deduplicated absolute paths that exist on
 * disk; a repo whose git dir cannot be resolved yields an empty list.
 */
export async function resolveGitWatchPaths(dir: string): Promise<string[]> {
  const out = new Set<string>();
  for (const flag of ["--git-common-dir", "--git-dir"]) {
    const res = await runGitCommand(dir, "rev-parse", flag);
    if (res.code !== 0 || !res.stdout) continue;
    const abs = isAbsolute(res.stdout) ? res.stdout : join(dir, res.stdout);
    const norm = normalize(abs);
    try {
      const stat = await Deno.stat(norm);
      if (stat.isDirectory) out.add(norm);
    } catch {
      // Missing or unreadable git dir; skip.
    }
  }
  return [...out];
}

/**
 * Build a per-repository reload scheduler that never runs two reloads for the
 * same path at once. Triggers arriving while a reload is in flight coalesce into
 * exactly one follow-up reload, so a burst of filesystem events produces at most
 * one extra refresh.
 */
export function createReloadScheduler(
  reload: (repo: ServeRepository, reason: ServeReloadReason) => Promise<void>,
): { trigger(repo: ServeRepository, reason: ServeReloadReason): void } {
  const reloading = new Set<string>();
  const pending = new Map<
    string,
    { repo: ServeRepository; reason: ServeReloadReason }
  >();

  const run = (repo: ServeRepository, reason: ServeReloadReason): void => {
    reloading.add(repo.path);
    reload(repo, reason).catch(() => {}).finally(() => {
      reloading.delete(repo.path);
      const next = pending.get(repo.path);
      if (next) {
        pending.delete(repo.path);
        run(next.repo, next.reason);
      }
    });
  };

  return {
    trigger(repo: ServeRepository, reason: ServeReloadReason): void {
      if (reloading.has(repo.path)) {
        pending.set(repo.path, { repo, reason });
        return;
      }
      run(repo, reason);
    },
  };
}

/**
 * Watch a repository's git dirs and call `onChange` (debounced by `debounceMs`)
 * whenever a stack-relevant file changes. Returns a closer that stops the
 * watcher and clears any pending debounce timer. A repo whose git dirs cannot be
 * resolved is not watched and the closer is a no-op.
 */
export async function watchRepoFs(
  repo: ServeRepository,
  onChange: (reason: ServeReloadReason) => void,
  debounceMs: number,
): Promise<() => Promise<void>> {
  const paths = await resolveGitWatchPaths(repo.path);
  if (paths.length === 0) return () => Promise.resolve();

  let watcher: Deno.FsWatcher;
  try {
    watcher = Deno.watchFs(paths, { recursive: true });
  } catch {
    return () => Promise.resolve();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const pendingChanges = new Map<string, ServeGitWatchChange>();
  let closed = false;
  const loop = (async () => {
    for await (const event of watcher) {
      let relevant = false;
      for (const path of event.paths) {
        const category = describeRelevantGitChange(path);
        if (category === null) continue;
        relevant = true;
        pendingChanges.set(`${category}:${path}`, {
          eventKind: event.kind,
          path,
          category,
        });
      }
      if (!relevant) continue;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const changes = [...pendingChanges.values()];
        pendingChanges.clear();
        if (!closed && changes.length > 0) {
          onChange({ kind: "git-watch", changes });
        }
      }, debounceMs);
    }
  })();

  return async () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    pendingChanges.clear();
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
    await loop.catch(() => {});
  };
}

/**
 * Build browser lane metadata for graph source nodes.
 *
 * Lane placement is shared with the CLI status ladder via layoutLanes (see
 * lib/graph.ts): the first child continues its parent's lane and each
 * additional child branches one lane to the right. Rows are emitted
 * parent-first so the served graph reads top-down from the base, and fork
 * connectors only ever span a single adjacent column, so no lines cross.
 *
 * Per-row `rails` are then derived from parent links: each parent/child edge
 * fills its lane from the parent row's midline to the child row's midline,
 * giving the client an explicit continuous trunk to draw.
 */
function buildServeGraph(
  sourceNodes: ServeBranchGraphSourceNode[],
): ServeBranchGraph {
  const nodes = new Map<string, ServeBranchGraphNode>();
  for (const sourceNode of sourceNodes) {
    nodes.set(sourceNode.id, { ...sourceNode, children: [] });
  }

  const roots: LaneTreeNode<ServeBranchGraphNode>[] = [];
  for (const sourceNode of sourceNodes) {
    const node = nodes.get(sourceNode.id);
    if (!node) continue;

    const parent = sourceNode.parentId ? nodes.get(sourceNode.parentId) : null;
    if (parent) parent.children.push(node);
  }

  const toLaneNode = (
    node: ServeBranchGraphNode,
  ): LaneTreeNode<ServeBranchGraphNode> => ({
    value: node,
    children: node.children.map(toLaneNode),
    indentChildren: node.indentChildren,
  });
  for (const sourceNode of sourceNodes) {
    if (sourceNode.parentId && nodes.has(sourceNode.parentId)) continue;
    const node = nodes.get(sourceNode.id);
    if (node) roots.push(toLaneNode(node));
  }

  const { rows: laneRows, maxLane } = layoutLanes(roots, {
    orientation: "parent-first",
  });

  const rowIndexById = new Map<string, number>();
  laneRows.forEach((row, index) => rowIndexById.set(row.value.id, index));

  // For each parent/child edge, draw a vertical segment in the child's lane from
  // the parent row's midline (a `down` half) to the child row's midline (an `up`
  // half), filling intermediate rows. Tracking the two halves independently
  // keeps separate segments that share a lane boundary from fusing into one
  // line (e.g. one fork's child ending right where the next fork's child
  // begins). An edge is dashed when the child has diverged from its parent.
  const railMaps: Array<Map<number, ServeBranchGraphRail>> = laneRows.map(() =>
    new Map<number, ServeBranchGraphRail>()
  );
  const railAt = (rowIndex: number, lane: number): ServeBranchGraphRail => {
    const existing = railMaps[rowIndex].get(lane);
    if (existing) return existing;
    const rail: ServeBranchGraphRail = {
      lane,
      up: false,
      down: false,
      upDashed: false,
      downDashed: false,
    };
    railMaps[rowIndex].set(lane, rail);
    return rail;
  };

  laneRows.forEach((row, index) => {
    const parentId = row.value.parentId;
    const parentIndex = parentId != null ? rowIndexById.get(parentId) : null;
    if (parentIndex == null) return;
    const lane = row.lane;
    const dashed = row.value.branchStatus?.syncStatus === "diverged";

    const parentRail = railAt(parentIndex, lane);
    parentRail.down = true;
    parentRail.downDashed = parentRail.downDashed || dashed;

    const childRail = railAt(index, lane);
    childRail.up = true;
    childRail.upDashed = childRail.upDashed || dashed;

    for (let r = parentIndex + 1; r < index; r++) {
      const rail = railAt(r, lane);
      rail.up = true;
      rail.down = true;
      rail.upDashed = rail.upDashed || dashed;
      rail.downDashed = rail.downDashed || dashed;
    }
  });

  const rows = laneRows.map((row, index): ServeBranchGraphRow => {
    const node = row.value;
    const rails = [...railMaps[index].values()].sort((a, b) => a.lane - b.lane);
    return {
      id: node.id,
      label: node.label,
      branch: node.sourceBranch ?? node.label,
      parent: node.parentLabel,
      nodeKind: node.nodeKind,
      repositoryName: node.repositoryName,
      sourceBranch: node.sourceBranch,
      branchStatus: node.branchStatus,
      lane: row.lane,
      isFork: row.isFork,
      // A branching child's incoming connector reuses the down-half dashed flag
      // recorded for that lane at this row (the same edge).
      forkTargets: row.forkLanes.map((lane) => ({
        lane,
        dashed: railMaps[index].get(lane)?.downDashed ?? false,
      })),
      rails,
    };
  });

  return { rows, maxLane };
}

/**
 * Build browser lane metadata for drawing a stack's branch relationships.
 *
 * The first child continues its parent's lane. Additional children allocate
 * lanes, matching the branching style used by the Gloamy flow sidebar.
 */
export function buildServeBranchGraph(
  stack: { branches: ServeBranchStatus[] },
): ServeBranchGraph {
  const branches = new Set(stack.branches.map((branch) => branch.branch));
  return buildServeGraph(stack.branches.map((branch) => ({
    id: branch.branch,
    label: branch.branch,
    parentId: branches.has(branch.parent) ? branch.parent : null,
    parentLabel: branch.parent,
    nodeKind: "branch",
    repositoryName: null,
    sourceBranch: branch.branch,
    branchStatus: branch,
    indentChildren: false,
  })));
}

function withDescriptionVariants(branch: BranchStatus): ServeBranchStatus {
  if (!branch.description) return branch;
  return {
    ...branch,
    descriptionHtml: renderHtml(branch.description),
    descriptionSummary: stripInline(firstLine(branch.description)),
  };
}

function stripStatusAnsi(status: AllStacksStatus): ServeAllStacksStatus {
  return {
    ...status,
    display: stripAnsi(status.display),
    stacks: status.stacks.map((stack) => {
      const branches = stack.branches.map(withDescriptionVariants);
      return {
        ...stack,
        branches,
        display: stripAnsi(stack.display),
        graph: buildServeBranchGraph({ branches }),
      };
    }),
  };
}

function buildSharedStackGraph(
  stackName: string,
  repositories: ServeRepositoryStatus[],
): ServeBranchGraph {
  const sourceNodes: ServeBranchGraphSourceNode[] = [];

  for (const repository of repositories) {
    const stack = repository.status?.stacks.find((candidate) =>
      candidate.stackName === stackName
    );
    if (!stack) continue;

    const repositoryId = "repository:" + repository.path;
    const branchIds = new Map(
      stack.branches.map((branch) => [
        branch.branch,
        repositoryId + ":branch:" + branch.branch,
      ]),
    );

    sourceNodes.push({
      id: repositoryId,
      label: repository.name,
      parentId: null,
      parentLabel: stackName,
      nodeKind: "repository",
      repositoryName: repository.name,
      sourceBranch: null,
      branchStatus: null,
      indentChildren: true,
    });

    const baseId = repositoryId + ":base:" + stack.baseBranch;
    sourceNodes.push({
      id: baseId,
      label: stack.baseBranch,
      parentId: repositoryId,
      parentLabel: repository.name,
      nodeKind: "base",
      repositoryName: repository.name,
      sourceBranch: null,
      branchStatus: null,
      indentChildren: false,
    });

    for (const branch of stack.branches) {
      const branchId = branchIds.get(branch.branch);
      if (!branchId) continue;

      const parentBranchId = branchIds.get(branch.parent);
      sourceNodes.push({
        id: branchId,
        label: branch.branch,
        parentId: parentBranchId ?? baseId,
        parentLabel: parentBranchId ? branch.parent : stack.baseBranch,
        nodeKind: "branch",
        repositoryName: repository.name,
        sourceBranch: branch.branch,
        branchStatus: branch,
        indentChildren: false,
      });
    }
  }

  return buildServeGraph(sourceNodes);
}

/**
 * Build combined graphs for stack names present in more than one repository.
 */
export function buildServeSharedStackGroups(
  repositories: ServeRepositoryStatus[],
): ServeSharedStackGroup[] {
  const stackNames = new Map<string, ServeRepositoryStatus[]>();
  for (const repository of repositories) {
    const stacks = repository.status?.stacks ?? [];
    for (const stack of stacks) {
      const existing = stackNames.get(stack.stackName) ?? [];
      existing.push(repository);
      stackNames.set(stack.stackName, existing);
    }
  }

  return [...stackNames.entries()]
    .filter(([, groupedRepositories]) => groupedRepositories.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stackName, groupedRepositories]) => ({
      stackName,
      repositories: groupedRepositories.map((repository) => {
        const stack = repository.status?.stacks.find((candidate) =>
          candidate.stackName === stackName
        );
        return {
          name: repository.name,
          path: repository.path,
          branchCount: stack?.branches.length ?? 0,
        };
      }),
      graph: buildSharedStackGraph(stackName, groupedRepositories),
    }));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Render a concise debug line explaining why live `serve` refreshed a
 * repository.
 */
export function formatServeReloadDebugMessage(
  repo: ServeRepository,
  reason: ServeReloadReason,
): string {
  if (reason.kind === "pr-poll") {
    return `[stacked-prs:debug] refresh ${repo.name} (${repo.path}): PR poll interval elapsed (${
      reason.intervalMs / 1000
    }s)`;
  }

  const changes = reason.changes.map((change) =>
    `${change.category} via ${change.eventKind} at ${change.path}`
  );
  return `[stacked-prs:debug] refresh ${repo.name} (${repo.path}): git watch changed ${
    changes.join("; ")
  }`;
}

/**
 * Resolve the repository folders supplied to `serve`.
 *
 * Relative folders are resolved from `rootDir`. When no folders are provided,
 * the current working directory is used as the only repository.
 */
export function resolveServeRepositories(
  rootDir: string,
  folders: string[],
): ServeRepository[] {
  const requested = folders.length === 0 ? [rootDir] : folders;
  return requested.map((folder) => {
    const path = normalize(isAbsolute(folder) ? folder : join(rootDir, folder));
    return {
      name: basename(path) || path,
      path,
    };
  });
}

/**
 * Parse GitHub owner/repo coordinates from common origin URL formats.
 */
export function parseGitHubRemote(
  remoteUrl: string,
): ServeGitHubRepository | null {
  const scpLike = remoteUrl.match(
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
  );
  if (scpLike) {
    return { owner: scpLike[1], repo: scpLike[2] };
  }

  try {
    const url = new URL(remoteUrl);
    if (url.hostname !== "github.com") return null;
    const [owner, repoWithSuffix] = url.pathname.replace(/^\/+/, "").split(
      "/",
    );
    if (!owner || !repoWithSuffix) return null;
    return {
      owner,
      repo: repoWithSuffix.replace(/\.git$/, ""),
    };
  } catch {
    return null;
  }
}

async function resolveGitHubRepository(
  dir: string,
): Promise<ServeGitHubRepository | null> {
  const result = await runGitCommand(dir, "remote", "get-url", "origin");
  if (result.code !== 0 || !result.stdout) return null;
  return parseGitHubRemote(result.stdout);
}

async function withOptionalPrIndex<T>(
  github: ServeGitHubRepository | null,
  fn: (prIndex: PrIndex | null) => Promise<T>,
): Promise<T> {
  if (!github) return await fn(null);
  const index = await createPrIndex(github.owner, github.repo);
  return await fn(index);
}

/** Maximum number of repositories loaded concurrently by the serve routes. */
const LOAD_CONCURRENCY = 6;

async function loadRepositoryStatus(
  repository: ServeRepository,
): Promise<ServeRepositoryStatus> {
  try {
    const github = await resolveGitHubRepository(repository.path);
    let prMetadata: ServeRepositoryStatus["prMetadata"] = github
      ? "unavailable"
      : "not-github";
    const status = await withOptionalPrIndex(github, async (index) => {
      prMetadata = index ? "loaded" : prMetadata;
      return await getAllStackStatuses(
        repository.path,
        github?.owner,
        github?.repo,
        {
          loadPrs: index !== null,
          ...(index ? { prIndex: index } : {}),
        },
      );
    });
    return {
      ...repository,
      github,
      status: stripStatusAnsi(status),
      prMetadata,
      error: null,
    };
  } catch (err) {
    return {
      ...repository,
      github: null,
      status: null,
      prMetadata: "unavailable",
      error: errorMessage(err),
    };
  }
}

/**
 * Options for the concurrency-capped repository loader.
 */
export interface LoadRepositoryStatusesOptions {
  concurrency: number;
  onStart?: (path: string) => void | Promise<void>;
  onSettled?: (status: ServeRepositoryStatus) => void | Promise<void>;
}

/**
 * Load every repository's stack status through a worker pool capped at
 * `concurrency`. Mirrors the TUI's loadPrsProgressive: workers pull from a
 * shared index, fire onStart before a repo begins and onSettled when it
 * resolves, and results come back in input order. loadRepositoryStatus captures
 * its own errors (returning an `error` field) so the pool never throws.
 */
export async function loadRepositoryStatuses(
  repositories: ServeRepository[],
  opts: LoadRepositoryStatusesOptions,
): Promise<ServeRepositoryStatus[]> {
  const results = new Array<ServeRepositoryStatus>(repositories.length);
  let idx = 0;
  const work = async (): Promise<void> => {
    while (idx < repositories.length) {
      const current = idx++;
      const repository = repositories[current];
      await opts.onStart?.(repository.path);
      const status = await loadRepositoryStatus(repository);
      results[current] = status;
      await opts.onSettled?.(status);
    }
  };
  const workers = Array.from(
    { length: Math.min(opts.concurrency, repositories.length) },
    () => work(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Apply the browser payload filter (only repositories with stacks) and compute
 * shared-stack groups. Shared by the buffered and streaming status routes.
 */
function finalizeServeStatus(
  statuses: ServeRepositoryStatus[],
): ServeStatusPayload {
  const renderedRepositories = statuses.filter((repo) =>
    (repo.status?.stacks.length ?? 0) > 0
  );
  return {
    repositories: renderedRepositories,
    sharedStacks: buildServeSharedStackGroups(renderedRepositories),
  };
}

/**
 * Load stack status for rendered repositories.
 */
export async function buildServeStatus(
  repositories: ServeRepository[],
): Promise<ServeStatusPayload> {
  const statuses = await loadRepositoryStatuses(repositories, {
    concurrency: LOAD_CONCURRENCY,
  });
  return finalizeServeStatus(statuses);
}

/**
 * Render the served HTML document, inlining the styles and browser client.
 *
 * Templating is handled by Hono's `html` tagged template. `serve.css` and
 * `serve.client.js` are read from disk relative to this module: when run from
 * source (e.g. `deno task install`'s linked binary) they are the live files; in
 * a `deno compile` binary they are embedded via `--include` (see the compile
 * tasks, the skill wrapper, and release.yml). Read per request so editing the
 * source files is reflected on the next page load.
 */
async function renderServeDocument(watchEnabled: boolean): Promise<string> {
  const [css, clientScript] = await Promise.all([
    Deno.readTextFile(new URL("./serve.css", import.meta.url)),
    Deno.readTextFile(new URL("./serve.client.js", import.meta.url)),
  ]);
  return String(html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>stacked-prs</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <style>
        ${raw(css)}
        </style>
      </head>
      <body>
        <script>
        window.__STACKED_PRS__ = ${raw(
          JSON.stringify({ watch: watchEnabled }),
        )};
        </script>
        <div id="app" class="page"></div>
        <script type="module">
        ${raw(clientScript)}
        </script>
      </body>
    </html>
  `);
}

/**
 * Build the Hono app for the local browser server.
 */
export function createServeApp(
  rootDir: string,
  repositories: ServeRepository[],
  watch: ServeWatchConfig = WATCH_DISABLED,
): Hono {
  const app = new Hono();
  app.get("/", async (c) => c.html(await renderServeDocument(watch.enabled)));
  app.get(
    "/api/status",
    async (c) =>
      c.json({
        rootDir,
        ...(await buildServeStatus(repositories)),
      }),
  );
  app.get("/api/status/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "init",
        data: JSON.stringify({
          repositories: repositories.map(({ name, path }) => ({ name, path })),
        }),
      });

      const statuses = await loadRepositoryStatuses(repositories, {
        concurrency: LOAD_CONCURRENCY,
        onStart: async (path) => {
          await stream.writeSSE({
            event: "repo-start",
            data: JSON.stringify({ path }),
          });
        },
        onSettled: async (status) => {
          if (status.error) {
            await stream.writeSSE({
              event: "repo-error",
              data: JSON.stringify({
                path: status.path,
                message: status.error,
              }),
            });
            return;
          }
          await stream.writeSSE({
            event: "repo-done",
            data: JSON.stringify({
              path: status.path,
              hasStacks: (status.status?.stacks.length ?? 0) > 0,
            }),
          });
        },
      });

      await stream.writeSSE({
        event: "complete",
        data: JSON.stringify({ rootDir, ...finalizeServeStatus(statuses) }),
      });
    }));

  if (watch.enabled) {
    app.get("/api/watch", (c) =>
      streamSSE(c, async (stream) => {
        const closers: Array<() => Promise<void>> = [];
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        const cleanup = async () => {
          if (pollTimer !== undefined) clearInterval(pollTimer);
          pollTimer = undefined;
          await Promise.all(closers.splice(0).map((close) => close()));
        };

        const reload = async (
          repo: ServeRepository,
          reason: ServeReloadReason,
        ) => {
          watch.debugLog?.(repo, reason);
          const status = await loadRepositoryStatus(repo);
          await stream.writeSSE({
            event: "repo-updated",
            data: JSON.stringify(status),
          });
        };
        const scheduler = createReloadScheduler(reload);

        try {
          for (const repo of repositories) {
            closers.push(
              await watchRepoFs(
                repo,
                (reason) => scheduler.trigger(repo, reason),
                watch.debounceMs,
              ),
            );
          }

          if (watch.pollIntervalMs > 0) {
            const githubRepos: ServeRepository[] = [];
            for (const repo of repositories) {
              if (await resolveGitHubRepository(repo.path)) {
                githubRepos.push(repo);
              }
            }
            if (githubRepos.length > 0) {
              pollTimer = setInterval(() => {
                for (const repo of githubRepos) {
                  scheduler.trigger(repo, {
                    kind: "pr-poll",
                    intervalMs: watch.pollIntervalMs,
                  });
                }
              }, watch.pollIntervalMs);
            }
          }

          // Signal the channel is live, then hold it open until the client
          // disconnects. EventSource on the client reconnects automatically.
          await stream.writeSSE({ event: "ready", data: "{}" });
          await new Promise<void>((resolve) => {
            if (stream.aborted || stream.closed) resolve();
            else stream.onAbort(resolve);
          });
        } finally {
          await cleanup();
        }
      }));
  }
  return app;
}

/**
 * Start the local HTTP server used by `stacked-prs serve`.
 */
export async function startServeServer(
  options: ServeServerOptions,
): Promise<ServeServer> {
  const abort = new AbortController();
  let resolveListen:
    | ((addr: Deno.NetAddr | Deno.UnixAddr) => void)
    | undefined;
  const listening = new Promise<Deno.NetAddr | Deno.UnixAddr>((resolve) => {
    resolveListen = resolve;
  });

  const app = createServeApp(
    options.rootDir,
    options.repositories,
    options.watch,
  );
  const server = Deno.serve({
    hostname: options.host,
    port: options.port,
    signal: abort.signal,
    onListen: (addr) => resolveListen?.(addr),
  }, app.fetch);

  const addr = await listening;
  if (addr.transport !== "tcp") {
    throw new Error("serve only supports TCP listeners");
  }
  const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
  const url = `http://${host}:${addr.port}/`;

  return {
    url,
    finished: server.finished.catch((err) => {
      if (err instanceof Deno.errors.Interrupted) return;
      throw err;
    }),
    shutdown: async () => {
      abort.abort();
      await server.finished.catch(() => {});
    },
  };
}

/**
 * Open a URL in the platform default browser.
 */
export async function openBrowser(url: string): Promise<void> {
  const os = Deno.build.os;
  const command = os === "darwin"
    ? { cmd: "open", args: [url] }
    : os === "windows"
    ? { cmd: "cmd", args: ["/c", "start", "", url] }
    : { cmd: "xdg-open", args: [url] };

  const output = await new Deno.Command(command.cmd, {
    args: command.args,
    stdout: "null",
    stderr: "piped",
  }).output();

  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr).trim());
  }
}

/**
 * Return the static browser document used by `serve`.
 */
export function getServeHtmlForTest(watchEnabled = false): Promise<string> {
  return renderServeDocument(watchEnabled);
}
