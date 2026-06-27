import {
  getStackArchived,
  listAllStacks,
  runGitCommand,
  setStackArchived,
} from "../lib/stack.ts";

export interface ArchiveOptions {
  /** Stack to (un)archive. Defaults to the current branch's stack. */
  stackName?: string;
  /** Clear the archived flag instead of setting it. */
  unarchive?: boolean;
}

export interface ArchiveResult {
  stackName: string;
  /** The resulting archived state after the call. */
  archived: boolean;
  /** Whether a config write actually occurred (false when already in state). */
  changed: boolean;
}

async function resolveStackName(
  dir: string,
  explicit?: string,
): Promise<string> {
  if (explicit) {
    const known = await listAllStacks(dir);
    if (!known.includes(explicit)) {
      throw new Error(`Unknown stack: ${explicit}`);
    }
    return explicit;
  }

  const { code, stdout } = await runGitCommand(dir, "branch", "--show-current");
  if (code !== 0 || !stdout) {
    throw new Error(
      "Could not detect the current branch. Pass a stack name explicitly.",
    );
  }
  const { code: cfgCode, stdout: name } = await runGitCommand(
    dir,
    "config",
    `branch.${stdout}.stack-name`,
  );
  if (cfgCode !== 0 || !name) {
    throw new Error(
      `Branch ${stdout} is not part of a stack. Pass a stack name explicitly.`,
    );
  }
  return name;
}

export async function archiveStack(
  dir: string,
  options: ArchiveOptions,
): Promise<ArchiveResult> {
  const stackName = await resolveStackName(dir, options.stackName);
  const target = options.unarchive !== true;
  const current = await getStackArchived(dir, stackName);
  if (current === target) {
    return { stackName, archived: target, changed: false };
  }
  await setStackArchived(dir, stackName, target);
  return { stackName, archived: target, changed: true };
}
