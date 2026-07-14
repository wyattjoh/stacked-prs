#!/usr/bin/env -S deno run --allow-run=git,gh,open,xdg-open,cmd --allow-env --allow-read --allow-net
import { Command } from "@cliffy/command";
import { Confirm } from "@cliffy/prompt";
import pluginMeta from "../.claude-plugin/plugin.json" with { type: "json" };
import {
  detectDefaultBranch,
  getStackTree,
  renderTree,
  runGitCommand,
} from "./lib/stack.ts";
import { gh, listPrsForBranch, resolveRepo, withPrIndex } from "./lib/gh.ts";
import { withRefLoader } from "./lib/loaders.ts";
import { prStateFrom } from "./commands/land.ts";
import {
  type AllStacksStatus,
  getAllStackStatuses,
  getStackStatus,
  type StackStatus,
} from "./commands/status.ts";
import {
  checkoutBranch,
  checkoutInputSequenceLength,
  type CheckoutKey,
  filterCheckoutBranches,
  initialCheckoutSelectionIndex,
  moveCheckoutSelectionForKey,
  parseCheckoutKeypress,
  renderCheckoutFrame,
  renderCheckoutFrameUpdate,
  visibleCheckoutBranches,
} from "./commands/checkout.ts";
import { restack } from "./commands/restack.ts";
import { buildNavPlan, executeNavAction } from "./lib/nav.ts";
import { verifyRefs } from "./commands/verify-refs.ts";
import { discoverChain } from "./commands/import-discover.ts";
import { applyClean, detectStaleConfig } from "./commands/clean.ts";
import { archiveStack } from "./commands/archive.ts";
import { findPrForBranch } from "./commands/pr.ts";
import { computeSubmitPlan } from "./lib/submit-plan.ts";
import { executeSubmit, renderSubmitPlan } from "./commands/submit.ts";
import {
  computeSyncPlan,
  executeSync,
  renderSyncPlan,
} from "./commands/sync.ts";
import {
  create as createBranch,
  type CreatePlan,
  planCreate,
} from "./commands/create.ts";
import type { MergeStrategy } from "./lib/stack.ts";
import {
  executeLandFromCli,
  type LandCliResult,
  planLand,
} from "./commands/land.ts";
import { fold, type FoldPlan, type FoldStrategy } from "./commands/fold.ts";
import { move, type MovePlan } from "./commands/move.ts";
import { insert, type InsertPlan } from "./commands/insert.ts";
import { split, type SplitPlan } from "./commands/split.ts";
import { init as initStack, type InitPlan } from "./commands/init.ts";
import { type ImportPlan, importStack } from "./commands/import.ts";
import { getAllNodes } from "./lib/stack.ts";
import { assignColors, detectTheme, readColorOverrides } from "./lib/colors.ts";
import { ansiColor } from "./lib/ansi.ts";
import {
  formatServeReloadDebugMessage,
  openBrowser,
  resolveServeRepositories,
  startServeServer,
} from "./commands/serve.ts";

/** Pretty-print a value as JSON with 2-space indent on stdout. */
function logJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Interactive confirmation gate shared by submit/sync/create/clean/land.
 * Prints `renderPlan()` output, then asks `[y/N]`. Exits if stdin isn't a
 * TTY (so `--force` is required in non-interactive mode). Returns true
 * when the user confirmed and the caller should proceed.
 */
async function confirmOrExit(opts: {
  force: boolean;
  prompt?: string;
  /** Printed before the prompt; omit when the plan was already rendered. */
  render?: () => void;
  /** Non-TTY error message. */
  nonInteractiveHint?: string;
}): Promise<boolean> {
  if (opts.force) return true;
  if (!Deno.stdin.isTerminal()) {
    console.error(
      opts.nonInteractiveHint ??
        "Cannot prompt in non-interactive mode. Pass --force to execute, or --dry-run to inspect.",
    );
    Deno.exit(1);
  }
  opts.render?.();
  const confirmed = await Confirm.prompt({
    message: opts.prompt ?? "Proceed?",
    default: false,
  });
  if (!confirmed) {
    console.log("Aborted.");
    return false;
  }
  return true;
}

/** Resolve stack name from current branch's git config, with --stack-name override. */
async function resolveStackName(
  dir: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;

  const { code, stdout } = await runGitCommand(dir, "branch", "--show-current");
  if (code !== 0 || !stdout) {
    console.error(
      "Could not detect stack name. Use --stack-name or switch to a stack branch.",
    );
    Deno.exit(1);
  }

  const { code: configCode, stdout: stackName } = await runGitCommand(
    dir,
    "config",
    `branch.${stdout}.stack-name`,
  );
  if (configCode !== 0 || !stackName) {
    console.error(
      "Could not detect stack name. Use --stack-name or switch to a stack branch.",
    );
    Deno.exit(1);
  }

  return stackName;
}

async function shouldStatusAll(
  dir: string,
  explicitAll: boolean,
  explicitStackName?: string,
): Promise<boolean> {
  if (explicitAll) return true;
  if (explicitStackName) return false;

  const { code, stdout: currentBranch } = await runGitCommand(
    dir,
    "branch",
    "--show-current",
  );
  if (code !== 0 || !currentBranch) return false;

  try {
    return currentBranch === await detectDefaultBranch(dir);
  } catch {
    return false;
  }
}

interface CliStatusOptions {
  loadPrs: boolean;
  explicitAll: boolean;
  stackName: string | undefined;
  owner: string | undefined;
  repo: string | undefined;
  showArchived: boolean;
  fetch: boolean;
  fullDescriptions: boolean;
}

async function loadStatusForCli(
  options: CliStatusOptions,
): Promise<StackStatus | AllStacksStatus> {
  let owner = options.owner;
  let repo = options.repo;
  if (options.loadPrs && (!owner || !repo)) {
    try {
      const resolved = await resolveRepo(owner, repo);
      owner = resolved.owner;
      repo = resolved.repo;
    } catch {
      // PR info will be unavailable, that's ok for status
    }
  }

  const statusAll = await shouldStatusAll(
    dir,
    options.explicitAll,
    options.stackName,
  );
  const runStatus = async () => {
    if (statusAll) {
      return await getAllStackStatuses(dir, owner, repo, {
        loadPrs: options.loadPrs,
        showArchived: options.showArchived,
        fetch: options.fetch,
        fullDescriptions: options.fullDescriptions,
      });
    }
    const stackName = await resolveStackName(dir, options.stackName);
    return await getStackStatus(dir, stackName, owner, repo, {
      loadPrs: options.loadPrs,
      fetch: options.fetch,
      fullDescriptions: options.fullDescriptions,
    });
  };
  return options.loadPrs && owner && repo
    ? await withRefLoader(
      dir,
      () => withPrIndex(owner as string, repo as string, runStatus),
    )
    : await withRefLoader(dir, runStatus);
}

async function writeStdout(text: string): Promise<void> {
  await Deno.stdout.write(new TextEncoder().encode(text));
}

function checkoutViewportSize(): { rows: number; columns: number } {
  try {
    return Deno.consoleSize();
  } catch {
    return { rows: 24, columns: 80 };
  }
}

const CHECKOUT_ESCAPE_DELAY_MS = 30;

function appendCheckoutInput(
  existing: Uint8Array,
  incoming: Uint8Array,
): Uint8Array {
  const combined = new Uint8Array(existing.length + incoming.length);
  combined.set(existing);
  combined.set(incoming, existing.length);
  return combined;
}

