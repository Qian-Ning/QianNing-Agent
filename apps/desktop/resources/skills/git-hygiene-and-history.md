---
name: git-hygiene-and-history
description: staging, committing, branching, or preparing a change for review
---

# Git hygiene, and the commands that cannot be undone

Git records the story of why the code is like this. Most of the damage in this
area comes from a handful of commands that destroy that story without warning, so
this document starts with them.

## The commands that need an explicit request

Never run these on your own initiative, in a shared repository or a shared
machine:

- `git reset --hard`, `git checkout .`, `git clean -fd` — they discard work, and
  they discard the **uncommitted** work of whoever else shares the tree.
- `git stash` — hides someone's changes where nobody will look for them.
- `git add .` and `git add -A` — stage things nobody chose, including secrets,
  scratch files, and another agent's half-finished work.
- `git commit --no-verify` — skips exactly the checks that were added because
  something went wrong before.
- Any history rewrite on a branch someone else may have pulled: `push --force`,
  `rebase` on a shared branch, `commit --amend` after pushing.

If a command is genuinely needed, ask, or say plainly what you are about to do
and what it costs.

## Stage by explicit path, then look again

1. Add the files **by name**, the ones you actually changed.
2. Run `git status --short` and read it. Something staged that you did not
   expect — a lockfile, a scratch script, a local config — unstage it before
   committing.
3. Then commit.

This ordering is the whole discipline. The mistake is not that `git add .` is
evil; it is that nobody reads what it staged.

## The message explains why

- Subject in the project's convention — `fix(scope): …`, `feat(scope): …` —
  describing **what changed**, short enough to read in a log.
- Blank line, then a body. A one-line commit for anything non-trivial throws away
  the only place the reasoning was ever written down.
- The body explains **why**, and what the alternative was when the choice was not
  obvious. It is not a restatement of the diff; the diff is right there.
- If the change has a surprising part, name it. A reviewer should not have to
  guess which hunk was the point.
- Trailers — an issue reference, a co-author — after a blank line, and only if
  the project uses them.

## One coherent change, and no hidden behavior change

- A commit should be one thing: a fix, a feature, a refactor. Two unrelated
  changes in one commit cannot be reviewed, reverted, or bisected separately.
- **Never hide a behavior change inside a `refactor` commit.** If the same commit
  also changes a default, an error type, or an ordering, the message is now
  false, and `git bisect` will land on it and lie to whoever is debugging.
- Commit in the order that keeps every intermediate state working, so a bisect
  over the range is meaningful.

## Isolation

- One task, one branch, one dedicated working directory. Do not develop on the
  default branch, and do not share a working directory with another task.
- Never modify, reset, or delete another task's branch or working directory, and
  never include unrelated changes in yours.
- Before opening or updating a pull request, the head must contain the latest
  upstream default branch. Verify it, do not assume it.
- If a pushed branch is behind, refresh it **without rewriting what others may
  have pulled** — merge the upstream branch in rather than rebasing a shared
  branch.

## The traps that cost hours

- **Recovering a file**: `git checkout HEAD -- <path>` restores tracked content.
  A three-way apply of a patch writes the index as well, and leaves the workspace
  in a state you did not intend.
- **Line endings**: respect the repository's `.gitattributes`. On a repository
  configured for one ending, writing the other produces a whole-file diff that
  hides the real change.
- **Binary files**: a file containing a stray NUL byte is treated as binary, so
  text tools skip it silently — including searches that were supposed to find
  something. When a scan finds nothing in a file you know contains the pattern,
  suspect this.
- **Detecting a change that never happened**: after `git add` and a commit, check
  the revision actually moved. It is entirely possible for a staging step to fail
  while a later step in the same command block reports success.
- **A pushed reference and a local revision are different claims.** After
  pushing, compare the remote reference to the local commit, byte for byte, if
  anything downstream depends on which revision landed.

## After a merge

- Verify that the merged tree is the tree that was validated — compare the merge
  commit's tree to the head that was tested, byte for byte. A verified pull
  request and a merge that landed that exact content are two separate claims, and
  only the second one matters.
- Check the working tree is clean afterwards, and that nothing from another task
  was swept up in the merge.

## Names, and refs, and honesty about them

Truncated revision hashes are for humans to read, not for tools to consume. Any
hash, ref, or tag you pass to a command should be copied from that command's
output, never completed from memory — a plausible-looking hash that does not
exist fails in a way that looks like "nothing has happened yet".

## Before you leave

- `git status` clean, or containing only work you can explain.
- No stashes, no detached heads, no branches left behind that a later task will
  trip over.
- Nothing committed that should not be in the repository: no credentials, no
  generated artifacts the project does not track, no editor and OS junk.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
