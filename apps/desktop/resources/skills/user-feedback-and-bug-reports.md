---
name: user-feedback-and-bug-reports
description: handling a bug report, a feature request, or user feedback
---

# Handling a report

A report is a **claim**, not a fact. Your job is to turn it into a finding, and
the fastest way to lose the reporter's trust is to argue about the claim before
you have established anything.

## Reproduce it, or say what is missing

- **A bug you cannot reproduce is a bug you cannot fix.** Reproduce it first, in
  the environment where it was reported, using their steps. "It works on my
  machine" is not a finding — it is a difference, and differences are the clue.
- Ask for the version and the environment **early**. Half of reports resolve there;
  the other half resolve faster once you know it.
- If you cannot reproduce it, say exactly what you tried and what you saw. That is
  still progress, and it is the only honest thing to say.
- A fix without a reproduction is a guess that happens to compile.

## Read it literally before you interpret

- Follow the reporter's steps in their order, doing exactly what they say, not what
  you assume they meant. The step that looks obviously wrong is usually where the
  finding is.
- Use their words for the thing. If they call it by a name you do not recognise,
  that name is real to them and probably to the interface.
- Their description of **what they expected** is the most valuable part of the
  report and the part most often ignored. A mismatch between expectation and
  behavior is either a bug or a design failure, and both are worth knowing.

## Classify before acting

| Verdict | What to do |
|---|---|
| **Confirmed defect** | Reproduce, add a regression test that fails on the old code, fix, verify. |
| **Already fixed** | Say which release has it, and say how you checked. |
| **Working as designed** | Explain the design, and say whether the report suggests the design is wrong. Sometimes it does. |
| **Environment-specific** | Say which environment and why, and whether it can be handled. |
| **Not enough evidence** | Say exactly what is missing, and what would resolve it. |
| **Preference, not a defect** | Say so honestly — and do not dismiss it. It is still information about what the interface communicates. |

Do not implement first and investigate afterwards. The first question is always
whether the problem is real.

## What to ask, and what not to

- Ask for the one thing that separates the plausible causes. Not a list of eight.
- **Do not ask for what a five-minute experiment would tell you.** Every request
  for information costs the reporter, and the cost compounds until they stop
  reporting. Do the experiment.
- Ask once, precisely, and say why: "does it happen on a fresh profile? That
  separates a data problem from a code problem."
- Never ask them to read logs for you unless there is no other way; if you must,
  say exactly which lines matter.

## Volume is not importance

- The loudest report is not the most severe. **One report of data loss outranks
  fifty about a cosmetic issue**, and treating them by count is how a project
  loses its users' data politely.
- Conversely, a small issue reported many times is telling you something about the
  interface even if each instance is trivial.
- Duplicates are data. Many reports of the same confusion mean the interface
  should explain something it does not, and the fix is not "answer more
  questions".

## Closing the loop

- Say when it is fixed, in which release, and what the cause was in one sentence.
- Say when you decided not to fix it, and why. Silence here is worse than a no,
  and it teaches people to report elsewhere.
- Where a workaround exists, give it — and note that the workaround people invent
  is a design finding. How they got around the problem tells you what to build.
- Where you cannot act: say what would change the decision. A report closed with
  silence does not close.

## Do not defend

- The reporter's experience is real even when their diagnosis is wrong. Arguing
  about the diagnosis while ignoring the experience is what makes support feel
  adversarial.
- "That is expected behaviour" is an answer only when you have established that
  the expectation should have been set by the interface, and can say where.
- If the report is wrong, be brief and be specific. Two sentences, not two
  paragraphs.

## The signal under the noise

- Repeated questions about the same thing are a documentation or interface defect,
  not a support volume problem.
- A report that includes a workaround is often a specification, written by someone
  who needed the thing enough to build it themselves.
- Where users consistently misunderstand a feature, the feature is misnamed or
  misplaced, and the report is the evidence.
- When the same class of bug arrives twice, the useful output is not the second
  fix — it is the guard, the test, or the check that makes the third one
  impossible.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
