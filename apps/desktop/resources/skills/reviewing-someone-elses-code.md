---
name: reviewing-someone-elses-code
description: reviewing a pull request, patch, or contribution from another person
---

# Reviewing someone else's code

The job is not to find fault. It is to decide whether this change should land,
and to say why in a way that leaves the author able to act.

## Read the description before the diff

Then read the diff **against** the description and ask whether they match.

- Does the diff do what the description says, and only that? Unrelated
  reformatting, renames, and dependency bumps hide the real change and make the
  review unreliable.
- Does the author explain **why**, or only what? A description that restates the
  diff leaves the reasoning to be reverse-engineered, and that is where a
  misunderstanding is hiding.

## Three questions, in this order

1. **Is the reported problem real?** Reproduce it, or check it against current
   behavior. An intake request or a claim is not proof that the problem exists.
2. **Does the change remove that failure at the root?** Not a nearby symptom, not
   a docs-only restatement, not a partial workaround that leaves the original
   path in place. A sound direction is not a landed fix.
3. **Is it the smallest coherent change?** Extra files, extra refactors, and
   spec-shaped theatre do not compensate for an incomplete fix. They make it
   harder to review and harder to revert.

If (2) or (3) fails, the answer is not "approve now, follow up later". Say so,
with the evidence.

## Verify, do not take the summary's word

The author's summary is a self-report, not a finding. Where the change makes a
claim — "this now handles X", "tests pass", "no behavior change" — check the
claim against the code or the run.

- Read the tests: do they assert the new behavior, and would they have failed
  before the change?
- If a claim cannot be checked from the diff, ask for the evidence rather than
  assuming it.
- A green CI run proves only the checks that ran. If the relevant suite did not
  run, say that the evidence is missing rather than treating green as coverage.

## Comment on the code, never on the person

- "This breaks when the list is empty" is a review. "You clearly didn't think
  about the empty case" is an insult with the same information and a worse
  outcome.
- Assume competence and a reason. If something looks wrong, ask what it is doing
  before asserting that it is broken; the reason is often real and not in the
  diff.
- Never rewrite the author's work and present it as the review, unless they asked
  you to take it over. A review that arrives as a replacement patch teaches
  nothing and discards the context the author had.

## Rank your comments, and say which is which

A review where a naming nit and a data-loss bug look equally important is a
review that will be acted on in the wrong order.

- **Blocking** — must be fixed before this lands: correctness, data safety,
  security, a broken contract, a failing test.
- **Should** — a real problem that can be a follow-up if the author disagrees,
  but say why you think it matters.
- **Suggestion** — a better shape, an alternative, your preference. Not a
  demand.
- **Nit** — style, wording, a typo. Say it is a nit, and do not block on it.

Say explicitly which comments you consider blocking. The author cannot read your
mind about priorities, and they will guess wrong.

## Ask, don't tell

- A question invites the author to explain their reasoning and sometimes changes
  your view. A demand invites compliance without understanding.
- Ask for the smallest thing: "could this be split?" rather than "rewrite this
  as three commits".
- If you know the answer, still ask where the context is missing — the answer
  belongs in the code, next to the thing it explains, not in the review thread.

## Praise specifically

"Looks good" teaches nothing. "This is exactly the right place for that guard,
because the failure would otherwise surface two layers up" tells the author what
to keep doing. Specific praise is how a codebase's good habits spread, and it
costs one sentence.

## Approve when it is good enough to land

Not when it is perfect. The trap at the other end of review is blocking a
correct, working change on taste.

- If your comments are all suggestions and nits, approve and say so; the author
  can take them or leave them.
- Blocking is for a stated reason, and the reason should be one anyone could
  check: a build failure, a test failure, a conflict, a security violation, a
  contract break, a regression, or the fix not reaching the root cause.
- Do not require the author to solve problems outside the scope of their change,
  and do not expand a review into a broader redesign of code they did not touch.

## Before you request review yourself

Read your own diff first — scope, then content — and be able to say what you
ran. A reviewer's first five minutes spent on the things you could have caught is
five minutes not spent on the part that needs a second mind.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
