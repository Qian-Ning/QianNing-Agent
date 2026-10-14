---
name: build-and-release
description: changing a build, a CI pipeline, a release process, or a version
---

# Builds and releases

A release is a claim: **the artifact that was tested is the artifact that
ships.** Almost everything below exists to make that claim checkable rather than
assumed.

## The build you test must be the build you ship

Release builds differ from development ones, and the differences are exactly the
kind that hide bugs:

- Optimisation changes timing, inlining, and sometimes observable behavior.
- Assertions and checks are often compiled out.
- Environment flags change defaults, error handling, and logging levels.
- Different dependencies are resolved, especially without a lockfile.

If your tests ran against a development build, you have tested a different
program. Build once, promote the same artifact through the stages, and verify it
by hash — do not rebuild per environment.

## Reproducibility

- Dependencies pinned and locked. A floating range means the same commit builds
  differently next week, and "it works on my machine" is usually a missing lock
  file rather than a mystery.
- A clean environment: no relying on globally installed tools, a leftover cache,
  or a file that happens to exist in someone's checkout.
- Record what went into it — the revision, the toolchain versions, the lockfile —
  so a build can be reproduced when a released artifact needs to be rebuilt for
  an investigation.

## Version numbers have one source of truth

Three files that each claim a version will disagree, and the one that is wrong
will be the one the user sees. Derive the rest from one, or generate them.

- Decide what the number means and say it: is a minor bump a feature, a fix, or
  anything at all?
- **Tag the commit you actually released**, and tag specifically — an annotated
  or lightweight tag is a project decision; the thing that matters is that the
  tag points at a revision you validated, not at whatever the branch happened to
  be at the time.
- Version the artifact, not only the source. A user needs to know which build
  they are running, and the answer must be readable from the installed thing.

## CI is part of the product

- The pipeline defines what "verified" means. Changing it changes the product's
  guarantees, so review it the way you review code.
- **Green proves only the checks that ran.** A path filter that skips a suite
  means that change landed unverified by CI, and saying "CI passed" without
  naming which lanes ran is a claim nobody can check.
- When you add a gate, watch it fail once on purpose. A check that has never been
  seen red is not yet a gate — it may be passing because it is not running, or
  because it matches nothing.
- Read the log of a new gate's first success, and confirm it printed the thing it
  was supposed to test. "The job is green" and "the job did the work" are two
  different claims.
- Secrets belong in the environment or a secret store, never baked into the
  artifact, never echoed into a log. Build logs are widely readable.

## Caches, the quiet source of wrong artifacts

- A cache key must cover everything that changes the output: the lockfile, the
  toolchain version, the build flags.
- A stale cache produces an artifact **nobody built from this source**. When
  something inexplicable happens, a cache is a prime suspect, and clearing it is
  a cheap experiment.
- Do not cache anything containing secrets.

## Release notes say what changed for the user

A commit dump is not release notes. Write for the person deciding whether to
upgrade: what is new, what is fixed, what breaks, and what to do about it if
anything does.

- Name the breaking changes explicitly, with the migration step. Burying one in a
  long list is how a release loses trust.
- Say plainly if nothing changed for the user — a version bump for internal work
  is fine, and dressing it up is worse.

## Rolling back

Decide this before you need it:

- **Does the previous artifact still exist, and is it installable?** A release
  whose predecessor was overwritten cannot be rolled back.
- **Is the data forward-compatible?** Application rollback is easy; a schema
  migration that ran is not reversible, and rolling the code back against the new
  schema may be worse than going forward.
- **A release that cannot be rolled back is a decision to state**, not a surprise
  to discover at the moment it matters.
- Sign and checksum artifacts, and never rebuild after signing — the second build
  is a different artifact with the same name.

## Failed releases

- Do not retry blindly. A build that failed after a dependency changed and passes
  when rerun has told you what happened; rerunning until green throws that
  finding away.
- A failed release is evidence. Record the revision, the failure, and what was
  different from the last successful one.
- If a release goes out wrong, the first priority is restoring service, the
  second is understanding, and the third is writing it down. Do not skip the
  third because the first two were loud.

## Keep the path clean

A release process accumulates steps nobody understands and jobs nobody can
explain. Every stage should have an owner and a reason. Delete the ones that no
longer serve a purpose rather than letting them run for years because removing
them feels risky — a pipeline that nobody can safely change is already a risk.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
