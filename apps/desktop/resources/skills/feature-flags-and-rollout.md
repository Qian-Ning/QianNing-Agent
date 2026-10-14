---
name: feature-flags-and-rollout
description: adding a feature flag, a kill switch, or a staged rollout
---

# Feature flags and rolling out

A flag is a branch that ships to production, and every one of them doubles the
number of states your system can be in. They are worth it — deployed is not
released, and a kill switch is cheaper than a rollback — but only if you treat
them as the temporary, costly things they are.

## Classify the flag before writing it

The four kinds have different lifetimes, and conflating them is why flag debt
piles up:

- **Release flag** — hide work in progress so deploying does not mean releasing.
  Lifetime: days. Removed when the feature is on for everyone.
- **Kill switch** — turn a dependency or a subsystem off during an incident.
  Lifetime: permanent, as long as the thing exists. It must be tested.
- **Experiment flag** — split traffic to compare outcomes. Lifetime: until the
  experiment is decided, and then it must be deleted along with the losing side.
- **Permission flag** — entitlement for a user or a plan. This is not really a
  flag; it belongs in the data model, where it can be queried, audited, and
  reported on.

Write the kind, the owner, and the intended removal date next to the definition.
A flag with no name on it never gets removed.

## The default must be the safe answer

The moment that matters is when the flag system is unavailable, the value is
missing, or the evaluation throws.

- **Fail to the old behavior, not the new one.** A flag whose absence enables the
  unproven path turns a dependency outage into an incident on your new code at
  the worst possible time.
- Evaluation must be cheap, must not throw, and must never sit where a failure is
  fatal. A network call inside a flag check is a new failure mode on every
  request path.
- Decide the default deliberately for each flag and write it down: default off,
  or default on for a kill switch (the switch should be "enabled = normal").

## Both states must be tested, or neither is real

- A state that is never exercised in a test is a state nobody has seen. Add tests
  for both, and for the transition if the flag can change at runtime.
- Keep the flag **out of** the tests where possible: inject the decision, so the
  feature can be tested directly rather than through a grid of combinations.
- Flag combinations multiply. Two nested flags are four paths; three are eight.
  Do not nest them; if you have to, say which combinations are impossible and
  make that true in code.
- The permanent risk is the flag left on in production and off in tests, or the
  reverse. Make the flag's existence visible somewhere a person looks — a
  dashboard, a startup log line, a report — rather than trusting a list.

## Rollout: decide the abort criterion first

- A rollout plan is a **sequence of populations with a number attached**:
  1%, 10%, 50%, 100%, with a defined pause between each.
- The abort criterion must be a **number someone can look up**, not "keep an eye
  on it": error rate above X for N minutes, latency p99 above Y, a support volume
  signal. Without it, the person watching is guessing, and will guess "fine"
  because the alternative is a difficult conversation.
- Watch the **right** metric. A rollout that looks healthy because errors happen
  on a path nobody reached is a rollout that is not being measured.
- Sticky bucketing: a user must not flip between the old and new behavior
  mid-session. Use a stable key — the user's identity — and decide deliberately
  whether anonymous users are included.

## The kill switch must actually work

- Test it. Flip it in an environment, watch the subsystem go off, watch it come
  back. An untested kill switch is a comfort, not a control.
- Make sure it kills enough. A switch that disables the new path but leaves the
  old path broken is not a rollback.
- Know its scope: per user, per tenant, globally? The incident is rarely uniform,
  and the answer changes which one you need.
- Document how to flip it **in the runbook**, with the exact procedure, so it can
  be found at midnight by someone who did not write it.

## Removal is part of the change, not a follow-up

- Schedule the removal when you add the flag: an issue, a date, a line in the
  plan — something with a person attached.
- When removing, remove everything: the flag definition, both branches, the dead
  code path, and the tests that only existed to cover the combination. Leaving
  the losing branch behind is how a codebase accumulates code nobody can explain.
- A flag that has been at 100% for a month is a flag that should not exist. It is
  now a constant with extra steps, and nobody remembers which branch was real.

## Where the flag lives

- Prefer a configuration-driven flag for release and kill switches over one that
  requires a deploy. The point of a kill switch is that it does not need one.
- Cache the evaluation where the read is hot, and define the staleness you
  accept. A flag change that takes effect in five minutes is fine; one that never
  takes effect is a bug.
- Do not put flags in code paths where they cannot be observed: if a flag changes
  nothing visible, you cannot tell whether it worked, and you cannot roll back
  what you cannot see.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
