import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo, runGit } from "../lib/testdata/helpers.ts";
import {
  getStackArchived,
  setBaseBranch,
  setStackArchived,
  setStackNode,
} from "../lib/stack.ts";
import { archiveStack } from "./archive.ts";

async function makeStack(dir: string, name: string, branch: string) {
  await addBranch(dir, branch, "main");
  await setBaseBranch(dir, name, "main");
  await setStackNode(dir, branch, name, "main");
}

describe("archiveStack", () => {
  test("archives a named stack", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");

    const result = await archiveStack(repo.dir, { stackName: "s" });
    expect(result).toEqual({ stackName: "s", archived: true, changed: true });
    expect(await getStackArchived(repo.dir, "s")).toBe(true);
  });

  test("archiving an already-archived stack is a no-op", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");
    await setStackArchived(repo.dir, "s", true);

    const result = await archiveStack(repo.dir, { stackName: "s" });
    expect(result).toEqual({ stackName: "s", archived: true, changed: false });
  });

  test("unarchives a named stack", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");
    await setStackArchived(repo.dir, "s", true);

    const result = await archiveStack(repo.dir, {
      stackName: "s",
      unarchive: true,
    });
    expect(result).toEqual({ stackName: "s", archived: false, changed: true });
    expect(await getStackArchived(repo.dir, "s")).toBe(false);
  });

  test("resolves the stack from the current branch when no name given", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");
    await runGit(repo.dir, "checkout", "feat/a");

    const result = await archiveStack(repo.dir, {});
    expect(result.stackName).toBe("s");
    expect(result.archived).toBe(true);
  });

  test("throws for an unknown stack name", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");

    await expect(archiveStack(repo.dir, { stackName: "nope" })).rejects
      .toThrow("Unknown stack: nope");
  });

  test("throws when current branch is not in a stack", async () => {
    await using repo = await createTestRepo();
    await makeStack(repo.dir, "s", "feat/a");
    await runGit(repo.dir, "checkout", "main");

    await expect(archiveStack(repo.dir, {})).rejects.toThrow();
  });
});
