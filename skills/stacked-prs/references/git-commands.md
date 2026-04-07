# Git Commands Reference

This document covers git commands used by the stacked-prs skill for managing
stacked branch workflows.

## Core Operations

### Rebase entire stack (Git 2.38+)

From the topmost branch, rebase the stack onto the main branch:

```bash
git checkout <topmost> && git rebase origin/main --update-refs
```

The `--update-refs` flag automatically updates intermediate branch refs during
rebase, keeping all branches in the stack aligned.

To enable this behavior globally:

```bash
git config --global rebase.updateRefs true
```

### Force-push all stack branches

Push all branches in the stack with protection against accidentally overwriting
remote changes:

```bash
git push --force-with-lease origin branch1 branch2 branch3
```

Always use `--force-with-lease` instead of `--force`. This prevents overwriting
work you haven't fetched yet.

### Create branch on top of stack

Create a new branch based on the topmost branch in the stack:

```bash
git checkout <topmost> && git checkout -b <new-branch>
```

## Post-Merge Cleanup

### After merge commit

When a branch in the stack is merged via a merge commit, rebase the remaining
stack:

```bash
git fetch origin && git checkout <topmost> && git rebase origin/main --update-refs
```

The merge commit preserves ancestry, so a standard rebase with `--update-refs`
handles the update.

### After squash merge

When a branch is squashed and merged, the ancestry breaks. Use `--onto` to
rebase onto the squashed merge:

```bash
git rebase --onto origin/main <merged-branch> <next-branch> --update-refs
```

This replays commits from `<next-branch>` onto `origin/main`, skipping the
now-invalid merged branch.

## PR Management

### Create PR with correct base branch

Create a pull request targeting the correct parent in the stack:

```bash
gh pr create --base <parent> --head <branch> --title "..."
```

### Retarget PR base branch

Change the base branch of an existing PR:

```bash
gh pr edit <number> --base <new-base>
```

### Query PR status

Check the status of PRs for branches in the stack:

```bash
gh pr list --head <branch> --json number,url,state,isDraft,title
```

## Conflict Resolution

During rebase, conflicts must be resolved manually:

1. Edit conflicted files to resolve conflicts
2. Stage resolved files: `git add <file>`
3. Continue the rebase: `git rebase --continue`
4. Repeat steps 1-3 until rebase completes

To abort a rebase in progress:

```bash
git rebase --abort
```

## Edge Cases

### Branches in other worktrees

The `--update-refs` flag only updates branches in the current worktree. If you
use `git worktree`, branches in other worktrees won't automatically update. You
must manually fetch and reset them in those worktrees.

### Detached HEAD after rebase

If you end up in a detached HEAD state after rebase, check out the topmost
branch:

```bash
git checkout <topmost>
```

### Stale remotes on other machines

When another machine pushes updates to the stack, your machine needs to fetch
and reset:

```bash
git fetch origin && git checkout <branch> && git reset --hard origin/<branch>
```

This ensures all machines stay synchronized.
