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
  // Strip --json and its following value
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") {
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

/** Run a gh command. Returns stdout as string. */
export async function gh(...args: string[]): Promise<string> {
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
  });
  const { stdout, success, stderr } = await cmd.output();
  if (!success) {
    throw new Error(new TextDecoder().decode(stderr));
  }
  return new TextDecoder().decode(stdout);
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
