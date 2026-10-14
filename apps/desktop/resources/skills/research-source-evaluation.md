---
name: research-source-evaluation
description: researching a question, or deciding whether a source can be trusted
---

# Evaluating a source

Every source is a claim with a provenance. Three questions, in this order:

1. **Who is saying it?**
2. **How do they know?**
3. **When did they know it?**

Most bad research is a failure to ask the second one, because a confident
secondary source is indistinguishable from a primary one until you check.

## Primary, secondary, and the chain of citation

- A **primary** source is the thing itself: the specification, the source code,
  the dataset, the filing, the recording, the person who did the work.
- A **secondary** source is somebody's compression of a primary source. Useful for
  orientation, dangerous for detail: what was dropped is exactly the part that
  will contradict your assumption.
- **A claim repeated in ten places is still one claim.** The repetition feels like
  corroboration and is usually a citation chain with a single origin. Count
  **independent** sources, not citations — trace two of them back and see whether
  they lead to the same place.
- Where the claim is load-bearing, go to the primary source. Where it is not, note
  the chain and move on. That judgement is the skill.

## How do they know?

Classify the basis of the claim, because it changes what the claim is worth:

| Basis | What it means |
|---|---|
| **Measured** | Somebody ran something and reported the result. Ask what they measured and under what conditions. |
| **Estimated** | A model, an extrapolation, a guess with arithmetic. Often useful, never a fact. |
| **Asserted** | Stated without a basis. This is where most of the internet lives. |
| **Inferred** | Reasoned from something else. The reasoning is checkable, which is good news. |

A single number is usually an estimate presented as a measurement. That is often
not dishonesty — it is a summary — but treating it as measured is how errors enter
your work with a citation attached.

## Independence, and what interest does to a claim

- Ask **who benefits** from the claim being believed. A conflicted source can
  still be right; it just is not independent, and it needs a second source.
- **Motivation is not disqualifying — it is information.** A vendor's benchmark may
  be accurate and favourable; knowing who ran it tells you what to check.
- The most reliable sources are the ones with the least to gain and the most to
  lose from being wrong.

## Dates and versions

- **A fact has a shelf life.** A statement about a library, a law, a price, or a
  protocol is a statement about a version at a time, and it is often presented
  without either.
- Prefer the **most recent** source only where the subject changes often, and
  prefer the **specific version** you care about over "latest". Where a document is
  versioned, read the version that matches what you are working with.
- Check for **retractions, corrections, and supersession**. A corrected paper still
  circulates in its original form, and the correction is usually harder to find
  than the claim.

## Read the source, not the summary of the source

- The most common research failure is quoting a quote. The original sentence often
  says something narrower, different, or the opposite of the summary — and the
  summary is what gets cited onward.
- For a technical claim, the primary source is usually the **specification, the
  code, the changelog, or the commit message**, not the blog post about it. Those
  are cheap to read and they settle the question.
- Where the source is a conversation or an anecdote, treat it as a hypothesis
  rather than evidence, and say so when you pass it on.

## Search bias, and the missing evidence

- **"I could not find it" is not "it does not exist."** Your search terms carry your
  assumptions: a claim worded differently, or made in a place you did not look, is
  invisible to you and still true.
- Search **for the disconfirming claim** specifically, not only for support. Ask a
  question in the form that would find the counter-case.
- Absence of evidence is worth recording as such, with what you searched. That is a
  finding; "there is nothing on this" is usually not.

## Bias on your own side

- **The claim that surprises you deserves the most checking, and so does the claim
  that delights you.** Agreement is not evidence, and the most expensive errors are
  the ones that arrived already matching what you wanted.
- Where you want a particular answer, say so to yourself before you search. It is
  the only reliable way to notice when you stop looking.
- Ask what would **falsify** the claim. If nothing could, you are not holding a
  claim; you are holding a belief with a citation.

## Reproduce it when it is cheap

- Where the claim is checkable in an hour — run the benchmark, read the code, test
  the behaviour — **that is the strongest evaluation available**, and it beats any
  amount of source assessment.
- Where it is not cheap, note what would be needed to check it. That note is often
  the most useful thing you produce.

## Writing it down

- **Record what you found and where**, specifically enough that the next reader can
  re-find it. **A citation you cannot re-find is a rumour with a title.**
- Distinguish in your own writing between what you verified, what you read, and
  what you inferred. A reader can then apply the right discount.
- Where two good sources disagree, **present the disagreement** rather than picking
  one. The disagreement is usually the real finding.
- Timebox the search. Evaluation runs forever if you let it, and the last ten
  percent of confidence costs more than it returns.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
