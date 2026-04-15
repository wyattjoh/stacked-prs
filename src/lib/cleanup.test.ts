import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo } from "./testdata/helpers.ts";
import { gitConfig, setBaseBranch, setStackNode } from "./stack.ts";
import { configBranchCleanup } from "./cleanup.ts";

async function getStackParent(
  dir: string,
  branch: string,
): Promise<string | undefined> {
  return await gitConfig(dir, `branch.${branch}.stack-parent`);
}

describe("configBranchCleanup", () => {
  test("reparents children of middle merged branch to the supplied new parent", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await addBranch(repo.dir, "feat/c", "feat/b");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");
    await setStackNode(repo.dir, "feat/c", "s", "feat/b");

    await configBranchCleanup(repo.dir, "s", "feat/b", "feat/a");

    const cParent = await getStackParent(repo.dir, "feat/c");
    expect(cParent).toBe("feat/a");
  });

  test("reparents children to base when new parent equals the base branch", async () => {
    await using repo = await createTestRepo();
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");
    await setBaseBranch(repo.dir, "s", "main");
    await setStackNode(repo.dir, "feat/a", "s", "main");
    await setStackNode(repo.dir, "feat/b", "s", "feat/a");

    await configBranchCleanup(repo.dir, "s", "feat/a", "main");

    const bParent = await getStackParent(repo.dir, "feat/b");
    expect(bParent).toBe("main");
  });
});
