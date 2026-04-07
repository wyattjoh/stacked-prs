const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

export interface TestRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

/** Run a git command in a directory, return trimmed stdout. */
export async function runGit(dir: string, ...args: string[]): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    env: { ...GIT_ENV, HOME: dir },
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();

  if (code !== 0) {
    const errMsg = new TextDecoder().decode(stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${errMsg}`);
  }

  return new TextDecoder().decode(stdout).trim();
}

/** Create a fresh git repo in a temp dir with initial commit on main. */
export async function createTestRepo(): Promise<TestRepo> {
  const dir = await Deno.makeTempDir({ prefix: "stacked-prs-test-" });

  await runGit(dir, "init", "--initial-branch=main");
  await commitFile(dir, "README.md", "# Test Repo\n");

  return {
    dir,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

/** Create a branch off a parent with a single-file commit. Returns to original branch. */
export async function addBranch(
  dir: string,
  name: string,
  parent: string,
): Promise<void> {
  const current = await runGit(dir, "rev-parse", "--abbrev-ref", "HEAD");

  await runGit(dir, "checkout", parent);
  await runGit(dir, "checkout", "-b", name);

  const filename = name.replaceAll("/", "-") + ".txt";
  await commitFile(dir, filename, `Branch: ${name}\n`);

  await runGit(dir, "checkout", current);
}

/** Commit a file on the current branch. */
export async function commitFile(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(`${dir}/${filename}`, content);
  await runGit(dir, "add", filename);
  await runGit(dir, "commit", "-m", `add ${filename}`);
}
