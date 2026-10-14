---
name: pre-commit-review
description: the user is about to commit, push, or open a pull request
---

# Reviewing your own change before it leaves the bench

The last read of a diff is the cheapest one you will ever get. Everything below
is cheaper here than in review, and far cheaper than in production.

## Read the diff, not the code

Open the diff itself, top to bottom, and read it as if a stranger wrote it. You
are looking for two different things, and it helps to do them in separate passes.

**Pass one — scope.** Does this diff do exactly what the message says, and
nothing else?

- Unrelated reformatting, renames, or dependency bumps hide the real change from
  the reviewer and from `git bisect` later. Take them out, or say in the message
  that they are deliberate.
- Files that should not be here: a scratch script, a local config, a fixture you
  meant to delete, a lockfile change with no manifest change.
- Line endings and whitespace-only hunks on files you did not mean to touch.

**Pass two — content.** Now read for what is wrong.

- **Secrets and identifiers.** No keys, tokens, connection strings, real host
  names, or personal paths. Check the test fixtures too — that is where they
  hide.
- **Debug leftovers.** Prints, `console.log`, a temporary `--verbose` default, a
  commented-out block, a `TODO` you will not do.
- **Error handling.** Does a failure get swallowed, an exception get caught and
  ignored, a promise go unawaited? Every new `catch` should do something the
  reader can point at.
- **Boundaries.** Does this change widen a permission, loosen a check, bypass a
  validation, or add a path that skips cleanup? If it does, the message has to
  say why.
- **Cleanup.** Every listener, timer, watcher, connection, and child process
  added here needs an owner and a teardown. Where does it get removed on reload,
  stop, or failure?
- **User-visible text.** Every new string a user sees goes through the project's
  localization mechanism, not straight into the markup.

## Tests: check the claim, not the count

- Does the diff include one? A behavior change with no test is an unfinished
  change, unless you can say in one line why no test can observe it.
- Would it have failed before the fix? If you did not see it fail, you do not
  know yet. Watch it go red, then green.
- Does it assert behavior or implementation? A test that pins a private helper
  or a source line will break on the next honest refactor and teach nobody
  anything.

## Compatibility: the pass people skip

For anything touching a contract, a persisted format, a default value, or a
public interface, ask the four questions explicitly:

- old code, existing data — still works?
- new code, existing data — migrated?
- new code, new data — fine?
- interrupted halfway — recoverable?

If a default value changed, that is a behavior change even when the diff does
not mention behavior, and it needs to be in the message.

## The message

The message explains **why**, not what. The diff already says what.

- Subject states the change in the project's convention; body explains the
  reason it exists, and the alternative you rejected if the choice was not
  obvious.
- If the change has a surprising part, the message names it. A reviewer should
  not have to guess which hunk was the point.
- Stage by explicit path, then re-read what is staged. `git add .` puts things
  in commits that nobody ever chose to commit.

## Before you push

- Run the narrowest gate that can fail on this change, then the one above it.
  Say which you ran and which you did not; "tests pass" without naming them is
  not a claim anyone can check.
- If a check is red and you believe it is unrelated, reproduce it on the
  untouched baseline and say so with the result. "Probably flaky" is not a
  finding.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
