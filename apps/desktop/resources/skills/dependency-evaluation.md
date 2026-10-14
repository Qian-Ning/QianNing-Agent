---
name: dependency-evaluation
description: considering adding, replacing, or removing a third-party dependency
---

# Deciding whether to take a dependency

A dependency is not free software. It is code you now ship, upgrade, audit, and
answer for, and the price is not the lines it saves you.

## Price the whole cost, not the convenience

- **Build and install.** How much it adds to install time, bundle size, container
  size, and cold start.
- **Transitive weight.** The dependencies it brings, and theirs. One direct
  dependency can pull in dozens. Count them, do not guess.
- **Security surface.** Every package is code you did not write, running with
  your privileges. Check whether there is a real maintainer response to reports.
- **Upgrade treadmill.** How often do major versions land, and do they break
  things? A library that ships breaking changes twice a year is a recurring tax.
- **Abandonment.** Last release date, open issue age, whether maintainers reply.
  A popular-but-dead package is more expensive than one you write.
- **Attention.** Who in the project will own this when it breaks at a bad hour?

Write the estimate down next to the alternative. The comparison people skip is
against **your own twenty lines**, not against nothing.

## The twenty-line rule

If the thing you need is small, stable, and you can write it in an afternoon
with a test, own it.

- A date formatter, a slug function, a small parser for a format you control, a
  debounce: write it.
- A parser for a large external standard, a crypto primitive, a protocol
  implementation, a timezone database: take the dependency. These are the cases
  where "twenty lines" is the trap — you will spend a year discovering the edge
  cases the library already knows.
- The test is not size. It is: **how much of the domain's knowledge is embedded
  in it, and how likely is a subtle mistake?**

Never write your own cryptography, and never write your own date/time arithmetic
for real calendars. Those two categories have a century of accumulated edge cases
and a long history of quiet disasters.

## Read the code you are adopting

At minimum, open the entry point of the function you will call and read it.

- Does the implementation match the name and the documentation?
- Does it throw, return errors, or silently coerce? Errors swallowed in a
  dependency become mysterious behavior in your product.
- Does it modify its inputs, hold global state, or leak resources — a timer, a
  socket, a listener you must close?
- What does it do on malformed input: throw, return null, or crash the process?

The first five minutes of reading saves the week of debugging a misreading costs.

## Check before adding

- **License.** Is it compatible with how this project is distributed? A copyleft
  dependency in a permissively licensed product is a problem, not a detail.
- **Maintenance signals.** Recent commits, releases with notes, issues answered,
  more than one maintainer, a security policy. No commits in years and full of
  open issues is a "no" unless it is frozen-complete and you can read all of it.
- **Adoption.** Widely used means bugs were found before you found them. Obscure
  means you are the tester.
- **Tests.** At least a real test suite you can run. A library with no tests is a
  library whose behavior is defined by its current version.
- **What the platform already gives you.** Standard library, runtime built-ins,
  the framework you already depend on. A new dependency to do what you already
  have is pure cost.

## If you take it

- **Pin the version**, and let the lockfile be the truth. Range specifiers that
  silently float are how a build changes without a commit.
- **One update path.** Dependabot-style automation or a scheduled review, plus a
  person who reads the changelog. Automated bumps merged unread are how supply
  chain attacks land.
- **Wrap it at the boundary** when it is load-bearing: your own small interface,
  so replacing it later is a change in one place rather than a search-and-replace
  across the codebase.
- **Write the abandonment plan** in the change or the record: if this stops being
  maintained, what do we do — fork, vendor, or replace with the twenty lines? If
  the answer is "we would be stuck", that is a decision to state, not to
  discover.
- **Vendor** when reproducibility matters more than updates: an air-gapped build,
  a frozen-dead dependency you must keep working, a small package you have
  audited and will not re-audit.

## Removing one

Dependencies should also leave. A package that is no longer used, or used for one
call that the standard library now handles, is build time and risk for nothing.

Before removing: find the real usages (not the mentions in comments), check the
transitives it was pulling in for others, and confirm nothing loads it
dynamically or by name at runtime.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