function createCheckoutKeypressReader(): () => Promise<CheckoutKey> {
  let buffered: Uint8Array = new Uint8Array();
  let pendingRead: Promise<Uint8Array | null> | null = null;

  const startRead = (): Promise<Uint8Array | null> => {
    if (pendingRead !== null) return pendingRead;
    pendingRead = (async () => {
      const buffer = new Uint8Array(64);
      const read = await Deno.stdin.read(buffer);
      return read === null ? null : buffer.slice(0, read);
    })();
    return pendingRead;
  };

  const waitForInput = async (
    escapePending: boolean,
  ): Promise<Uint8Array | null | "timeout"> => {
    const read = startRead();
    if (!escapePending) {
      const chunk = await read;
      if (pendingRead === read) pendingRead = null;
      return chunk;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      read.then((chunk) => ({ type: "read" as const, chunk })),
      new Promise<{ type: "timeout" }>((resolve) => {
        timeout = setTimeout(
          () => resolve({ type: "timeout" }),
          CHECKOUT_ESCAPE_DELAY_MS,
        );
      }),
    ]);
    if (result.type === "timeout") return "timeout";
    clearTimeout(timeout);
    if (pendingRead === read) pendingRead = null;
    return result.chunk;
  };

  return async () => {
    while (true) {
      const sequenceLength = checkoutInputSequenceLength(buffered);
      if (sequenceLength !== null) {
        const sequence = buffered.slice(0, sequenceLength);
        buffered = buffered.slice(sequenceLength);
        return parseCheckoutKeypress(sequence);
      }

      const chunk = await waitForInput(buffered[0] === 0x1b);
      if (chunk === "timeout" || chunk === null) {
        if (buffered.length === 0) return "abort";
        const sequence = buffered;
        buffered = new Uint8Array();
        return parseCheckoutKeypress(sequence);
      }
      buffered = appendCheckoutInput(buffered, chunk);
    }
  };
}

function removeLastSearchCharacter(query: string): string {
  return Array.from(query).slice(0, -1).join("");
}

async function promptForCheckoutBranch(
  status: StackStatus | AllStacksStatus,
  branches: string[],
  currentBranch: string | undefined,
): Promise<string | null> {
  if (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal()) {
    console.error("checkout requires an interactive terminal.");
    Deno.exit(1);
  }

  let searchQuery = "";
  let filteredBranches = filterCheckoutBranches(
    branches,
    searchQuery,
  );
  let selectedIndex = initialCheckoutSelectionIndex(
    filteredBranches,
    currentBranch,
  );
  const HIDE_CURSOR = "\x1b[?25l";
  const SHOW_CURSOR = "\x1b[?25h";
  let frameLineCount = 0;
  const readKeypress = createCheckoutKeypressReader();

  const updateFilter = (preferredBranch: string | undefined) => {
    filteredBranches = filterCheckoutBranches(
      branches,
      searchQuery,
    );
    const preferredIndex = preferredBranch === undefined
      ? -1
      : filteredBranches.indexOf(preferredBranch);
    selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
  };

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // ignore
    }
    try {
      Deno.stdout.writeSync(new TextEncoder().encode(SHOW_CURSOR));
    } catch {
      // ignore
    }
  };
  const onSignal = () => {
    restore();
    Deno.exit(130);
  };

  const render = async () => {
    const selectedBranch = filteredBranches[selectedIndex];
    const viewport = checkoutViewportSize();
    const renderOptions = {
      viewportRows: viewport.rows,
      viewportColumns: viewport.columns,
    };
    const frame = frameLineCount === 0
      ? renderCheckoutFrame(
        status.display,
        filteredBranches,
        selectedBranch,
        {
          ...renderOptions,
          query: searchQuery,
          matchCount: filteredBranches.length,
          totalCount: branches.length,
        },
      )
      : renderCheckoutFrameUpdate(
        frameLineCount,
        status.display,
        filteredBranches,
        selectedBranch,
        {
          ...renderOptions,
          query: searchQuery,
          matchCount: filteredBranches.length,
          totalCount: branches.length,
        },
      );
    frameLineCount = frame.lineCount;
    await writeStdout(frame.text);
  };

  try {
    Deno.addSignalListener("SIGINT", onSignal);
    Deno.addSignalListener("SIGTERM", onSignal);
    Deno.stdin.setRaw(true);
    await writeStdout(HIDE_CURSOR);
    await render();
    while (true) {
      const key = await readKeypress();
      if (key === "abort") return null;
      if (key === "enter") {
        if (filteredBranches.length === 0) continue;
        return filteredBranches[selectedIndex];
      }
      if (typeof key === "object") {
        const selectedBranch = filteredBranches[selectedIndex];
        searchQuery += key.value;
        updateFilter(selectedBranch);
        await render();
        continue;
      }
      if (key === "backspace") {
        if (searchQuery.length === 0) continue;
        const selectedBranch = filteredBranches[selectedIndex];
        searchQuery = removeLastSearchCharacter(searchQuery);
        updateFilter(selectedBranch);
        await render();
        continue;
      }
      if (key === "clear-search") {
        if (searchQuery.length === 0) continue;
        const selectedBranch = filteredBranches[selectedIndex];
        searchQuery = "";
        updateFilter(selectedBranch);
        await render();
        continue;
      }
      const nextIndex = moveCheckoutSelectionForKey(
        status,
        filteredBranches,
        selectedIndex,
        key,
      );
      if (nextIndex !== selectedIndex) {
        selectedIndex = nextIndex;
        await render();
      }
    }
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", onSignal);
      Deno.removeSignalListener("SIGTERM", onSignal);
    } catch {
      // ignore
    }
    restore();
  }
}

function renderCreatePlan(plan: CreatePlan): string {
  const lines: string[] = [];
  lines.push(`Stack: ${plan.stackName} (base: ${plan.baseBranch})`);
  lines.push(`  → Create ${plan.branch} onto ${plan.parent}`);
  lines.push(`    ↳ case: ${plan.case}`);
  lines.push(`    ↳ merge strategy: ${plan.mergeStrategy}`);
  if (plan.willCommit) lines.push(`    ↳ commit staged changes`);
  if (plan.worktreePath) {
    lines.push(`    ↳ worktree: ${plan.worktreePath}`);
  }
  lines.push("");
  lines.push("  Commands:");
  for (const cmd of plan.commands) {
    lines.push(`    ${cmd}`);
  }
  return lines.join("\n");
}

function renderCommands(commands: string[]): string[] {
  const out: string[] = ["  Commands:"];
  for (const cmd of commands) out.push(`    ${cmd}`);
  return out;
}

function renderInitPlan(plan: InitPlan): string {
  const lines = [
    `Stack: ${plan.stackName} (base: ${plan.baseBranch})`,
    `  → Init from ${plan.branch}  onto ${plan.baseBranch}`,
    `    ↳ merge strategy: ${plan.mergeStrategy}`,
    "",
    ...renderCommands(plan.commands),
  ];
  return lines.join("\n");
}

function renderImportPlan(plan: ImportPlan): string {
  const lines = [
    `Stack: ${plan.stackName} (base: ${plan.baseBranch})`,
    `  → Import ${plan.entries.length} branch(es)`,
    `    ↳ merge strategy: ${plan.mergeStrategy}`,
  ];
  for (const e of plan.entries) {
    lines.push(`    - ${e.branch}  parent ${e.parent}`);
  }
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("  Warnings:");
    for (const w of plan.warnings) lines.push(`    ⚠ ${w}`);
  }
  lines.push("");
  lines.push(...renderCommands(plan.commands));
  return lines.join("\n");
}

function renderInsertPlan(plan: InsertPlan): string {
  const lines = [
    `Stack: ${plan.stackName} (base: ${plan.baseBranch})`,
    `  → Insert ${plan.branch}  between ${plan.parent} and ${plan.child}`,
    "",
    ...renderCommands(plan.commands),
  ];
  return lines.join("\n");
}

function renderFoldPlan(plan: FoldPlan): string {
  const lines = [
    `Stack: ${plan.stackName} (base: ${plan.baseBranch})`,
    `  → Fold ${plan.branch}  into ${plan.parent}  (${plan.strategy})`,
  ];
  if (plan.children.length > 0) {
    lines.push("    Reparent:");
    for (const c of plan.children) {
      lines.push(`      ↳ ${c}  onto ${plan.parent}`);
    }
  }
  lines.push("");
  lines.push(...renderCommands(plan.commands));
  return lines.join("\n");
}

function renderMovePlan(plan: MovePlan): string {
  const lines = [
    `Stack: ${plan.stackName} (base: ${plan.baseBranch})`,
    `  → Move ${plan.branch}  from ${plan.oldParent}  onto ${plan.newParent}`,
  ];
  if (plan.reparentedChildren.length > 0) {
    lines.push("    Reparent:");
    for (const c of plan.reparentedChildren) {
      lines.push(`      ↳ ${c}  onto ${plan.oldParent}`);
    }
  }
  lines.push("");
  lines.push(...renderCommands(plan.commands));
  return lines.join("\n");
}

