#!/usr/bin/env -S deno run --allow-run=git,gh --allow-env
import { Command } from "@cliffy/command";
import pluginMeta from "../.claude-plugin/plugin.json" with { type: "json" };
import { getStackTree, renderTree, runGitCommand } from "./lib/stack.ts";
import { gh, listPrsForBranch, resolveRepo } from "./lib/gh.ts";
import { prStateFrom } from "./commands/land.ts";
import { getStackStatus } from "./commands/status.ts";
import { restack } from "./commands/restack.ts";
import { buildNavPlan, executeNavAction } from "./lib/nav.ts";
import { verifyRefs } from "./commands/verify-refs.ts";
import { discoverChain } from "./commands/import-discover.ts";
import { applyClean, detectStaleConfig } from "./commands/clean.ts";
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
import { type MergeStrategy } from "./lib/stack.ts";
import {
  executeLandFromCli,
  type LandCliResult,
  planLand,
} from "./commands/land.ts";
import { getAllNodes } from "./lib/stack.ts";
import { assignColors, detectTheme, readColorOverrides } from "./lib/colors.ts";
import { ansiColor } from "./lib/ansi.ts";

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
function confirmOrExit(opts: {
  force: boolean;
  prompt?: string;
  /** Printed before the prompt; omit when the plan was already rendered. */
  render?: () => void;
  /** Non-TTY error message. */
  nonInteractiveHint?: string;
}): boolean {
  if (opts.force) return true;
  if (!Deno.stdin.isTerminal()) {
    console.error(
      opts.nonInteractiveHint ??
        "Cannot prompt in non-interactive mode. Pass --force to execute, or --dry-run to inspect.",
    );
    Deno.exit(1);
  }
  opts.render?.();
  const answer = prompt(opts.prompt ?? "Proceed? [y/N]");
  if (answer?.trim().toLowerCase() !== "y") {
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

const dir = Deno.cwd();

await new Command()
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
  .option("-i, --interactive", "Launch the interactive TUI")
  .option(
    "--theme <theme:string>",
    "Force light or dark theme (auto-detected)",
  )
  .action(async (options) => {
    if (options.interactive) {
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

      try {
        const { waitUntilExit } = render(
          React.createElement(App, { dir, theme }),
          { stdout: process.stdout, stdin: process.stdin, exitOnCtrlC: true },
        );
        await waitUntilExit();
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
      return;
    }

    const stackName = await resolveStackName(dir, options.stackName);
    let owner = options.owner;
    let repo = options.repo;
    if (!owner || !repo) {
      try {
        const resolved = await resolveRepo(owner, repo);
        owner = resolved.owner;
        repo = resolved.repo;
      } catch {
        // PR info will be unavailable, that's ok for status
      }
    }
    const status = await getStackStatus(dir, stackName, owner, repo);
    if (options.json) {
      logJson(status);
    } else {
      console.log(status.display);
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
      const answer = prompt("Proceed? [y/N]");
      if (answer?.trim().toLowerCase() !== "y") {
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
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    const result = await restack(dir, stackName, {
      upstackFrom: options.upstackFrom,
      downstackFrom: options.downstackFrom,
      only: options.only,
      resume: options.resume,
      dryRun: options.dryRun,
    });

    if (options.json) {
      logJson(result);
    } else {
      const tree = await getStackTree(dir, stackName);
      const statusIcons = new Map<string, string>();
      for (const r of result.rebases) {
        const icon = r.status === "rebased"
          ? "✓"
          : r.status === "skipped-clean"
          ? "·"
          : r.status === "planned"
          ? "→"
          : r.status === "conflict"
          ? "✗"
          : "⊘";
        statusIcons.set(r.branch, icon);
      }
      console.log(`Stack: ${stackName} (base: ${tree.baseBranch})`);
      console.log(renderTree(tree, { statusIcons }));

      if (!result.ok && result.error === "conflict") {
        const conflictBranch = result.rebases.find((r) =>
          r.status === "conflict"
        )?.branch ?? "unknown";
        console.error(`\nConflict during rebase of ${conflictBranch}`);
        console.error("\nTo resolve:");
        console.error(`  ${result.recovery?.resolve}`);
        console.error(`  Then: ${result.recovery?.resume}`);
        console.error(`  Or abort: ${result.recovery?.abort}`);
      }
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
  })
  // --- verify-refs ---
  .command("verify-refs", "Verify branch ancestry and detect duplicate patches")
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
    const result = await discoverChain(dir, options.branch, owner, repo);
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
      !confirmOrExit({
        force: options.force ?? false,
        prompt: `Apply ${report.findings.length} cleanup(s)? [y/N]`,
        nonInteractiveHint:
          "Cannot prompt in non-interactive mode. Pass --force to apply, or --json to inspect.",
      })
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

    const result: LandCliResult = await executeLandFromCli(
      dir,
      stackName,
      prStateByBranch,
      prInfoByBranch,
      { resume: options.resume },
    );

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
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    const { owner, repo } = await resolveRepo(options.owner, options.repo);
    const plan = await computeSubmitPlan(dir, stackName, owner, repo);

    if (options.dryRun) {
      if (options.json) {
        logJson(plan);
      } else {
        console.log(renderSubmitPlan(plan));
      }
      return;
    }

    if (plan.isNoOp) {
      if (options.json) {
        logJson({ ok: true, isNoOp: true });
      } else {
        console.log("All PRs are up to date. Nothing to do.");
      }
      return;
    }

    if (
      !confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(renderSubmitPlan(plan)),
      })
    ) {
      return;
    }

    const result = await executeSubmit(dir, plan, owner, repo);

    if (options.json) {
      logJson(result);
    } else if (result.ok) {
      console.log(
        `Submitted ${stackName}. ` +
          `Pushed ${result.pushedBranches.length}, ` +
          `created ${result.prsCreated.length} PR(s), ` +
          `retargeted ${result.prsBaseUpdated.length}, ` +
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
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const plan = await computeSyncPlan(dir);

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
      // Still fetch, so the user's origin refs are up to date even on a no-op.
      for (const base of plan.baseBranches) {
        await runGitCommand(dir, "fetch", "origin", base);
      }
      return;
    }

    if (
      !confirmOrExit({
        force: options.force ?? false,
        render: () => console.log(renderSyncPlan(plan)),
      })
    ) {
      return;
    }

    const result = await executeSync(dir, plan);

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
  .parse(Deno.args);
