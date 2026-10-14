---
name: keeping-a-suite-fast
description: a test suite has become slow, flaky, or is being run less often
---

# Keeping the suite fast

A slow suite is not a performance problem. It is a **correctness problem with a
delay**, because a suite that takes too long stops being run, and a suite that
stops being run protects nothing.

## The feedback loop is the product

- The inner loop — the tests you run while editing — should be **seconds**. If it
  is minutes, people will edit without running it, and the failures arrive in a
  batch at the end.
- The full suite can be minutes. It should not be tens of minutes, and where it
  is, the cause is almost always a handful of tests rather than a general slowness.
- Make it trivially easy to run **just the relevant part**, and document how. A
  developer who cannot run three files in two seconds will run everything, slowly,
  or nothing at all.

## Four reasons a test is slow

Almost every slow test is one of these, and each has a different fix:

1. **Real I/O** — network, database, filesystem, a provider API. Fix: use a fake at
   the boundary for the fast layer, and keep a smaller number of real-boundary
   tests for the integration layer.
2. **A sleep.** See below. This is the fix that pays immediately.
3. **Setup repeated per test** when one setup would serve many. Fix: share it where
   the framework allows — and read the warning about shared state before doing so.
4. **A genuinely large computation** — a big fixture, a real dataset, an expensive
   compile. Fix: shrink the input unless the case is *about* the size, or move the
   test to the slow layer and run it less often.

## Sleeps are not synchronisation

This is the single highest-yield change in most suites.

- **Wait for a condition, not a duration.** A sleep is simultaneously slower than
  necessary and less reliable than necessary — the worst of both.
- A real wait: poll the condition with a timeout and a short interval, or use the
  framework's or the platform's signalling mechanism. Then the test passes as soon
  as the work is done, and fails with a real message when it is not.
- A sleep long enough to be reliable is long enough to be slow. A sleep short
  enough to be fast is a flaky test. There is no duration that is both.
- Where a clock is involved, inject it rather than waiting for real time to pass.

## Do not hit the network or a paid provider in the fast layer

- **A network call in a unit test makes the suite depend on a service you do not
  control**, and turns an outage into a red build.
- **A call to a real provider costs money per run**, which is a policy problem as
  well as a speed problem. Keep those in a separate, smaller, explicitly-labelled
  layer.
- Record what the fast layer fakes: an HTTP boundary, a clock, a random source, a
  queue. Faking at the actual boundary is fine; faking your own internal
  collaborators and asserting on the fakes is not a test of anything.

## Parallelism exposes the truth

- Running tests in parallel is worth doing, and its main benefit is not speed: **it
  finds the shared state**, by failing intermittently on tests that were only
  passing because of the order they ran in.
- That only works if the tests are genuinely isolated — separate records, separate
  temporary directories, separate ports or a means of allocating one dynamically.
  A harness that assigns the same port to eight workers produces failures that
  look like product bugs.
- Flakiness under parallelism is a finding, not an inconvenience. Fix the isolation
  rather than serialising everything back together.

## Watch the trend, not just the number

- **Record the suite duration.** A suite that has doubled since last quarter has a
  specific cause, and it is findable: the report sorted by duration names it.
- Look at the slowest handful. In most suites a few tests dominate, and they are
  usually the ones with a real network call or a sleep that nobody remembers
  adding.
- Do the same for reliability: track retries and intermittent failures. A test that
  fails one run in twenty is a test that will be disabled within the month, and
  then nothing covers that path at all.

## Do not make the suite fast by removing coverage

- **Move the slow test, do not delete it.** The expensive, low-frequency layer is
  where the end-to-end and provider tests belong — not in the bin.
- A test deleted because it was slow leaves the behaviour it checked unverified,
  and the deletion is invisible in a diff full of other changes.
- Where a test is disabled for flakiness, it needs an owner and a reason, and the
  reason should be visible in the output rather than buried in a file. **A skip is
  a claim that someone will come back.**
- **Never report a skipped suite as passing.** A green summary that includes skips
  is a green summary of the tests that ran; count the skips, and say so when
  reporting a result.

## Practical shape

- One command runs everything; flags select a layer or a path.
- The fast layer has no sleeps, no network, no clock reads, and no shared mutable
  state.
- The slow layer is small, explicit about why each test is there, and runs on a
  schedule or before a release.
- The duration and the skip count are printed. What is not measured does not stay
  fast.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
