---
name: reviewing-motion
description: Use when reviewing a pull request or a screen for how it moves: entrance, exit, feedback, and whether each animation earns its place.
---

# Reviewing motion

A review of motion is not "does it look nice". It is a list of claims a reader can
check: this animates, that does not, this is too slow, this runs on the wrong
property. That shape makes the review actionable by someone who was not in the
conversation.

## Output format

One table, one row per finding. Never interleaved "before:" / "after:" prose —
the table is what makes the review scannable and the fixes copy-pasteable.

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 180ms ease-out` | Name the property; `all` animates whatever changes next |
| `transform: scale(0)` | `transform: scale(0.96); opacity: 0` | Nothing appears from nothing |
| `ease-in` on a menu entrance | `ease-out`, 160 ms | The start must feel instant |
| No pressed state on a button | `transform: scale(0.97)` while held | A press must land in the same frame |
| Popover scaling from its own centre | origin set from the trigger | The surface should look like it came from the control |

Order the rows by how much the user feels them: an entrance that feels slow
outranks a 20 ms difference nobody can perceive.

## What to look for, cheapest first

1. **Should this animate at all?** The frequency test: an action used dozens of
   times a day should be instant, a keyboard-triggered one always is.
2. **Is the purpose nameable?** If the author cannot say "it shows where this came
   from" in one clause, the animation is decoration standing in the way.
3. **Entrance, exit, and interruption.** Both directions exist; the exit is faster;
   interrupting mid-flight does not jump (the animation starts from where the
   element currently is, not from its declared start).
4. **Origin and geometry.** Popovers and menus grow from their trigger; dialogs
   stay centred; a toast enters from the edge it can be dismissed toward.
5. **Feedback on direct manipulation.** Press, drag, and swipe answer within a
   frame; a drag carries momentum instead of snapping to a fixed curve.
6. **Reduced motion.** The preference turns movement into an instant state change
   — and keeps the layout identical, so nothing jumps.
7. **Cost.** `transform` and `opacity` only, no `transition: all`, no per-frame
   React state.

## Turning findings into work

- Group rows that one change fixes; a shared easing token or a shared surface
  transition is one decision, not fourteen.
- Separate "must fix" (wrong property, missing exit, keyboard-triggered motion)
  from "worth trying" (a slightly shorter duration, a little more overshoot).
- If a finding needs a judgement the reviewer cannot make alone — a brand feel, a
  product-level decision — say so in the row instead of silently choosing.
- When the same correction comes up a second time, it belongs in the project's
  design notes as a rule with its reason, not in another review comment.

## When there is nothing to review

Say so plainly, and say what was checked. "No motion on the changed surface" is a
useful review result; inventing a suggestion to look thorough is not.

## Origin

QianNing Agent. Written in this repository; the craft guidance is restated in our
own words from general interface-design practice, with no third-party text,
examples, or vocabulary reproduced.
