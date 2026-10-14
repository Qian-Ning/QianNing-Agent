---
name: red-green-refactor
description: the user is writing a feature or a bug fix that should be covered by a test
---

# Red, green, refactor

Working test-first is not about coverage numbers. It is about knowing that the
test you just wrote can fail, which is the only thing that makes its passing
mean anything.

## Red: write the test, and watch it fail

Write the test before the code, then **run it and read the failure**.

- It must fail for the reason you expect. A test that fails because the module
  does not exist yet tells you nothing about the assertion; get it to fail on
  the assertion.
- If it passes the first time you run it, you have not written a failing test —
  you have written a test of something that already works. That is fine as
  documentation; it is not a red step.
- A **new** guard is not trusted until it has been seen red. Break the thing it
  guards deliberately, watch the named case fail, restore, re-run.

Assert on observable behavior and stable contracts. A test that locks a private
helper's call count, a DOM shape, or a large snapshot will fail on the next
honest refactor, and the failure will cost more than the bug it prevented.

## Green: the smallest change that passes

Make the test pass, and stop. Not the general solution, not the sibling cases,
not the cleanup — the smallest change that turns that one test green.

- Run the test. Then run the neighbors. A fix that breaks a neighbor is not a
  fix, and you can only tell while the change is small.
- Resist adding the next test's code now. Red-green cycles that get merged into
  one big step lose the only real benefit, which is knowing which change did it.

## Refactor: only with the tests green

Now improve the shape — extract, rename, deduplicate — with the suite passing.

- Structural change and behavior change in separate steps. If you cannot tell
  which step broke it, you merged two.
- Delete the scaffolding: the temporary flag, the second implementation, the
  adapter you added to get green.

## The traps that produce false confidence

- **A test that cannot fail.** An assertion inside a callback that is never
  called, an `assert` in a branch the code never reaches, an `await` inside a
  non-`async` function so the assertion never runs. Grep your own test for the
  assertion, and make sure the failing run showed it executing.
- **A truthy collection check over an empty collection.** `all(...)` over an
  empty list is true. Assert the count as well, or the test passes when the data
  is missing entirely.
- **A summary line mistaken for evidence.** A runner's "N passed" is the
  runner's claim about what it ran. Where you need to prove your cases ran, use
  the verbose reporter and read the names.
- **A green suite that skipped your test.** A skipped test is not a passing
  test; check the skip count moved with the test count.
- **A guard whose own check broke.** When a check says something is broken,
  check the check first — a wrong path, a stale build artifact, a pinned source
  line all look like product failures.

## When the test is hard to write

That is information, not an obstacle. A function that needs a filesystem, a
clock, or a global to be tested is usually two responsibilities sharing a name.
Extract the pure part and test that, then test the thin shell that wires it up.
Difficulty is the signal to change the design, not the signal to skip the test.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
