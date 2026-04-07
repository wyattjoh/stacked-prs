import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { copyToClipboard, detectClipboardBinary } from "./clipboard.ts";

describe("detectClipboardBinary", () => {
  test("returns pbcopy on darwin", () => {
    expect(detectClipboardBinary("darwin")).toEqual({
      cmd: "pbcopy",
      args: [],
    });
  });

  test("returns clip on windows", () => {
    const result = detectClipboardBinary("windows");
    expect(result.cmd).toBe("clip.exe");
  });

  test("returns wl-copy on linux", () => {
    const result = detectClipboardBinary("linux");
    expect(result.cmd).toBe("wl-copy");
  });
});

describe("copyToClipboard", () => {
  test("calls spawn with text on stdin", async () => {
    const calls: Array<{ cmd: string; text: string }> = [];
    await copyToClipboard("hello world", {
      spawn: (cmd, _args, text) => {
        calls.push({ cmd, text });
        return Promise.resolve(true);
      },
      platform: "darwin",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("pbcopy");
    expect(calls[0].text).toBe("hello world");
  });
});
