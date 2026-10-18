---
name: spike
description: a design decision is blocked on an unknown - answer it with a throwaway experiment before committing to the design
---

# A spike answers one question

A spike is not a prototype. A prototype is a first version of the thing you are
building; a spike is an experiment whose output is **an answer**, and whose code
is scaffolding around that answer. Confusing the two is how a repository ends up
with an untested first draft that nobody dares delete.

## Write the question down first

One sentence, answerable, and decision-changing:

> Can the existing table component render 20,000 rows with a virtual scroller at
> 60 fps on the reference laptop, or does the data layer need paging?

- It names a **subject** (the current component), a **threshold** (60 fps at
  20k), and a **branch** (paging or not). "Explore the table" has none of those.
- If both possible answers lead to the same implementation, it is not a spike.
  Do the work.
- If the answer is already in the dependency's source or documentation, it is
  reading, not a spike.

## Set the contract before the box starts

Three lines in the issue, before any code:

1. **Question** (above).
2. **Time box** — hours, not days. Two to four hours is the useful size. If it
   needs more, the question is too big and should be split: "does it render at
   all" is a one-hour question, "does it hold 60 fps under load" is another.
3. **Definition of done** — the number, the error, or the API call that settles
   it, plus who reads the result.

A spike without a box becomes a rewrite with no tests. The box is not a
performance target; it is the point at which you write down what you know and
stop, even if the answer is "still unclear, here is what would settle it".

## Legitimate throwaway code

Throwaway does not mean dishonest. The code may be ugly, single-file, and full of
hard-coded values; it may not fake the thing under test.

- Use the **real dependency at the real version**, the real platform, and the
  real data shape. A spike that mocks the question has answered a different
  question.
- Hard-code everything that is not the question: skip config loading, skip auth,
  paste the fixture inline, cut the UI down to one element.
- Generate the input at the size that matters. Timing a 100-row table and
  multiplying by 200 is arithmetic, not a measurement — the whole point is that
  the cost is usually not linear.
- Write down every deviation from production at the moment you make it ("ran on
  SQLite, not the real server"; "no network hop"). Deviations are the reason the
  answer may not transfer, and they are invisible a week later.

## Measure, or record the exact failure

- Numbers with units and a repeat count: five runs, report the median and the
  spread. A single fast run is a hope.
- Quote the machine and the build mode. A debug build with source maps on is not
  the artifact users run.
- For a qualitative answer, keep the exact call that worked or the exact error
  that proved it cannot: the two-line traceback is the evidence, and it is worth
  more than a paragraph of description.
- Note what broke unexpectedly. The edge cases the experiment stumbled into are
  often the most valuable output — they are the estimate for the real work.

## What survives the spike

One note, in the issue or a short file next to the decision record:

- the question and the box, as written before starting;
- what was tried, in one line each, including the dead ends;
- the number or the error;
- the answer, stated plainly;
- what it implies for the design, and what it does **not** settle;
- the path to the throwaway code, if it still exists anywhere.

Optionally the single load-bearing snippet, pasted into the note. A snippet in a
note is documentation; a module in the tree is a commitment.

## Promote or delete — decide explicitly

**Promote** when the experiment turns out to be the shape of the real thing.
Promotion is a rewrite, not a cleanup: tests first, real error handling, real
naming, the hard-coded fixture replaced by an interface. A spike that is "tidied
up" keeps its shortcuts, because the shortcuts are what made it small.

**Delete** when the answer is recorded and the code is not the answer — which is
the common case. Then delete it properly:

```bash
git worktree remove ../spike-virtual-scroll
git branch -D spike/virtual-scroll
```

The note is the artefact. Keeping the branch "just in case" means the next person
finds two implementations and no way to tell which one is load-bearing.

## Never merge a spike

A merged spike has no tests, no error handling, and interfaces chosen for
convenience. It passes review because it works, and then it is in production and
nobody knows which of its shortcuts are safe. If a spike's code is genuinely the
answer, promote it through a review that treats it as new code — because it is.

## When a spike is the wrong tool

- **The question is about behaviour under load in production.** A laptop
  experiment cannot answer it; you need a measurement in the real environment.
- **The work is really the first slice of the feature.** Build the slice with
  tests. A spike that grows tests has become the feature and should be treated as
  one.
- **It is a choice between two known options.** That is a trade-off note, with
  criteria and weights, not an experiment.
- **The team already knows.** Ask before building; a five-minute conversation
  beats a four-hour box.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
