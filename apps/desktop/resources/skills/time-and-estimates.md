---
name: time-and-estimates
description: estimating how long work will take, or reporting that it is taking longer
---

# Estimating, and being wrong honestly

An estimate is not a promise and not a guess. It is a **range plus the
assumptions it rests on**, and it is only useful if all three parts travel
together.

## Never give a single number

A bare number transfers all of the uncertainty to the reader, who will hear it as
a commitment, remember it as one, and plan around it. When the work takes longer,
you will look unreliable for something you never said.

- Give a range, and say what it covers: "three to five days, if the API works the
  way the docs say."
- Name the assumption you are **least** sure of, because that is where the
  estimate will fail. An estimate that hides its weak point cannot be improved by
  the person who knows better.
- Where the range is wide, say why: "one day if the format is what we think, two
  weeks if we have to write a parser."

## Use a reference class

The most reliable predictor of how long something will take is **how long the
last similar thing took**.

- Look it up. Most projects have the record: the previous migration, the last
  integration, the last time you touched this subsystem.
- Your intuition is calibrated for the work and not for the interruptions. The
  reference class includes them, which is why it is better.
- If there is genuinely nothing similar, say so, and give a much wider range with
  an explicit plan to narrow it: "I can spend half a day and give you a better
  number."

## The parts do not add up to the whole

- Breaking work down improves an estimate, but **the sum of the parts
  underestimates** it, because the parts never fit together on the first attempt.
- Add the integration time explicitly: wiring, testing the seams, the mismatch
  between two components written by different people. This is where the surprise
  lives.
- The "90% done" feeling lasts as long as the remaining 10% takes. On a task with
  a genuinely unknown tail, that phase can be as long as everything before it.

## Separate estimating from committing

They are different acts and should use different words.

- **Estimate**: what I think it will take, with a range and assumptions. A
  question about reality.
- **Commit**: what I will deliver, by when. It contains a decision about scope and
  a buffer for what I do not know, and it is not the same number as the estimate.
- When someone takes your estimate and turns it into a commitment in front of you,
  say what changed. Silence in that moment is how an honest range becomes a fixed
  date you never agreed to.

## Do not estimate to please

The optimistic number you give to end an uncomfortable conversation becomes the
plan, and then it becomes the deadline, and then it becomes the reason the work
was rushed.

- A short honest range that disappoints now costs one uncomfortable minute. A long
  dishonest one costs the project.
- Long work is usually not slow work. If it needs to be sooner, the answer is
  **less scope**, not a smaller number.
- Where the deadline is genuinely fixed and must be met, decide what gets cut
  **now**, in the open, rather than discovering it at the end by quietly dropping
  quality.

## When it is going long

- **Say it as soon as you know**, not when the date arrives. The cost of lateness
  is mostly the lateness of the news; the schedule can absorb a delay that is
  announced, and cannot absorb one that is discovered.
- Bring a new range and the reason, not an apology. The useful information is what
  changed and what it implies.
- Distinguish the causes: something was unknown, something was bigger than it
  looked, or something else took the time. They need different fixes — the first
  is an estimating problem, the second a design problem, the third a priority
  problem.
- Do not silently absorb a delay by working longer hours. It buys a week and
  costs a month, and it hides the problem from the person who could act on it.

## Improving

- **Keep a record**: what you estimated, what it took, what the surprise was. Only
  your own numbers will calibrate you; general advice will not.
- Notice your own bias and correct it as a constant: many people consistently
  underestimate by a factor of about two on unfamiliar work, and the correction is
  in the record rather than in the feeling.
- Separate the task types when you look back — a migration, a UI change, and a
  debugging session have different error patterns, and averaging them hides both.
- When someone else's estimate is wrong, do not silently replace it. Ask what it
  rests on; the assumption is usually the thing that moved.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
