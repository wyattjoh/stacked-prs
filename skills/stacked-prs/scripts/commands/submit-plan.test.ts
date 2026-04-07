import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addBranch, createTestRepo } from "../lib/testdata/helpers.ts";
import type { TestRepo } from "../lib/testdata/helpers.ts";
import { setBaseBranch, setStackNode } from "../lib/stack.ts";
import type { StackTree } from "../lib/stack.ts";
import { setMockDir, writeFixture } from "../lib/gh.ts";
import { computeSubmitPlan } from "./submit-plan.ts";
import { generateNavMarkdown } from "./nav.ts";

describe("computeSubmitPlan", () => {
  let repo: TestRepo;
  let mockDir: string;

  beforeEach(async () => {
    repo = await createTestRepo();
    mockDir = await Deno.makeTempDir();
    setMockDir(mockDir);
  });

  afterEach(async () => {
    setMockDir(undefined);
    await repo.cleanup();
    await Deno.remove(mockDir, { recursive: true });
  });

  test("marks branches with no PRs as create", async () => {
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setStackNode(repo.dir, "feat/b", "my-stack", "feat/a");

    // No PR fixtures written, gh mock returns "[]" by default

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");

    expect(plan.stackName).toBe("my-stack");
    expect(plan.branches).toHaveLength(2);
    expect(plan.branches[0].branch).toBe("feat/a");
    expect(plan.branches[0].action).toBe("create");
    expect(plan.branches[0].pr).toBeNull();
    // Root branch targets the base branch, so it should not be a draft
    expect(plan.branches[0].desiredDraft).toBe(false);
    expect(plan.branches[0].draftAction).toBe("none");
    expect(plan.branches[1].branch).toBe("feat/b");
    expect(plan.branches[1].action).toBe("create");
    expect(plan.branches[1].pr).toBeNull();
    // Child branch targets feat/a (not main), so it must be a draft
    expect(plan.branches[1].desiredDraft).toBe(true);
    expect(plan.branches[1].draftAction).toBe("none");
    expect(plan.isNoOp).toBe(false);
  });

  test("marks update-base when PR base does not match parent", async () => {
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setStackNode(repo.dir, "feat/b", "my-stack", "feat/a");

    // feat/a has PR with correct base "main"
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 10,
        url: "https://github.com/o/r/pull/10",
        title: "feat: a",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
      }],
    );

    // feat/b has PR with wrong base "main" (should be "feat/a")
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/b", "--repo", "o/r"],
      [{
        number: 11,
        url: "https://github.com/o/r/pull/11",
        title: "feat: b",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
      }],
    );

    // Empty comment arrays for nav plan
    await writeFixture(
      mockDir,
      ["api", "repos/o/r/issues/10/comments"],
      [],
    );
    await writeFixture(
      mockDir,
      ["api", "repos/o/r/issues/11/comments"],
      [],
    );

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");

    expect(plan.branches[0].branch).toBe("feat/a");
    expect(plan.branches[0].action).toBe("none");
    // feat/a targets the base branch, so it should not be a draft
    expect(plan.branches[0].desiredDraft).toBe(false);
    expect(plan.branches[0].draftAction).toBe("none");
    expect(plan.branches[1].branch).toBe("feat/b");
    expect(plan.branches[1].action).toBe("update-base");
    // feat/b targets feat/a, so it must be a draft. Fixture has isDraft:false,
    // so the plan should request a transition to draft.
    expect(plan.branches[1].desiredDraft).toBe(true);
    expect(plan.branches[1].draftAction).toBe("to-draft");
    expect(plan.isNoOp).toBe(false);
  });

  test("isNoOp is true when all PRs have correct base and nav is current", async () => {
    await addBranch(repo.dir, "feat/a", "main");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");

    // feat/a has PR with correct base
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 10,
        url: "https://github.com/o/r/pull/10",
        title: "feat: a",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
      }],
    );

    // Nav comment already matches what generateNavMarkdown would produce
    const tree: StackTree = {
      stackName: "my-stack",
      baseBranch: "main",
      mergeStrategy: undefined,
      roots: [{
        branch: "feat/a",
        stackName: "my-stack",
        parent: "main",
        children: [],
      }],
    };
    const navBody = generateNavMarkdown(tree, new Map([["feat/a", 10]]), 10);

    await writeFixture(
      mockDir,
      ["api", "repos/o/r/issues/10/comments"],
      [{ id: 500, body: navBody }],
    );

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");

    expect(plan.branches).toHaveLength(1);
    expect(plan.branches[0].action).toBe("none");
    expect(plan.branches[0].desiredDraft).toBe(false);
    expect(plan.branches[0].draftAction).toBe("none");
    expect(plan.navComments).toHaveLength(0);
    expect(plan.isNoOp).toBe(true);
  });

  test("flips a non-base PR back to draft when it has been marked ready", async () => {
    await addBranch(repo.dir, "feat/a", "main");
    await addBranch(repo.dir, "feat/b", "feat/a");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");
    await setStackNode(repo.dir, "feat/b", "my-stack", "feat/a");

    // feat/a is correctly ready (parent = main)
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 10,
        url: "https://github.com/o/r/pull/10",
        title: "feat: a",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
      }],
    );

    // feat/b correctly targets feat/a but is incorrectly ready (should be draft)
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/b", "--repo", "o/r"],
      [{
        number: 11,
        url: "https://github.com/o/r/pull/11",
        title: "feat: b",
        state: "OPEN",
        isDraft: false,
        baseRefName: "feat/a",
      }],
    );

    await writeFixture(mockDir, ["api", "repos/o/r/issues/10/comments"], []);
    await writeFixture(mockDir, ["api", "repos/o/r/issues/11/comments"], []);

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");

    expect(plan.branches[0].action).toBe("none");
    expect(plan.branches[0].draftAction).toBe("none");
    expect(plan.branches[1].action).toBe("none");
    expect(plan.branches[1].desiredDraft).toBe(true);
    expect(plan.branches[1].draftAction).toBe("to-draft");
    expect(plan.isNoOp).toBe(false);
  });

  test("flips a base-targeted PR to ready when it is currently a draft", async () => {
    await addBranch(repo.dir, "feat/a", "main");

    await setBaseBranch(repo.dir, "my-stack", "main");
    await setStackNode(repo.dir, "feat/a", "my-stack", "main");

    // feat/a targets main but is still a draft
    await writeFixture(
      mockDir,
      ["pr", "list", "--head", "feat/a", "--repo", "o/r"],
      [{
        number: 10,
        url: "https://github.com/o/r/pull/10",
        title: "feat: a",
        state: "OPEN",
        isDraft: true,
        baseRefName: "main",
      }],
    );

    await writeFixture(mockDir, ["api", "repos/o/r/issues/10/comments"], []);

    const plan = await computeSubmitPlan(repo.dir, "my-stack", "o", "r");

    expect(plan.branches[0].action).toBe("none");
    expect(plan.branches[0].desiredDraft).toBe(false);
    expect(plan.branches[0].draftAction).toBe("to-ready");
    expect(plan.isNoOp).toBe(false);
  });
});
