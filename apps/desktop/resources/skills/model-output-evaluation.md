---
name: model-output-evaluation
description: testing or evaluating behaviour that a model produces
---

# Evaluating model output

A model's output is a **distribution**, not a value. This is the fact that breaks
most test suites written for it, because everything learned about deterministic
code assumes the opposite.

## One run proves nothing

- A passage that is correct once may fail on the next call with identical input.
  Sampling, load balancing, and a provider-side version change all move the output
  without your code changing.
- **Lowering the temperature reduces variance; it does not remove it.** Treat
  every run as a sample. Where prompt caching or a pinned version makes a run
  reproducible today, that is a coincidence you can lose without notice.
- A test that passes locally across a handful of runs is evidence of nothing.
  Either evaluate on a set of cases, or assert something that cannot vary.

## Assert properties, not strings

Exact-match on generated prose is a test that fails for the right answer.

- Assert **invariants the output must have**: it parses as JSON, it matches the
  tool-call schema, it contains the required field, it does not contain a
  forbidden phrase, it references only identifiers that exist, it is under a
  length bound.
- **Property assertions are stable across model upgrades**, which is what makes
  them worth writing. A golden file is stable only until the next version.
- Where a golden file is genuinely useful — a pinned model, a stable prompt — it
  still has to record the model and its version beside it, and be expected to be
  re-baselined rather than trusted forever. Measure **the rate of change**, not the
  change itself.

## The failure that matters most

**The confident, fluent, wrong answer.** It passes every check that looks at
shape, length, or completion, and it is the reason a suite that only asserts
"something came back" is worse than no suite.

- Assert on **content and structure**, not on the fact that generation finished.
- Where the output is used as a value — a number, a decision, an action — validate
  it as you would any untrusted input, because that is what it is.
- Where the output is displayed rather than executed, check the properties that
  make it safe to display: no unescaped content, no unresolved placeholders, no
  reference to something that does not exist.

## Build the set from failures, not from imagination

- A set of cases chosen by the prompt's author measures the author's imagination,
  not the model's behaviour. Cases should come from **real failures**: an incident,
  a user report, a case that looked right and was not.
- **Every production failure becomes a case**, kept permanently. This is the only
  evaluation set that gets better over time, and it is the difference between
  testing and guessing.
- Hold out cases the prompt was designed against, or the measurement is of how
  well the prompt was fitted, not how well it will work.
- Ten cases that each encode a real decision beat a hundred invented ones.

## Grading, when a property check is not enough

- **A model used as a grader is non-deterministic**, so a suite built on one is
  non-deterministic too. Use a model grader for triage and sampling, not as the
  only gate, or the gate itself becomes flaky and gets disabled.
- **Calibrate the grader against human labels** on a sample, and state the
  agreement rate. An uncalibrated grader measures the grader.
- Write the rubric so **someone else could apply it** — the criteria as statements
  that can be marked true or false, not adjectives. "Is it helpful" is not a
  criterion; "states the unit of the number it returns" is.
- Where humans grade, grade blind to which variant produced the output, or the
  preference for the one you wrote will show up in the numbers.

## Cost and latency are outputs too

- A prompt change that makes the output better and the call three times more
  expensive is a trade, not an improvement. Measure both, and record them beside
  the quality result.
- Where a suite calls a real provider, **it costs money per run**. Split the
  cheap invariants, which run on every change, from the expensive evaluations,
  which run on a schedule or before a release — and label which is which.
- Record **model, version, parameters, and prompt hash** with every result. Without
  them, a stored result is an anecdote, and a comparison between two runs may be a
  comparison between two different systems.

## Prompts are code

- **A prompt change is a behaviour change** and gets the same treatment: review,
  evaluation, and a note of what moved. A prompt diff is a diff.
- Keep prompts in the repository in a reviewable form, not as strings assembled
  from fragments so that no single view shows what is actually sent.
- Version them, and keep the previous version long enough to attribute a
  regression to the change that caused it.

## What a useful suite looks like

- **Fast, deterministic, always-run layer**: schema validity, required fields,
  forbidden content, length bounds, no unresolved placeholders, the tool calls
  well-formed. These catch most real breakage and cost almost nothing.
- **Slower, sampled layer**: quality on a curated set, run against a pinned model
  on a schedule, with results recorded and compared to the last run.
- **Incident layer**: every real failure, permanently, growing forever.
- **A human layer**: occasional blind review, because the automatically checkable
  properties are never the whole of what matters.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
