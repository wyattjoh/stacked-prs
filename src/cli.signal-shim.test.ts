import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";

// Regression test for the TUI signal-exit interaction. Ink depends on
// signal-exit@3, which on SIGINT delivery calls process.kill(process.pid, sig)
// to re-raise the signal. Under Deno's restricted run permissions (the
// production CLI ships with --allow-run=git,gh,pbcopy and friends, NOT
// unrestricted run), that self-kill throws "NotCapable: Requires run access"
// and prints a permission prompt. cli.ts works around this by patching
// process.kill to swallow self-directed SIGINT/SIGTERM/SIGHUP re-raises.
//
// This test reproduces the exact failure mode in a subprocess so the contract
// is locked in even if signal-exit, ink, or Deno node-compat changes the
// underlying object identity / call site.

const CHILD_SCRIPT = `
import process from "node:process";
import signalExit from "npm:signal-exit@3.0.7";

const installShim = Deno.env.get("INSTALL_SHIM") === "1";
if (installShim) {
  const origKill = process.kill.bind(process);
  const selfKillSignals = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);
  process.kill = ((pid, sig) => {
    if (
      pid === process.pid &&
      typeof sig === "string" &&
      selfKillSignals.has(sig)
    ) {
      return true;
    }
    return origKill(pid, sig);
  });
}

// Force signal-exit to install its process.on(SIGINT, ...) listener.
signalExit(() => {});

// Mirror cli.ts's Deno-side handler that performs the real exit. Without it
// the process would just hang after signal-exit's no-op shim returns.
Deno.addSignalListener("SIGINT", () => Deno.exit(130));

console.log("READY");
// Keep the event loop alive until the parent sends SIGINT.
setInterval(() => {}, 60000);
`;

async function runChild(
  installShim: boolean,
): Promise<{ code: number; stderr: string }> {
  const child = new Deno.Command("deno", {
    args: ["run", "--allow-env", "--allow-read", "-"],
    env: { INSTALL_SHIM: installShim ? "1" : "0" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Pipe the script in via stdin (`deno run -`) so we don't need a temp file.
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(CHILD_SCRIPT));
  await writer.close();

  // Wait for "READY" so signal-exit is fully wired up before we send SIGINT.
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!buf.includes("READY")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  reader.releaseLock();

  child.kill("SIGINT");

  // Hard timeout in case the shim hang regresses (the user-reported symptom).
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 5000);

  const { code, stderr } = await child.output();
  clearTimeout(timeout);
  return { code, stderr: decoder.decode(stderr) };
}

describe("cli signal-exit shim", () => {
  test("baseline: without shim, signal-exit's self-kill triggers a permission error", async () => {
    const { code, stderr } = await runChild(false);
    // If this test ever stops failing without the shim, the underlying problem
    // has been fixed in Deno or signal-exit and the production shim can be
    // simplified or removed.
    expect(stderr).toContain("Requires run access");
    expect(code).not.toBe(130);
  });

  test("with shim: SIGINT exits cleanly with 130 and no permission prompt", async () => {
    const { code, stderr } = await runChild(true);
    expect(stderr).not.toContain("Requires run access");
    expect(stderr).not.toContain("NotCapable");
    expect(code).toBe(130);
  });
});
