---
name: incident-postmortem
description: something broke in production and the team needs to learn from it
---

# Writing an incident postmortem

The report is not a defence and not a verdict. Its only product is a change to
the system that makes this class of failure harder next time.

## Blameless is a method, not a tone

"Who pushed the bad change" is a question with an answer that improves nothing.
The useful question is **what made this failure possible and survivable** — the
review path that did not exist, the test that could not see it, the alert that
was too noisy to read, the deploy that made rollback slow.

If the answer reduces to "a person made a mistake", the analysis stopped one
level too early. People in a hurry take shortcuts the system allows.

## Timeline from evidence, not memory

Build the timeline from logs, timestamps, deploy records, and monitor history.
Where you have only someone's recollection, mark it as such.

Separate three different moments, because they have different fixes:

- **When the fault entered** — the change, config, dependency, or data that
  started it.
- **When it began affecting users** — often much later, and the gap is a finding
  in itself.
- **When it was detected, and when it was resolved** — with who noticed and how.

## Triggers, contributing causes, and the detection gap

- **Trigger.** The specific change that set it off. Necessary, not sufficient.
- **Contributing causes.** The conditions that let it reach users: a missing
  guard, a default that hid it, an untested path, an environment that differed.
  This list is where the real work is.
- **Detection gap.** Why nobody knew sooner. "A user reported it" is a finding
  about your monitoring, not a fact about the user.
- **Mitigating factors.** What limited the damage, or what almost did. Systems
  that recover well deserve to be told so, and it is evidence about which
  defences actually work.

Watch for the counterfactual trap: "if only someone had noticed". Name the
mechanism that should have noticed, and say whether it existed and was quiet, or
never existed.

## Actions that are actually actions

Each one gets an owner and a date, or it is a wish.

- Good: "add an assertion that the migration count matches, at startup" — a
  mechanism, checkable, not dependent on vigilance.
- Bad: "be more careful with migrations", "improve communication", "add
  monitoring" without saying what it watches and who responds.
- Acceptable: "accept the risk, because the cost of the guard exceeds the
  exposure" — recorded deliberately, with the reasoning. That is a decision, not
  a gap.

Prefer a small number of owned actions to a long list nobody closes. Carry
overdue ones into the next review rather than letting them disappear.

## The parts people skip

- **What went right.** Which test caught it, which runbook held, which rollback
  worked. These are the parts of the system to keep.
- **The near misses.** Things that almost happened, or happened without being
  noticed. Fixing those is cheaper than waiting for them to be incidents.
- **The exposure window.** How long, and what data or users were affected.
  Someone will need this later, and reconstructing it afterwards costs a day.

## After the report

- Write it even when the incident was small. Practising on the small ones is how
  the process works when a large one arrives.
- Share the draft with the people named in it before it goes out. Surprise is
  what turns a report into a blame exercise.
- Review the actions at the next review, in the open. A postmortem whose actions
  silently vanish teaches everyone that the process is theatre.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