function renderSplitPlan(plan: SplitPlan): string {
  const lines = [
    `Stack: ${plan.stackName} (base: ${plan.baseBranch})`,
    `  → Split ${plan.branch}  (${plan.mode})  new: ${plan.newBranch}`,
  ];
  if (plan.mode === "by-commit") {
    lines.push(`    Keep on ${plan.branch}:`);
    for (const s of plan.keep) lines.push(`      ↳ ${s.slice(0, 8)}`);
    lines.push(`    Move to ${plan.newBranch}:`);
    for (const s of plan.moved) lines.push(`      ↳ ${s.slice(0, 8)}`);
    if (plan.reparentedChildren.length > 0) {
      lines.push("    Reparent:");
      for (const c of plan.reparentedChildren) {
        lines.push(`      ↳ ${c}  onto ${plan.newBranch}`);
      }
    }
  } else {
    lines.push(`    Extract into ${plan.newBranch}:`);
    for (const f of plan.keep) lines.push(`      ↳ ${f}`);
  }
  lines.push("");
  lines.push(...renderCommands(plan.commands));
  return lines.join("\n");
}

const dir = Deno.cwd();

const command = new Command()
  .name("stacked-prs")
  .version(pluginMeta.version)
  .description("Manage stacked branches and pull requests")
  // --- status ---
  .command("status", "Show current stack state with PR and sync info")
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .option("--owner <owner:string>", "GitHub repo owner")
  .option("--repo <repo:string>", "GitHub repo name")
  .option("--json", "Output as JSON")
  .option("--pr, -p", "Load PR data from GitHub")
  .option("--all, -a", "Show all stacks grouped by base branch")
  .option("--archived", "Include archived stacks (hidden by default)")
  .option(
    "--fetch",
    "Fetch base branches from origin before computing sync status",
  )
  .option(
    "--description",
    "Show full branch descriptions in the ladder output",
  )
  .option("--interactive, -i", "Launch the interactive TUI")
  .option(
    "--theme <theme:string>",
    "Force light or dark theme (auto-detected)",
  )
  .action(async (options) => {
    const loadPrs = options.pr === true;
    const explicitAll = options.all === true;
    if (options.interactive) {
      const statusAll = await shouldStatusAll(
        dir,
        explicitAll,
        options.stackName,
      );
      const initialTab = statusAll
        ? "all"
        : { stack: await resolveStackName(dir, options.stackName) } as const;
      const { render } = await import("ink");
      const React = await import("react");
      const { App } = await import("./tui/app.tsx");
      const process = (await import("node:process")).default;

      // Deno's node:process compat layer doesn't populate isTTY / columns /
      // rows on stdio the way Node does, even when attached to a real
      // terminal. Ink relies on all three:
      //   - isTTY gates cursor-based rendering vs append mode.
      //   - rows gates the "frame taller than viewport => clear + redraw"
      //     fallback (ink.js: `if (outputHeight >= stdout.rows)`). With
      //     rows=undefined the comparison is always false, so any re-render
      //     of a tall frame stacks previous output into scrollback because
      //     log-update's eraseLines() can only reach the visible viewport.
      // We fill these in from Deno.consoleSize() and keep them fresh on
      // SIGWINCH, emitting a 'resize' event so Ink recalculates layout.
      const stdoutAny = process.stdout as unknown as {
        isTTY: boolean;
        columns: number;
        rows: number;
        emit?: (event: string) => void;
      };
      const stdinAny = process.stdin as unknown as { isTTY: boolean };
      if (!stdoutAny.isTTY) stdoutAny.isTTY = true;
      if (!stdinAny.isTTY) stdinAny.isTTY = true;

      const refreshConsoleSize = () => {
        try {
          const { columns, rows } = Deno.consoleSize();
          stdoutAny.columns = columns;
          stdoutAny.rows = rows;
        } catch {
          // stdio isn't a real tty (piped/redirected). Fall back to
          // conservative defaults so Ink's clearTerminal path can still
          // fire when the frame would exceed them.
          stdoutAny.columns ??= 80;
          stdoutAny.rows ??= 24;
        }
      };
      refreshConsoleSize();

      const onResize = () => {
        refreshConsoleSize();
        try {
          stdoutAny.emit?.("resize");
        } catch {
          // ignore
        }
      };
      try {
        Deno.addSignalListener("SIGWINCH", onResize);
      } catch {
        // SIGWINCH isn't supported on this platform; static size is fine.
      }

      const theme = options.theme === "light" || options.theme === "dark"
        ? options.theme
        : undefined;

      // Enter the alternate screen buffer so the TUI takes over the terminal
      // and previous frames don't end up in scrollback. We restore on exit
      // (including Ctrl+C / signals) so the user's shell history is intact.
      const ENTER_ALT_SCREEN = "\x1b[?1049h";
      const LEAVE_ALT_SCREEN = "\x1b[?1049l";
      const HIDE_CURSOR = "\x1b[?25l";
      const SHOW_CURSOR = "\x1b[?25h";

      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        try {
          process.stdout.write(SHOW_CURSOR);
          process.stdout.write(LEAVE_ALT_SCREEN);
        } catch {
          // ignore
        }
      };

      process.stdout.write(ENTER_ALT_SCREEN);
      process.stdout.write(HIDE_CURSOR);

      const onSignal = () => {
        restore();
        Deno.exit(130);
      };
      Deno.addSignalListener("SIGINT", onSignal);
      Deno.addSignalListener("SIGTERM", onSignal);

      // Ink depends on signal-exit@3, which on signal delivery calls
      // process.kill(process.pid, sig) after running cleanup to propagate the
      // original signal. In Deno that self-kill routes through
      // node:process.kill, requires unrestricted --allow-run, and prompts
      // even though our Deno.addSignalListener path above already handles the
      // exit. Swallow the self-directed re-raise; forward everything else.
      type ProcessKill = (pid: number, sig?: string | number) => boolean;
      const origKill = (process.kill as ProcessKill).bind(process);
      const selfKillSignals = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);
      (process as unknown as { kill: ProcessKill }).kill = (
        pid: number,
        sig?: string | number,
      ) => {
        if (
          pid === process.pid &&
          typeof sig === "string" &&
          selfKillSignals.has(sig)
        ) {
          return true;
        }
        return origKill(pid, sig);
      };

      let tuiExitCode = 0;
      try {
        let instance: ReturnType<typeof render> | null = null;
        instance = render(
          React.createElement(App, {
            dir,
            initialTab,
            loadPrs,
            fetch: options.fetch === true,
            theme,
            showArchived: options.archived === true,
            onRequestExit: (code = 0) => {
              tuiExitCode = code;
              instance?.unmount();
            },
          }),
          { stdout: process.stdout, stdin: process.stdin, exitOnCtrlC: true },
        );
        await instance.waitUntilExit();
      } finally {
        try {
          Deno.removeSignalListener("SIGINT", onSignal);
          Deno.removeSignalListener("SIGTERM", onSignal);
        } catch {
          // ignore
        }
        (process as unknown as { kill: ProcessKill }).kill = origKill;
        try {
          Deno.removeSignalListener("SIGWINCH", onResize);
        } catch {
          // ignore
        }
        restore();
      }
      Deno.exit(tuiExitCode);
    }

    // Install a repo-wide PR index so per-branch `listPrsForBranch`
    // calls inside `getStackStatus` / `getAllStackStatuses` all share
    // one `gh pr list` fetch instead of N per-branch round-trips. If
    // the repo can't be resolved (no gh auth, no remote), the call
    // falls back to the per-branch path, which renders the tree
    // without PR info.
    //
    // Also install a DataLoader-backed ref resolver so the per-branch
    // `computeSyncStatus` / `tryResolveRef` calls coalesce into a
    // single `git cat-file --batch-check` subprocess instead of one
    // `git rev-parse` per ref. Status is read-only, so caching refs
    // for the scope of this handler is safe.
    const status = await loadStatusForCli({
      loadPrs,
      explicitAll,
      stackName: options.stackName,
      owner: options.owner,
      repo: options.repo,
      showArchived: options.archived === true,
      fetch: options.fetch === true,
      fullDescriptions: options.description === true,
    });
    for (const warning of status.fetchWarnings ?? []) {
      console.error(`⚠ ${warning}`);
    }
    if (options.json) {
      logJson(status);
    } else {
      console.log(status.display);
    }
  })
  // --- checkout ---
  .command(
    "checkout",
    "Select a stack branch from status output and check it out",
  )
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .option("--owner <owner:string>", "GitHub repo owner")
  .option("--repo <repo:string>", "GitHub repo name")
  .option("--pr, -p", "Load PR data from GitHub")
  .option("--all, -a", "Show all stacks grouped by base branch")
  .option("--archived", "Include archived stacks (hidden by default)")
  .option(
    "--fetch",
    "Fetch base branches from origin before computing sync status",
  )
  .option(
    "--description",
    "Show full branch descriptions in the ladder output",
  )
  .action(async (options) => {
    const status = await loadStatusForCli({
      loadPrs: options.pr === true,
      explicitAll: options.all === true,
      stackName: options.stackName,
      owner: options.owner,
      repo: options.repo,
      showArchived: options.archived === true,
      fetch: options.fetch === true,
      fullDescriptions: options.description === true,
    });
    for (const warning of status.fetchWarnings ?? []) {
      console.error(`⚠ ${warning}`);
    }

    const branches = visibleCheckoutBranches(status, {
      showArchived: options.archived === true,
    });
    if (branches.length === 0) {
      console.log(status.display);
      console.error("No stack branches available to checkout.");
      Deno.exit(1);
    }

    const currentBranchResult = await runGitCommand(
      dir,
      "branch",
      "--show-current",
    );
    const branch = await promptForCheckoutBranch(
      status,
      branches,
      currentBranchResult.code === 0 ? currentBranchResult.stdout : undefined,
    );
    if (!branch) {
      console.log("Aborted.");
      Deno.exit(0);
    }

    const result = await checkoutBranch(dir, branch);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (!result.ok) Deno.exit(result.code || 1);
  })
  // --- serve ---
  .command(
    "serve [folders...:string]",
    "Open a local browser view for provided repository folders",
  )
  .option("--host <host:string>", "Host to bind", { default: "127.0.0.1" })
  .option("--port <port:number>", "Port to bind (0 chooses a free port)", {
    default: 0,
  })
  .option("--no-open", "Do not open the browser automatically")
  .option("--no-watch", "Disable live updates (file watch and PR polling)")
  .option("--debug", "Print live refresh reasons to stderr")
  .option(
    "--poll-interval <seconds:number>",
    "Seconds between PR status polls (0 disables polling)",
    { default: 60 },
  )
  .action(async (options, ...folders: string[]) => {
    const repositories = resolveServeRepositories(dir, folders);
    const pollSeconds = options.pollInterval ?? 60;
    const server = await startServeServer({
      rootDir: dir,
      repositories,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      watch: {
        enabled: options.watch !== false,
        pollIntervalMs: Math.max(0, pollSeconds) * 1000,
        debounceMs: 300,
        debugLog: options.debug
          ? (repo, reason) =>
            console.error(formatServeReloadDebugMessage(repo, reason))
          : undefined,
      },
    });

    console.log(`Serving stacked-prs at ${server.url}`);
    console.log("Press Ctrl+C to stop.");

    if (options.open !== false) {
      try {
        await openBrowser(server.url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Could not open browser automatically: ${message}`);
      }
    }

    const onSignal = async () => {
      await server.shutdown();
      Deno.exit(130);
    };

    try {
      Deno.addSignalListener("SIGINT", onSignal);
      Deno.addSignalListener("SIGTERM", onSignal);
      await server.finished;
    } finally {
      try {
        Deno.removeSignalListener("SIGINT", onSignal);
        Deno.removeSignalListener("SIGTERM", onSignal);
      } catch {
        // ignore
      }
    }
  })
  // --- create ---
  .command("create <branch:string>", "Create a new branch in the stack")
  .option(
    "-m, --message <msg:string>",
    "Commit staged changes onto the new branch",
  )
  .option(
    "--create-worktree <dir:string>",
    "Place the new branch in a worktree at <dir>/<branch> (base branch only)",
  )
  .option("--stack-name <name:string>", "Auto-init only: stack name")
  .option(
    "--merge-strategy <strategy:string>",
    "Auto-init only: merge or squash",
  )
  .option("--force", "Skip the TTY confirmation prompt")
  .option("--dry-run", "Print plan without touching git or config")
  .option("--json", "Output as JSON")
  .action(async (options, branch: string) => {
    const mergeStrategy: MergeStrategy | undefined =
      options.mergeStrategy === "merge" || options.mergeStrategy === "squash"
        ? options.mergeStrategy
        : undefined;
    if (options.mergeStrategy !== undefined && mergeStrategy === undefined) {
      console.error(
        `invalid --merge-strategy: expected "merge" or "squash", got "${options.mergeStrategy}"`,
      );
      Deno.exit(1);
    }

    const baseOpts = {
      branch,
      message: options.message,
      createWorktree: options.createWorktree,
      stackName: options.stackName,
      mergeStrategy,
    };

    if (options.dryRun) {
      const result = await planCreate(dir, baseOpts);
      if (options.json) {
        logJson({
          ok: result.ok,
          dryRun: true,
          plan: result.plan,
          error: result.error,
          message: result.message,
        });
      } else if (result.ok && result.plan) {
        console.log(renderCreatePlan(result.plan));
      } else {
        console.error(`${result.error}: ${result.message ?? ""}`);
      }
      if (!result.ok) Deno.exit(1);
      return;
    }

    const plan = await planCreate(dir, baseOpts);
    if (!plan.ok || !plan.plan) {
      if (options.json) {
        logJson(plan);
      } else {
        console.error(`${plan.error}: ${plan.message ?? ""}`);
      }
      Deno.exit(1);
    }

    // create's contract differs from submit/sync: in non-TTY mode it proceeds
    // silently instead of erroring. Only prompt when interactive + !force.
    if (!options.force && Deno.stdin.isTerminal()) {
      console.log(renderCreatePlan(plan.plan));
      const confirmed = await Confirm.prompt({
        message: "Proceed?",
        default: false,
      });
      if (!confirmed) {
        console.log("Aborted.");
        return;
      }
    }

    const result = await createBranch(dir, baseOpts);
    if (options.json) {
      logJson(result);
    } else if (result.ok && result.plan) {
      console.log(
        `Created ${result.plan.branch} onto ${result.plan.parent} (stack: ${result.plan.stackName}).`,
      );
      if (result.plan.worktreePath) {
        console.log(`  ↳ worktree: ${result.plan.worktreePath}`);
      }
    } else {
      console.error(`${result.error}: ${result.message ?? ""}`);
    }
    if (!result.ok) Deno.exit(1);
  })
  // --- restack ---
  .command("restack", "Rebase the stack tree (no fetch, no push)")
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .option(
    "--upstack-from <branch:string>",
    "Rebase only this branch and its descendants",
  )
  .option(
    "--downstack-from <branch:string>",
    "Rebase only ancestors of this branch",
  )
  .option("--only <branch:string>", "Rebase only this single branch")
  .option("--resume", "Resume after resolving conflicts")
  .option("--dry-run", "Report what would happen without touching git")
  .option("--force", "Execute without the interactive confirmation prompt")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    const baseOpts = {
      upstackFrom: options.upstackFrom,
      downstackFrom: options.downstackFrom,
      only: options.only,
      resume: options.resume,
    };

    const iconFor = (status: string): string =>
      status === "rebased"
        ? "✓"
        : status === "skipped-clean"
        ? "·"
        : status === "planned"
        ? "→"
        : status === "conflict"
        ? "✗"
        : "⊘";

    const renderRebases = async (
      rebases: { branch: string; status: string }[],
    ): Promise<string> => {
      const tree = await getStackTree(dir, stackName);
      const statusIcons = new Map<string, string>();
      for (const r of rebases) statusIcons.set(r.branch, iconFor(r.status));
      return `Stack: ${stackName} (base: ${tree.baseBranch})\n` +
        renderTree(tree, { statusIcons });
    };

    const printConflict = (
      result: Awaited<ReturnType<typeof restack>>,
    ): void => {
      if (result.ok || result.error !== "conflict") return;
      const conflictBranch = result.rebases.find((r) =>
        r.status === "conflict"
      )?.branch ?? "unknown";
      console.error(`\nConflict during rebase of ${conflictBranch}`);
      console.error("\nTo resolve:");
      console.error(`  ${result.recovery?.resolve}`);
      console.error(`  Then: ${result.recovery?.resume}`);
      console.error(`  Or abort: ${result.recovery?.abort}`);
    };

    // Resume bypasses the plan-and-confirm step: the user already approved
    // the original plan, and the resume path inside executeRestack handles
    // state recovery without needing a fresh plan render.
    if (options.resume) {
      const result = await restack(dir, stackName, baseOpts);
      if (options.json) {
        logJson(result);
      } else {
        console.log(await renderRebases(result.rebases));
        printConflict(result);
      }
      if (!result.ok) Deno.exit(1);
      return;
    }

    const plan = await restack(dir, stackName, { ...baseOpts, dryRun: true });

    if (options.dryRun) {
      if (options.json) logJson(plan);
      else console.log(await renderRebases(plan.rebases));
      return;
    }

    if (plan.rebases.every((r) => r.status === "skipped-clean")) {
      if (options.json) {
        logJson({ ok: true, isNoOp: true, rebases: plan.rebases });
      } else {
        console.log("Stack is already fully synced. Nothing to do.");
      }
      return;
    }

    const planText = await renderRebases(plan.rebases);

    if (
      !(await confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(planText),
      }))
    ) {
      return;
    }

    const result = await restack(dir, stackName, baseOpts);

    if (options.json) {
      logJson(result);
    } else {
      console.log(await renderRebases(result.rebases));
      printConflict(result);
    }

    if (!result.ok) Deno.exit(1);
  })
  // --- nav ---
  .command("nav", "Create or update stack navigation comments on PRs")
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .option("--owner <owner:string>", "GitHub repo owner")
  .option("--repo <repo:string>", "GitHub repo name")
  .option("--dry-run", "Preview without writing")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    const { owner, repo } = await resolveRepo(options.owner, options.repo);
    await withPrIndex(owner, repo, async () => {
      const plan = await buildNavPlan(dir, stackName, owner, repo);

      if (options.dryRun) {
        logJson(plan);
        return;
      }

      if (plan.length === 0) {
        console.log("All nav comments are up to date. Nothing to do.");
        return;
      }

      console.log(`Nav comments (${plan.length}):`);
      for (const action of plan) {
        await executeNavAction(owner, repo, action);
        if (action.action === "create") {
          console.log(`  ✓ #${action.prNumber} created`);
        } else {
          console.log(
            `  ✓ #${action.prNumber} updated (comment ${action.commentId})`,
          );
        }
      }
    });
  })
  // --- verify-refs ---
  .command(
    "verify-refs",
    "Verify branch ancestry and detect duplicate patches",
  )
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    const result = await verifyRefs(dir, stackName);
    logJson(result);
    if (!result.valid) Deno.exit(1);
  })
  // --- import-discover ---
  .command("import-discover", "Discover existing branch chains for import")
  .option("--branch <name:string>", "Starting branch (default: current)")
  .option("--owner <owner:string>", "GitHub repo owner")
  .option("--repo <repo:string>", "GitHub repo name")
  .action(async (options) => {
    let owner = options.owner;
    let repo = options.repo;
    if (!owner || !repo) {
      try {
        const resolved = await resolveRepo(owner, repo);
        owner = resolved.owner;
        repo = resolved.repo;
      } catch {
        // Will proceed without PR data
      }
    }
    const result = owner && repo
      ? await withPrIndex(
        owner,
        repo,
        () => discoverChain(dir, options.branch, owner, repo),
      )
      : await discoverChain(dir, options.branch, owner, repo);
    logJson(result);
  })
  // --- clean ---
  .command("clean", "Detect and remove stale stack/branch config entries")
  .option("--stack-name <name:string>", "Limit to a single stack")
  .option(
    "--force",
    "Apply cleanups without prompting (for non-interactive use)",
  )
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const report = await detectStaleConfig(dir, {
      stackName: options.stackName,
    });

    if (options.json && !options.force) {
      // Dry-run JSON: just the report.
      logJson(report);
      return;
    }

    if (report.findings.length === 0) {
      if (options.json) {
        logJson({ ...report, applied: { removed: [], applied: [] } });
      } else {
        console.log(
          `No stale config found (scanned ${report.stacksScanned} stack(s), ${report.branchesScanned} branch entry/entries).`,
        );
      }
      return;
    }

    if (!options.json) {
      // Build a per-stack color map matching the TUI's palette so the CLI's
      // visual identity stays consistent. Reads `stack.<name>.color` overrides
      // from git config and falls back to deterministic FNV-1a assignment.
      const stackNames = Array.from(
        new Set(
          report.findings
            .map((f) => f.stackName)
            .filter((s): s is string => !!s),
        ),
      ).sort();
      const theme = detectTheme(Deno.env.get("COLORFGBG"));
      const overrides = await readColorOverrides(
        stackNames,
        async (...args: string[]) => {
          const r = await runGitCommand(dir, ...args);
          return { code: r.code, stdout: r.stdout };
        },
      );
      const colorMap = assignColors(stackNames, overrides, theme);
      const colorize = (
        stackName: string | undefined,
        text: string,
      ): string => {
        if (!stackName) return text;
        const colorName = colorMap.get(stackName);
        if (!colorName) return text;
        return ansiColor(colorName)(text);
      };

      console.log(
        `Stale config (${report.findings.length} entry/entries):`,
      );
      for (const f of report.findings) {
        const subject = f.branch ?? f.stackName ?? "?";
        // Branch-level findings show "(stack: <name>)" so the colored stack
        // identity is always visible. Stack-level findings already use the
        // stack name as the subject, so the parenthetical would just repeat.
        const stackTag = f.branch && f.stackName
          ? ` (stack: ${colorize(f.stackName, f.stackName)})`
          : "";
        console.log(
          `  ⚠ ${colorize(f.stackName, subject)}${stackTag} — ${f.kind}`,
        );
        console.log(`    ↳ ${f.details}`);
        console.log(`    ↳ keys: ${f.configKeys.join(", ")}`);
      }
    }

    if (
      !(await confirmOrExit({
        force: options.force ?? false,
        prompt: `Apply ${report.findings.length} cleanup(s)? [y/N]`,
        nonInteractiveHint:
          "Cannot prompt in non-interactive mode. Pass --force to apply, or --json to inspect.",
      }))
    ) {
      return;
    }

    const applyResult = await applyClean(dir, report.findings);

    if (options.json) {
      logJson({ ...report, applied: applyResult });
    } else {
      console.log(`Removed ${applyResult.removed.length} config key(s).`);
      for (const key of applyResult.removed) {
        console.log(`  ✓ ${key}`);
      }
    }
  })
  // --- archive ---
  .command(
    "archive [stack:string]",
    "Mark a stack as archived (hidden from status/serve and skipped by sync)",
  )
  .option("--unarchive", "Clear the archived flag instead of setting it")
  .option("--json", "Output as JSON")
  .action(async (options, stack?: string) => {
    let result;
    try {
      result = await archiveStack(dir, {
        stackName: stack,
        unarchive: options.unarchive,
      });
    } catch (err) {
      console.error((err as Error).message);
      Deno.exit(1);
    }
    if (options.json) {
      logJson(result);
      return;
    }
    if (!result.changed) {
      const state = result.archived ? "already archived" : "not archived";
      console.log(`· Stack ${result.stackName} is ${state}.`);
      return;
    }
    const verb = result.archived ? "Archived" : "Unarchived";
    console.log(`✓ ${verb} stack ${result.stackName}.`);
  })
  // --- land ---
  .command("land", "Land a merged PR and clean up the stack")
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .option("--dry-run", "Plan and display what would happen without executing")
  .option("--json", "Output as JSON")
  .option("--resume", "Resume after resolving a rebase conflict")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);

    const tree = await getStackTree(dir, stackName);
    const nodes = getAllNodes(tree);

    const { owner, repo: repoName } = await resolveRepo();

    const prStateByBranch = new Map<
      string,
      "OPEN" | "DRAFT" | "MERGED" | "CLOSED" | "NONE"
    >();
    const prInfoByBranch = new Map<
      string,
      import("./tui/types.ts").PrInfo
    >();

    // Wrap the entire land body in a repo-wide PR index so every gh
    // lookup (per-branch PR queries here, plus the nav recompute and
    // any nested planners inside `executeLandFromCli`) hits one batch
    // fetch instead of N per-branch round-trips.
    const result: LandCliResult = await withPrIndex(
      owner,
      repoName,
      async () => {
        await Promise.all(
          nodes.map(async (node) => {
            const best = await listPrsForBranch(node.branch, {
              owner,
              repo: repoName,
            });
            if (best) {
              prStateByBranch.set(node.branch, prStateFrom(best));
              prInfoByBranch.set(node.branch, best);
            } else {
              prStateByBranch.set(node.branch, "NONE");
            }
          }),
        );

        if (options.dryRun) {
          return { ok: true, dryRun: true } as unknown as LandCliResult;
        }

        return await executeLandFromCli(
          dir,
          stackName,
          prStateByBranch,
          prInfoByBranch,
          { resume: options.resume },
        );
      },
    );

    // Handle dry-run separately: the closure returned a synthetic marker
    // so the dry-run rendering stays outside the index (no fetches).
    if ((result as unknown as { dryRun?: boolean }).dryRun) {
      const plan = await planLand(
        dir,
        stackName,
        prStateByBranch,
        prInfoByBranch,
      );
      if (options.json) {
        logJson(plan);
      } else {
        const lines: string[] = [];
        lines.push(`Stack: ${stackName} (base: ${plan.baseBranch})`);
        lines.push(`  case: ${plan.case}`);
        if (plan.mergedBranches.length > 0) {
          lines.push("");
          lines.push("  Merged:");
          for (const b of plan.mergedBranches) lines.push(`    ${b}`);
        }
        if (plan.rebaseSteps.length > 0) {
          lines.push("");
          lines.push("  Rebase:");
          for (const s of plan.rebaseSteps) {
            lines.push(`    → ${s.branch}  onto ${s.newTarget}`);
          }
        }
        if (plan.branchesToDelete.length > 0) {
          lines.push("");
          lines.push("  Delete:");
          for (const b of plan.branchesToDelete) lines.push(`    - ${b}`);
        }
        if (
          plan.mergedBranches.length === 0 &&
          plan.rebaseSteps.length === 0 &&
          plan.branchesToDelete.length === 0
        ) {
          lines.push("  Nothing to do.");
        }
        console.log(lines.join("\n"));
      }
      return;
    }

    if (options.json) {
      logJson(result);
    } else {
      if (result.ok) {
        console.log(`Landed stack ${stackName}.`);
        if (result.result?.split && result.result.split.length > 0) {
          console.log(
            `  ↳ split into: ${
              result.result.split.map((s) => s.stackName).join(", ")
            }`,
          );
        }
      } else if (result.error === "conflict") {
        const conflictBranch =
          result.conflictedAt && "branch" in result.conflictedAt
            ? result.conflictedAt.branch
            : "unknown";
        console.error(`\nConflict during rebase of ${conflictBranch}`);
        if (result.conflictFiles && result.conflictFiles.length > 0) {
          console.error("\nConflicting files:");
          for (const f of result.conflictFiles) {
            console.error(`  ${f}`);
          }
        }
        console.error("\nTo resolve:");
        console.error(`  ${result.recovery?.resolve}`);
        console.error(`  Then: ${result.recovery?.resume}`);
        console.error(`  Or abort: ${result.recovery?.abort}`);
      } else {
        console.error(`Land failed: ${result.error}`);
      }
    }

    if (!result.ok) Deno.exit(1);
  })
  // --- pr ---
  .command("pr", "Open the pull request for a branch in the browser")
  .option("--branch <name:string>", "Branch (default: current)")
  .option("--owner <owner:string>", "GitHub repo owner")
  .option("--repo <repo:string>", "GitHub repo name")
  .option("--print", "Print the PR URL instead of opening the browser")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const { owner, repo } = await resolveRepo(options.owner, options.repo);
    const result = await findPrForBranch(dir, owner, repo, options.branch);

    if (options.json) {
      logJson(result);
      if (!result.ok) Deno.exit(1);
      return;
    }

    if (!result.ok) {
      console.error(result.error);
      Deno.exit(1);
    }

    if (options.print) {
      console.log(result.pr!.url);
      return;
    }

    // Delegate opening to gh so we don't have to shell out to `open` / `xdg-open`.
    await gh(
      "pr",
      "view",
      String(result.pr!.number),
      "--repo",
      `${owner}/${repo}`,
      "--web",
    );
  })
  // --- submit ---
  .command(
    "submit",
    "Push branches and create/update PRs (runs the full submit plan)",
  )
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .option("--owner <owner:string>", "GitHub repo owner")
  .option("--repo <repo:string>", "GitHub repo name")
  .option("--dry-run", "Print the plan without executing")
  .option("--force", "Execute without the interactive confirmation prompt")
  .option(
    "--only <branch:string>",
    "Restrict per-branch ops (push, create, edit, draft) to a single branch; nav comments still cover the full stack",
  )
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    const { owner, repo } = await resolveRepo(options.owner, options.repo);

    // Every `gh pr list --head` in the planner, the executor, and the
    // final nav recompute piggybacks on a single repo-wide fetch.
    const result = await withPrIndex(owner, repo, async () => {
      let plan;
      try {
        plan = await computeSubmitPlan(dir, stackName, owner, repo, {
          only: options.only,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          logJson({ ok: false, error: message });
        } else {
          console.error(message);
        }
        Deno.exit(1);
      }

      if (options.dryRun) {
        if (options.json) {
          logJson(plan);
        } else {
          console.log(renderSubmitPlan(plan));
        }
        return null;
      }

      if (plan.isNoOp) {
        if (options.json) {
          logJson({ ok: true, isNoOp: true });
        } else {
          console.log("All PRs are up to date. Nothing to do.");
        }
        return null;
      }

      if (
        !(await confirmOrExit({
          force: options.force ?? false,
          render: () => console.log(renderSubmitPlan(plan)),
        }))
      ) {
        return null;
      }

      return await executeSubmit(dir, plan, owner, repo);
    });

    if (result === null) return;

    if (options.json) {
      logJson(result);
    } else if (result.ok) {
      console.log(
        `Submitted ${stackName}. ` +
          `Pushed ${result.pushedBranches.length}, ` +
          `created ${result.prsCreated.length} PR(s), ` +
          `retargeted ${result.prsBaseUpdated.length}, ` +
          `updated ${result.prsBodyUpdated.length} body(ies), ` +
          `flipped ${result.draftTransitions.length} draft(s), ` +
          `${result.navCommentsApplied} nav comment(s).`,
      );
      if (result.prsCreated.length > 0) {
        console.log("  Created PRs:");
        for (const pr of result.prsCreated) {
          console.log(`    ✓ ${pr.branch} → ${pr.url}`);
        }
      }
    } else {
      console.error(`Submit failed: ${result.error}`);
    }

    if (!result.ok) Deno.exit(1);
  })
  // --- sync ---
  .command(
    "sync",
    "Fetch origin, fast-forward local base branches, prune merged PRs, and restack + push every stack.",
  )
  .option("--dry-run", "Print the plan without executing")
  .option("--force", "Execute without the interactive confirmation prompt")
  .option(
    "--filter <globs:string>",
    "Comma-separated stack-name globs; prefix with ! to exclude (e.g. --filter='!di*')",
  )
  .option("--archived", "Include archived stacks in the sync")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    // Resolve owner/repo once so every `listPrsForBranch` call (planner
    // + executor + nav refresh, across every stack) piggybacks on a
    // single repo-wide `gh pr list`. Graceful fallback when gh isn't
    // authenticated: sync still plans and executes via per-branch
    // queries, just slower.
    const resolved = await (async () => {
      try {
        return await resolveRepo();
      } catch {
        return null;
      }
    })();

    const run = async (): Promise<void> => {
      const plan = await computeSyncPlan(dir, {
        filter: options.filter,
        archived: options.archived,
      });

      if (plan.filter && plan.stacks.length === 0) {
        if (options.json) {
          logJson(plan);
        } else {
          console.log(
            `No stacks match --filter=${plan.filter}. Nothing to do.`,
          );
        }
        return;
      }

      if (options.dryRun) {
        if (options.json) {
          logJson(plan);
        } else {
          console.log(renderSyncPlan(plan));
        }
        return;
      }

      if (plan.isNoOp && plan.stacks.length > 0) {
        if (options.json) {
          logJson({ ok: true, isNoOp: true });
        } else {
          console.log(
            "All stacks are already synced with origin. Nothing to do.",
          );
        }
        // Still fetch, so origin refs are up to date even on a no-op.
        for (const base of plan.baseBranches) {
          await runGitCommand(dir, "fetch", "origin", base);
        }
        return;
      }

      if (
        !(await confirmOrExit({
          force: options.force ?? false,
          render: () => console.log(renderSyncPlan(plan)),
        }))
      ) {
        return;
      }

      const result = await executeSync(dir, plan);
      syncResultRef.result = result;
    };

    const syncResultRef: {
      result: Awaited<ReturnType<typeof executeSync>> | null;
    } = {
      result: null,
    };
    if (resolved) {
      await withPrIndex(resolved.owner, resolved.repo, run);
    } else {
      await run();
    }
    const result = syncResultRef.result;
    if (!result) return;

    if (options.json) {
      logJson(result);
    } else if (result.ok) {
      console.log(
        `Fetched ${result.fetched.join(", ")}. Synced ${
          result.stacks.filter((s) => s.ok).length
        } stack(s).`,
      );
      for (const s of result.stacks) {
        if (s.pushed && s.pushed.length > 0) {
          console.log(`  ✓ ${s.stackName}: pushed ${s.pushed.join(", ")}`);
        }
      }
    } else {
      console.error(`Sync failed at stack ${result.failedAt}.`);
      const failed = result.stacks.find((s) => !s.ok);
      if (failed?.error) console.error(`  ✗ ${failed.error}`);
      if (failed?.restack?.error === "conflict" && failed.restack.recovery) {
        console.error("\nTo resolve:");
        console.error(`  ${failed.restack.recovery.resolve}`);
        console.error(`  Then: ${failed.restack.recovery.resume}`);
        console.error(`  Or abort: ${failed.restack.recovery.abort}`);
      }
    }

    if (!result.ok) Deno.exit(1);
  })
  // --- init ---
  .command("init", "Initialize the current branch as a new stack")
  .option("--branch <name:string>", "Branch to register (default: current)")
  .option("--stack-name <name:string>", "Stack name (default: branch name)")
  .option(
    "--merge-strategy <strategy:string>",
    "merge or squash (default: merge)",
  )
  .option("--base-branch <name:string>", "Base branch (default: auto-detect)")
  .option("--force", "Skip the TTY confirmation prompt")
  .option("--dry-run", "Print plan without touching config")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const mergeStrategy: MergeStrategy | undefined =
      options.mergeStrategy === "merge" || options.mergeStrategy === "squash"
        ? options.mergeStrategy
        : undefined;
    if (options.mergeStrategy !== undefined && mergeStrategy === undefined) {
      console.error(
        `invalid --merge-strategy: expected "merge" or "squash"`,
      );
      Deno.exit(1);
    }

    const baseOpts = {
      branch: options.branch,
      stackName: options.stackName,
      mergeStrategy,
      baseBranch: options.baseBranch,
    };

    const planResult = await initStack(dir, { ...baseOpts, dryRun: true });
    if (!planResult.ok || !planResult.plan) {
      if (options.json) {
        logJson(planResult);
      } else {
        console.error(`${planResult.error}: ${planResult.message ?? ""}`);
      }
      Deno.exit(1);
    }

    if (options.dryRun) {
      if (options.json) logJson(planResult);
      else console.log(renderInitPlan(planResult.plan));
      return;
    }

    if (
      !(await confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(renderInitPlan(planResult.plan!)),
      }))
    ) {
      return;
    }

    const result = await initStack(dir, baseOpts);
    if (options.json) logJson(result);
    else if (result.ok && result.plan) {
      console.log(
        `Initialized stack ${result.plan.stackName} on ${result.plan.branch} (base: ${result.plan.baseBranch}).`,
      );
    } else {
      console.error(`${result.error}: ${result.message ?? ""}`);
    }
    if (!result.ok) Deno.exit(1);
  })
  // --- import ---
  .command(
    "import",
    "Discover and register an existing branch chain as a stack",
  )
  .option("--branch <name:string>", "Starting branch (default: current)")
  .option(
    "--stack-name <name:string>",
    "Stack name (default: root branch name)",
  )
  .option(
    "--merge-strategy <strategy:string>",
    "merge or squash (default: merge)",
  )
  .option("--owner <owner:string>", "GitHub repo owner")
  .option("--repo <repo:string>", "GitHub repo name")
  .option("--force", "Skip the TTY confirmation prompt")
  .option("--dry-run", "Print plan without touching config")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const mergeStrategy: MergeStrategy | undefined =
      options.mergeStrategy === "merge" || options.mergeStrategy === "squash"
        ? options.mergeStrategy
        : undefined;
    if (options.mergeStrategy !== undefined && mergeStrategy === undefined) {
      console.error(
        `invalid --merge-strategy: expected "merge" or "squash"`,
      );
      Deno.exit(1);
    }

    const baseOpts = {
      branch: options.branch,
      stackName: options.stackName,
      mergeStrategy,
      owner: options.owner,
      repo: options.repo,
    };

    const planResult = await importStack(dir, { ...baseOpts, dryRun: true });
    if (!planResult.ok || !planResult.plan) {
      if (options.json) logJson(planResult);
      else console.error(`${planResult.error}: ${planResult.message ?? ""}`);
      Deno.exit(1);
    }

    if (options.dryRun) {
      if (options.json) logJson(planResult);
      else console.log(renderImportPlan(planResult.plan));
      return;
    }

    if (
      !(await confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(renderImportPlan(planResult.plan!)),
      }))
    ) {
      return;
    }

    const result = await importStack(dir, baseOpts);
    if (options.json) logJson(result);
    else if (result.ok && result.plan) {
      console.log(
        `Imported ${result.plan.entries.length} branch(es) into stack ${result.plan.stackName}.`,
      );
    } else {
      console.error(`${result.error}: ${result.message ?? ""}`);
    }
    if (!result.ok) Deno.exit(1);
  })
  // --- insert ---
  .command(
    "insert <branch:string>",
    "Insert a new branch between a branch and its parent",
  )
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .option(
    "--child <name:string>",
    "Branch that will be reparented under the new branch (default: current)",
  )
  .option("--force", "Skip the TTY confirmation prompt")
  .option("--dry-run", "Print plan without touching git or config")
  .option("--json", "Output as JSON")
  .action(async (options, newBranch: string) => {
    const stackName = await resolveStackName(dir, options.stackName);
    let child = options.child;
    if (!child) {
      const { code, stdout } = await runGitCommand(
        dir,
        "branch",
        "--show-current",
      );
      if (code !== 0 || !stdout) {
        console.error("Could not detect child branch. Pass --child.");
        Deno.exit(1);
      }
      child = stdout;
    }

    const baseOpts = { stackName, child, branch: newBranch };
    const planResult = await insert(dir, { ...baseOpts, dryRun: true });
    if (!planResult.ok || !planResult.plan) {
      if (options.json) logJson(planResult);
      else console.error(`${planResult.error}: ${planResult.message ?? ""}`);
      Deno.exit(1);
    }

    if (options.dryRun) {
      if (options.json) logJson(planResult);
      else console.log(renderInsertPlan(planResult.plan));
      return;
    }

    if (
      !(await confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(renderInsertPlan(planResult.plan!)),
      }))
    ) {
      return;
    }

    const result = await insert(dir, baseOpts);
    if (options.json) logJson(result);
    else if (result.ok && result.plan) {
      console.log(
        `Inserted ${result.plan.branch} between ${result.plan.parent} and ${result.plan.child}.`,
      );
    } else {
      console.error(`${result.error}: ${result.message ?? ""}`);
    }
    if (!result.ok) Deno.exit(1);
  })
  // --- fold ---
  .command(
    "fold",
    "Merge a branch into its parent and remove it from the stack",
  )
  .option("--stack-name <name:string>", "Stack name (auto-detected)")
  .option(
    "--branch <name:string>",
    "Branch to fold into its parent (default: current)",
  )
  .option(
    "--strategy <strategy:string>",
    "ff (fast-forward) or squash (default: ff)",
  )
  .option("--message <msg:string>", "Commit message for --strategy=squash")
  .option("--force", "Skip the TTY confirmation prompt")
  .option("--dry-run", "Print plan without executing")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    let branch = options.branch;
    if (!branch) {
      const { code, stdout } = await runGitCommand(
        dir,
        "branch",
        "--show-current",
      );
      if (code !== 0 || !stdout) {
        console.error("Could not detect branch. Pass --branch.");
        Deno.exit(1);
      }
      branch = stdout;
    }
    const strategy: FoldStrategy = options.strategy === "squash"
      ? "squash"
      : "ff";
    if (
      options.strategy !== undefined &&
      options.strategy !== "ff" &&
      options.strategy !== "squash"
    ) {
      console.error(`invalid --strategy: expected "ff" or "squash"`);
      Deno.exit(1);
    }

    const baseOpts = {
      stackName,
      branch,
      strategy,
      squashMessage: options.message,
    };
    const planResult = await fold(dir, { ...baseOpts, dryRun: true });
    if (!planResult.ok || !planResult.plan) {
      if (options.json) logJson(planResult);
      else console.error(`${planResult.error}: ${planResult.message ?? ""}`);
      Deno.exit(1);
    }

    if (options.dryRun) {
      if (options.json) logJson(planResult);
      else console.log(renderFoldPlan(planResult.plan));
      return;
    }

    if (
      !(await confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(renderFoldPlan(planResult.plan!)),
      }))
    ) {
      return;
    }

    const result = await fold(dir, baseOpts);
    if (options.json) logJson(result);
    else if (result.ok && result.plan) {
      console.log(
        `Folded ${result.plan.branch} into ${result.plan.parent}.`,
      );
    } else {
      console.error(`${result.error}: ${result.message ?? ""}`);
    }
    if (!result.ok) Deno.exit(1);
  })
  // --- move ---
  .command(
    "move",
    "Detach a branch and reattach it as a child of a different parent",
  )
  .option("--stack-name <name:string>", "Stack name (auto-detected)")
  .option(
    "--branch <name:string>",
    "Branch to move (default: current)",
  )
  .option("--new-parent <name:string>", "New parent branch", {
    required: true,
  })
  .option("--force", "Skip the TTY confirmation prompt")
  .option("--dry-run", "Print plan without executing")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    let branch = options.branch;
    if (!branch) {
      const { code, stdout } = await runGitCommand(
        dir,
        "branch",
        "--show-current",
      );
      if (code !== 0 || !stdout) {
        console.error("Could not detect branch. Pass --branch.");
        Deno.exit(1);
      }
      branch = stdout;
    }

    const baseOpts = {
      stackName,
      branch,
      newParent: options.newParent,
    };
    const planResult = await move(dir, { ...baseOpts, dryRun: true });
    if (!planResult.ok || !planResult.plan) {
      if (options.json) logJson(planResult);
      else console.error(`${planResult.error}: ${planResult.message ?? ""}`);
      Deno.exit(1);
    }

    if (options.dryRun) {
      if (options.json) logJson(planResult);
      else console.log(renderMovePlan(planResult.plan));
      return;
    }

    if (
      !(await confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(renderMovePlan(planResult.plan!)),
      }))
    ) {
      return;
    }

    const result = await move(dir, baseOpts);
    if (options.json) logJson(result);
    else if (result.ok && result.plan) {
      console.log(
        `Moved ${result.plan.branch} from ${result.plan.oldParent} onto ${result.plan.newParent}.`,
      );
    } else if (result.error === "conflict") {
      console.error(
        `\nConflict during rebase of ${result.plan?.branch ?? "move"}`,
      );
      console.error("\nTo resolve:");
      console.error(`  ${result.recovery?.resolve}`);
      console.error(`  Then: ${result.recovery?.resume}`);
      console.error(`  Or abort: ${result.recovery?.abort}`);
    } else {
      console.error(`${result.error}: ${result.message ?? ""}`);
    }
    if (!result.ok) Deno.exit(1);
  })
  // --- split ---
  .command(
    "split",
    "Split a branch into two: --by-commit or --by-file",
  )
  .option("--stack-name <name:string>", "Stack name (auto-detected)")
  .option(
    "--branch <name:string>",
    "Branch to split (default: current)",
  )
  .option("--new-branch <name:string>", "Name for the newly created branch", {
    required: true,
  })
  .option(
    "--by-commit <sha:string>",
    "Split mode: last SHA to keep on original",
  )
  .option(
    "--by-file <files:string>",
    "Split mode: comma-separated files to extract into a new lower branch",
  )
  .option(
    "--extract-message <msg:string>",
    "Commit message for --by-file extract commit",
  )
  .option(
    "--remainder-message <msg:string>",
    "Commit message for --by-file remainder commit",
  )
  .option("--force", "Skip the TTY confirmation prompt")
  .option("--dry-run", "Print plan without executing")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    let branch = options.branch;
    if (!branch) {
      const { code, stdout } = await runGitCommand(
        dir,
        "branch",
        "--show-current",
      );
      if (code !== 0 || !stdout) {
        console.error("Could not detect branch. Pass --branch.");
        Deno.exit(1);
      }
      branch = stdout;
    }

    if (options.byCommit && options.byFile) {
      console.error(
        "Pass exactly one of --by-commit or --by-file, not both.",
      );
      Deno.exit(1);
    }
    if (!options.byCommit && !options.byFile) {
      console.error("Pass exactly one of --by-commit or --by-file.");
      Deno.exit(1);
    }

    const baseOpts = options.byCommit
      ? {
        mode: "by-commit" as const,
        stackName,
        branch,
        at: options.byCommit,
        newBranch: options.newBranch,
      }
      : {
        mode: "by-file" as const,
        stackName,
        branch,
        files: options.byFile!.split(",").map((s) => s.trim()).filter(
          Boolean,
        ),
        newBranch: options.newBranch,
        extractMessage: options.extractMessage ?? "extract",
        remainderMessage: options.remainderMessage ?? "remainder",
      };

    const planResult = await split(dir, { ...baseOpts, dryRun: true });
    if (!planResult.ok || !planResult.plan) {
      if (options.json) logJson(planResult);
      else console.error(`${planResult.error}: ${planResult.message ?? ""}`);
      Deno.exit(1);
    }

    if (options.dryRun) {
      if (options.json) logJson(planResult);
      else console.log(renderSplitPlan(planResult.plan));
      return;
    }

    if (
      !(await confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(renderSplitPlan(planResult.plan!)),
      }))
    ) {
      return;
    }

    const result = await split(dir, baseOpts);
    if (options.json) logJson(result);
    else if (result.ok && result.plan) {
      console.log(
        `Split ${result.plan.branch} (${result.plan.mode}); new branch: ${result.plan.newBranch}.`,
      );
    } else {
      console.error(`${result.error}: ${result.message ?? ""}`);
    }
    if (!result.ok) Deno.exit(1);
  });

/** Run the stacked-prs command-line interface. */
export async function main(args: string[] = Deno.args): Promise<void> {
  await command.parse(args);
}

if (import.meta.main) {
  await main();
}
