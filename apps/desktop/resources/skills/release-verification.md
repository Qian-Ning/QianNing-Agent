---
name: release-verification
description: a release is about to be tagged — prove the artefact, the tag, and the tested tree are the same thing
---

# Verifying a release before the tag goes out

A release asserts three identities. Everything in this document exists to make
them checkable rather than assumed:

1. the artefact you are publishing was built from the commit you are tagging;
2. the commit you are tagging is the tree you tested;
3. the tree you tested is still what you think it is — nothing landed underneath
   it after the run that made you confident.

Each of the three fails differently, and two of them fail silently. Publish a
binary built from a dirty tree and nobody notices until a bug report references
code that is not in the repository. Tag the merge commit instead of the tested
commit and the tagged tree has never been through the test suite at all.

Do these checks *before* the tag exists. After the tag, every fix is a second
release.

## Read the artefact, not the build directory

The build directory is the input. The archive is what a user gets, and they are
not the same thing. List it:

```bash
unzip -l dist/release-gate-2.4.0.zip
tar -tzf dist/release-gate-2.4.0.tar.gz
```

Then answer four questions from the listing, not from your memory of the build
script:

- **Does the version inside match the tag?** A stale `dist/` from the previous
  build carries the previous version and passes every test you run against it.
  Run `./release-gate --version` (or the packaged equivalent) from the extracted
  archive and compare the printed string with the tag.
- **Is anything in there that should not ship?** Source maps, TS sources,
  fixtures, `.env` files, signing keys, CI config, an accidentally vendored
  dependency directory, test reports. Grep the listing rather than eyeballing
  the first screen: `tar -tzf x.tgz | grep -E '\.map$|/src/|\.env|\.pem$'`.
- **Is anything missing?** The licence file, the changelog, the native binary,
  a runtime resource directory. A missing resource usually fails at first use,
  on a user's machine, in a code path no test covers.
- **Is it bigger or smaller than the last release by a lot?** Compare entry
  counts and total size against the previous artefact. A release that doubled in
  size has a story; find it before shipping.

Count the entries carefully. `git archive | tar -t` lists directories as well as
files, so a raw line count overstates the file count by one per directory.
Measured on a repository with 2,823 tracked files, the same tree listed 3,035
entries — 212 of them directories. Filter them out before you compare against
`git ls-tree -r --name-only | wc -l`, and if the numbers do not match exactly,
that is the finding, not a rounding error.

The strongest version of this check is a diff, not a listing: extract the
archive to a temporary directory and diff it against the build output directory.
Anything present in one and not the other is either a packaging rule you have
forgotten or a mistake.

## The tag must point at the commit you built

Tags do not move on their own. The failure is that the tag is placed on a commit
that is not the one that was tested — usually the branch head after a merge, or
`main` after a fast-forward.

Resolve what the tag actually points at, and never trust the tag name alone:

```bash
git rev-parse v2.4.0^{commit}      # the commit, annotated or lightweight
git rev-parse v2.4.0^{tree}        # the tree
git log -1 --format='%H %ci %s' v2.4.0
```

`^{commit}` works for both annotated and lightweight tags, which is why it is the
form to use in a script. Verified on a test repository: an annotated tag created
at `30f60f6` still resolved to `30f60f6` after a new commit moved the branch to
`b9178d1`; the tag had not drifted, the branch had.

Two checks belong in the build job itself:

```bash
git describe --tags --exact-match      # prints the tag, exits 128 if HEAD is not tagged
git status --porcelain                 # empty means the tree is clean
```

Verified: `git describe --tags --exact-match` printed the tag at the tagged
commit and exited 128 with `fatal: no tag exactly matches '<sha>'` one commit
later. Wire that exit status into the job — a release build that runs on an
untagged commit should fail loudly, not produce an artefact named after whatever
version file it found.

`git status --porcelain` being empty matters more than it looks. A build from a
dirty tree contains code that exists on exactly one machine, and the artefact is
unreproducible by definition. If the build script writes generated files into
the tree, run the check *after* the build and confirm the generated output is
byte-identical to the committed one, or the generator drifted.

## The tree you validated equals the tree you shipped

Compare trees by hash, not by commit id and not by "it looks the same".

```bash
git rev-parse HEAD^{tree}
git diff --stat v2.4.0..HEAD        # empty output: tag and head are the same tree
```

A tree hash survives operations that change commit ids. A rebase, a squash, or a
cherry-pick produces a new commit with a new hash and the *same* tree; the
commit id alone cannot tell you whether the content changed. So record the tree
hash alongside the commit in the release record, and compare tree hashes when
you are asking "is this the same content".

