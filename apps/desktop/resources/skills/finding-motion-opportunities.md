---
name: finding-motion-opportunities
description: Use when asked what could be animated in an interface, or to make a screen feel more alive. Reports candidates; changes no code.
---

# Finding places that deserve motion

A sweep for motion is mostly a filter. Most candidates fail, and the ones that
survive are worth more than a long list, because the failure mode of this exercise
— adding movement everywhere someone noticed a still frame — produces exactly the
sluggish interfaces the rest of this set exists to prevent.

**Read only.** This produces a report. It never edits the interface, and it never
hands back a half-applied change.

## Cap the output

Five to seven suggestions for a whole application; fewer for a single screen.
Ordered by how much the user feels them, not by how interesting they are to build.
An empty list is a legitimate result and should be stated as one.

## The gate, in order

Every candidate answers all four. If any answer is bad, drop it — do not carry it
into the report as a "maybe".

**1. Frequency.** How often does one user hit this?

| Frequency | Verdict |
| --- | --- |
| Dozens to hundreds of times a day — command palette, tab switch, keyboard shortcut | Reject. Motion here converts a tool into something that hesitates. |
| Several times a day — hover, list navigation, quick toggles | Reject, or at most a barely perceptible tick |
| Now and then — dialogs, drawers, toasts, settings | Eligible, standard durations |
| Rare or first-time — onboarding, empty state, success, celebration | Eligible; this is the only place delight is affordable |

**2. Purpose.** Name one, in one clause: feedback that the input landed; spatial
consistency that shows where a surface came from; a state change made legible; a
bridge over content that would otherwise teleport; an explanation of how something
works. "It would look nice" is not on the list.

**3. Budget.** Can it finish inside the standard durations? Press feedback
100–160 ms, small popovers 125–200 ms, menus 150–250 ms, dialogs and sheets
200–400 ms. A suggestion that needs longer is usually a suggestion that should not
exist.

**4. Cost.** Can it run on `transform` and `opacity` alone, without animating
layout, without a per-frame render, and without moving while the main thread is
busy? If not, the cost is part of the suggestion, not a footnote.

## What the report contains

For each surviving candidate, one block:

- **Where** — the component and the state change, named precisely enough to find.
- **Why it qualifies** — the frequency tier and the named purpose.
- **The recipe** — property, from-value, to-value, easing, duration, and origin
  where geometry matters. Exact values, not "a subtle transition".
- **What it must not touch** — the sibling element that should stay still, the
  layout that must not reflow.

## Candidates that almost always fail

- Anything triggered by typing.
- A list that fades items in on scroll: the content is being read, not performed.
- A page transition between primary navigation destinations; the destination
  should just be there.
- Loading shimmer on content that arrives in under a second.
- A hover animation on a control that is used continuously (a slider handle, a
  text cursor).
- Anything whose removal would make the interface faster and no less clear.

## Handing off

The report is the deliverable. If the user then wants one of them built, that is a
separate change with its own review — and the recipe in the report is what the
change is held to.

## Origin

QianNing Agent. Written in this repository; the craft guidance is restated in our
own words from general interface-design practice, with no third-party text,
examples, or vocabulary reproduced.
