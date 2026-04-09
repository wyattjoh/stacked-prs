#!/usr/bin/env -S deno run --allow-run=git,gh --allow-env
import { Command } from "@cliffy/command";
import { getStackTree, renderTree, runGitCommand } from "./lib/stack.ts";
import { gh } from "./lib/gh.ts";
import { getStackStatus } from "./commands/status.ts";
import { restack } from "./commands/restack.ts";
import { buildNavPlan, executeNavAction } from "./commands/nav.ts";
import { verifyRefs } from "./commands/verify-refs.ts";
import { discoverChain } from "./commands/import-discover.ts";
import { computeSubmitPlan } from "./commands/submit-plan.ts";
import { applyClean, detectStaleConfig } from "./commands/clean.ts";
import {
  executeLandFromCli,
  type LandCliResult,
  planLand,
} from "./commands/land.ts";
import { getAllNodes } from "./lib/stack.ts";
import { assignColors, detectTheme, readColorOverrides } from "./lib/colors.ts";
import { ansiColor } from "./lib/ansi.ts";

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

/** Resolve owner/repo from gh CLI, with --owner/--repo override. */
async function resolveRepo(
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

const dir = Deno.cwd();

await new Command()
  .name("stacked-prs")
  .version("1.0.0")
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

      // Ink depends on signal-exit@3, which registers process.on(sig, ...)
      // handlers and, on signal delivery, forwards the signal by calling
      // process.kill(process.pid, sig) after running cleanup. In Deno that
      // process.kill call requires unrestricted --allow-run and prompts on
      // quit even though our Deno.addSignalListener path already handles the
      // exit cleanly. signal-exit skips the forward if it sees another
      // process.on listener on the signal (see `listeners.length ===
      // emitter.count` in signal-exit/index.js), so we register no-op
      // listeners via node-compat's process.on. Our Deno.addSignalListener
      // handlers still do the real cleanup and Deno.exit.
      const noopSignal = () => {};
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        try {
          process.on(sig, noopSignal);
        } catch {
          // platform doesn't support this signal; fine.
        }
      }

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
        for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
          try {
            process.off(sig, noopSignal);
          } catch {
            // ignore
          }
        }
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
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(status.display);
    }
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
      console.log(JSON.stringify(result, null, 2));
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
      console.log(renderTree(tree, { statusIcons }));

      if (!result.ok && result.error === "conflict") {
        console.error("\nConflict detected. To resolve:");
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
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    for (const action of plan) {
      await executeNavAction(owner, repo, action);
      if (action.action === "create") {
        console.log(`Created nav comment on PR #${action.prNumber}`);
      } else {
        console.log(
          `Updated nav comment on PR #${action.prNumber} (comment ${action.commentId})`,
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
    console.log(JSON.stringify(result, null, 2));
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
    console.log(JSON.stringify(result, null, 2));
  })
  // --- submit-plan ---
  .command("submit-plan", "Compute the submit plan for a stack")
  .option(
    "--stack-name <name:string>",
    "Stack name (auto-detected from current branch)",
  )
  .option("--owner <owner:string>", "GitHub repo owner")
  .option("--repo <repo:string>", "GitHub repo name")
  .action(async (options) => {
    const stackName = await resolveStackName(dir, options.stackName);
    const { owner, repo } = await resolveRepo(options.owner, options.repo);
    const plan = await computeSubmitPlan(dir, stackName, owner, repo);
    console.log(JSON.stringify(plan, null, 2));
  })
  // --- clean ---
  .command("clean", "Detect and remove stale stack/branch config entries")
  .option("--stack-name <name:string>", "Limit to a single stack")
  .option(
    "--confirm",
    "Apply cleanups without prompting (for non-interactive use)",
  )
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const report = await detectStaleConfig(dir, {
      stackName: options.stackName,
    });

    if (options.json && !options.confirm) {
      // Dry-run JSON: just the report.
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (report.findings.length === 0) {
      if (options.json) {
        console.log(
          JSON.stringify(
            { ...report, applied: { removed: [], applied: [] } },
            null,
            2,
          ),
        );
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
        dir,
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
        `Found ${report.findings.length} stale config entry/entries:\n`,
      );
      for (const f of report.findings) {
        const subject = f.branch ?? f.stackName ?? "?";
        // Branch-level findings show "(stack: <name>)" so the colored stack
        // identity is always visible. Stack-level findings already use the
        // stack name as the subject, so the parenthetical would just repeat.
        const stackTag = f.branch && f.stackName
          ? `  (stack: ${colorize(f.stackName, f.stackName)})`
          : "";
        console.log(
          `  [${f.kind}] ${colorize(f.stackName, subject)}${stackTag}`,
        );
        console.log(`    ${f.details}`);
        console.log(`    keys: ${f.configKeys.join(", ")}`);
        console.log("");
      }
    }

    if (!options.confirm) {
      if (!Deno.stdin.isTerminal()) {
        console.error(
          "Cannot prompt in non-interactive mode. Pass --confirm to apply, or --json to inspect.",
        );
        Deno.exit(1);
      }
      const answer = prompt(
        `Apply ${report.findings.length} cleanup(s)? [y/N]`,
      );
      if (answer?.trim().toLowerCase() !== "y") {
        console.log("Aborted. No changes made.");
        return;
      }
    }

    const applyResult = await applyClean(dir, report.findings);

    if (options.json) {
      console.log(
        JSON.stringify({ ...report, applied: applyResult }, null, 2),
      );
    } else {
      console.log(`Removed ${applyResult.removed.length} config key(s):`);
      for (const key of applyResult.removed) {
        console.log(`  ${key}`);
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

    const repoInfo = await gh("repo", "view", "--json", "owner,name");
    const { owner, name: repoName } = JSON.parse(repoInfo) as {
      owner: { login: string };
      name: string;
    };

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
        const result = await gh(
          "pr",
          "list",
          "--head",
          node.branch,
          "--repo",
          `${owner}/${repoName}`,
          "--state",
          "all",
          "--json",
          "number,url,state,isDraft,createdAt",
        );
        const prs = JSON.parse(result) as import("./tui/types.ts").PrInfo[];
        const best = prs.length > 0 ? prs[0] : null;
        if (best) {
          const state = best.state.toUpperCase() as
            | "OPEN"
            | "DRAFT"
            | "MERGED"
            | "CLOSED";
          prStateByBranch.set(node.branch, state);
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
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log("Land plan for stack:", stackName);
        console.log("Case:", plan.case);
        console.log(
          "Merged branches:",
          plan.mergedBranches.join(", ") || "none",
        );
        console.log(
          "Branches to rebase:",
          plan.rebaseSteps.map((s) => s.branch).join(", ") || "none",
        );
        console.log(
          "Branches to delete:",
          plan.branchesToDelete.join(", ") || "none",
        );
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
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.ok) {
        console.log(`Stack "${stackName}" landed successfully.`);
        if (result.result?.split && result.result.split.length > 0) {
          console.log(
            "Split into stacks:",
            result.result.split.map((s) => s.stackName).join(", "),
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
        console.error("Land failed:", result.error);
      }
    }

    if (!result.ok) Deno.exit(1);
  })
  .parse(Deno.args);