In the test repository, tagging `30f60f6` and moving to `b9178d1` gave
`git rev-parse v1.0.0^{tree} HEAD^{tree}` two different hashes
(`b05c3985…` and `39b0616c…`) — which is the expected answer, and also the exact
command that tells you, in one line, whether the tag you are about to publish
covers the change you think it covers.

If the release is built from a pipeline cache or a shared workspace, add the one
check that catches the worst case: rebuild in a clean checkout of the tagged
commit and compare the artefact hash. A mismatch means the published artefact
contains something the repository cannot reproduce.

## What a green pipeline does not prove

A green run is evidence about the checks that executed, on the commit that
executed them. It says nothing about the rest. The list of things it routinely
does not cover:

- **Lanes that were skipped.** A path filter, a changed-files optimisation, or a
  `if:` condition means a suite did not run. "CI passed" without naming the lanes
  is a claim nobody can check. Read the job list, not the badge.
- **A job that matched nothing.** A test runner invoked with a glob that matched
  no files exits 0. So does a linter on an empty set. Watch a new gate fail once
  on purpose — deliberately break the thing it guards — before trusting it.
- **Tests run against a development build.** Optimisation, stripped assertions,
  and different dependency resolution are exactly the differences that hide
  release bugs. Test the artefact you are shipping, or state that you did not.
- **Install and upgrade.** Tests rarely install the installer. A green suite with
  an installer that refuses to launch on a clean machine is a green suite.
- **Signing and notarisation.** These run after tests, and they fail for reasons
  tests cannot see: an expired certificate, a wrong identity, a timestamp server
  that is down.
- **The published artefact.** Between "the job produced a file" and "the file is
  downloadable and runs" there is an upload step, a CDN, and sometimes a rename.
  Download what you published and run it once.

Anything in that list that the pipeline does not cover belongs in a manual
pre-tag checklist with a name next to each line.

## When the base moved under you

The single most common way a verified release becomes an unverified one: the
branch was rebased or merged after the green run, and the tag went on the merged
result. The tests passed on a tree that no longer exists.

The rule is blunt: **after the base moves, the previous run is evidence about a
different tree.** Re-run the full gate on the merged result. Re-running only the
delta is how a conflict resolution that dropped a change ships silently.

Re-run, specifically, every check whose answer depends on the other side:

- the lockfile diff (`git diff <base>..HEAD -- lockfile`) — a merge can take a
  dependency version from the base that nobody tested against;
- database migrations, which are ordered against the base's migrations and can
  now collide on a revision id;
- generated clients and schemas, if they are produced from a contract the base
  also changed;
- the version number and the changelog, because both sides may have bumped them;
- anything that compares against the base branch — snapshots, API surface
  baselines, golden files, migration heads.

Then re-check the tag's position (`git rev-parse v2.4.0^{commit}`) once more
after the re-run. If the merge commit is the one you tested, the tag belongs on
the merge commit — but say so, because "tagged the merge" and "tagged the
feature commit" produce different trees and different histories.

## The release record

Write this down while the release is happening, not reconstructed afterwards:

- tag name, commit id, tree hash;
- artefact file name and its hash, as published;
- toolchain and dependency versions that produced it (the ones the build actually
  used, not the ones in the manifest);
- the exact commands that were run, including the manual ones;
- who verified, and the date.

The record exists so that a bug found a month later can be answered with "that
artefact came from this tree, built this way". Without it, the only available
answer is a guess, and the guess is usually wrong.

## Pre-tag checklist

1. Tree is clean; the build ran from a commit, not from a working directory.
2. `git describe --tags --exact-match` succeeds in the release job.
3. `git rev-parse v<version>^{commit}` is the commit that was tested.
4. `git rev-parse v<version>^{tree}` equals the tree hash recorded at test time.
5. No commits landed after the tested tree; if any did, the gate was re-run on
   the merged result.
6. The artefact listing contains the expected files and none of the forbidden
   ones; the version printed by the artefact matches the tag.
7. The artefact hash in the release record is the hash of the file that is
   actually published.
8. Every manual check that the pipeline does not cover was performed and
   recorded.

## Where this goes wrong

- Tagging `main` after a merge, because the merge commit "is basically the same
  code". It is a different tree, and it is the one that ships untested.
- Reading the build directory and calling it the artefact. The artefact is the
  archive, and the archive is what you must list.
- Comparing commit ids when the question is about content. A rebase changes the
  id and keeps the tree; a bad merge changes the tree and keeps the version.
- Treating a green pipeline as full coverage when a path filter skipped the
  integration lane, so the one subsystem that changed was never run.
- Counting archive entries without excluding directories, then "investigating" a
  discrepancy that is only directory metadata.
- Re-running one job after a rebase and calling the release verified. The jobs
  that did not re-run tested the old tree.
- Fixing a release after the tag by force-moving the tag. Anyone who already
  fetched has the old object, and the two are indistinguishable by name.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
