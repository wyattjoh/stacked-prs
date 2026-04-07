export interface ClipboardBinary {
  cmd: string;
  args: string[];
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  text: string,
) => Promise<boolean>;

export function detectClipboardBinary(platform: string): ClipboardBinary {
  if (platform === "darwin") return { cmd: "pbcopy", args: [] };
  if (platform === "windows") return { cmd: "clip.exe", args: [] };
  return { cmd: "wl-copy", args: [] };
}

export interface CopyOptions {
  spawn?: SpawnFn;
  platform?: string;
}

const realSpawn: SpawnFn = async (cmd, args, text) => {
  const command = new Deno.Command(cmd, {
    args,
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  const status = await child.status;
  return status.success;
};

export async function copyToClipboard(
  text: string,
  opts: CopyOptions = {},
): Promise<boolean> {
  const platform = opts.platform ?? Deno.build.os;
  const spawn = opts.spawn ?? realSpawn;
  const { cmd, args } = detectClipboardBinary(platform);
  try {
    return await spawn(cmd, args, text);
  } catch {
    return false;
  }
}
