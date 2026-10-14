---
name: systematic-debugging
description: the user reports a bug, a failing test, a crash, or a symptom whose cause is not yet known
---

Something is broken and nobody knows why yet. Work the four phases in order;
skipping one is how a bug gets "fixed" twice.

## Phase 1 — Reproduce it for real

A report is a claim, not a fact. Before touching code, get a case that fails on
demand and note the exact command or click that produces it.

- Read the **actual** error, all of it. The line the user quotes is usually not
  the line that failed; the first line of the stack is.
- Keep the reproduction minimal. If the failure needs five steps, cut steps
  until it does not reproduce, then add the last one back.
- If you cannot reproduce it, say so and gather evidence — version, input,
  environment, timing — instead of guessing at a fix. An unreproduced fix is a
  guess wearing a commit message.

## Phase 2 — Find the cause, not a cause

Trace the data to the line that produces the wrong value. Reasoning about what
the code "should" do is not tracing.

- Add a print, a breakpoint, or a log at the boundary where the wrong value is
  first visible, then walk backwards to where it is first introduced.
- Bisect. Comment out half, or check out the commit before the regression, and
  let the boundary tell you where the change happened.
- List your assumptions and test the one you are most sure about — that is where
  the bug usually is.
- **When a check says something is broken, check the check.** A failing
  assertion, a lint error, or a red gate is itself code, and its own bug is a
  common answer. Confirm the check fails for the reason you think.
- Distinguish "I have not found it" from "it is not there". Both are real
  results; only one of them justifies stopping.

## Phase 3 — Fix at the root

Fix the cause Phase 2 named. If the fix is a special case, a retry, a guard
clause, or a flag that exists only to route around this input, it is a symptom
patch; find the state that should never have been wrong.

- Search sibling call paths for the same flaw and fix the class, not just the
  reported site.
- Change one thing at a time, so the next result means something.
- Keep the diff to the change the bug needs. Unrelated cleanups hide the fix.

## Phase 4 — Prove it, then leave a guard

- Re-run the original reproduction and show it passes.
- Add a test that fails on the old code and passes on the new one. A guard you
  never saw fail is not yet a guard — watch it go red before you trust it.
- Run the neighbouring suite, not only the one test.
- Write down what the cause was. A cause that ends up only in the diff is one
  somebody re-derives next quarter.

## Where this goes wrong

- Fixing before reproducing, then "verifying" against the fix.
- Trusting the first plausible hypothesis and stopping there.
- Reporting a mitigated symptom as a resolved cause.
- Running the full suite once at the end instead of the failing test first,
  which leaves you unable to tell which change mattered.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
