---
name: motion-decisions
description: Use when deciding whether a part of the interface should animate at all, and how fast or which curve if it should.
---

# Deciding whether and how something moves

Motion is not decoration layered on top of an interface. It is the answer to
"what just happened, and where did it come from" — and when it answers nothing,
it is a delay the user pays every single time.

## First question: how often will this be seen?

Frequency decides before elegance does.

| How often the user triggers it | What to do |
| --- | --- |
| Hundreds of times a day — command palette, tab switch, a keyboard shortcut | No animation. A transition here reads as input lag. |
| Tens of times a day — hover, list navigation, row selection | Only the shortest feedback, or nothing |
| Occasionally — dialogs, drawers, toasts, sheets | A normal transition, 150–250 ms |
| Rarely or once — onboarding, a success state, an empty state | Room for something with a little character |

**A keyboard-initiated action is the strictest case.** The hand is already faster
than the eye; an entrance animation on a palette that opens fifty times a day
converts a tool into a thing that hesitates. The same palette opened by a mouse
click can afford 120 ms.

## Second question: what is it telling the user?

If the answer is "nothing", delete it. The purposes that justify motion:

- **Where it came from.** A popover scales up from the control that opened it, so
  the eye does not have to search. A modal stays centred, because it did not come
  from anywhere in particular.
- **What is happening now.** A progress state that moves says "working" without a
  spinner that says "waiting".
- **What changed.** A row that slides out tells the user which row left; one that
  vanishes leaves them recounting.
- **That the press landed.** A control that scales down a few percent while held
  answers "I felt that" within the same frame.

Purposes that do not justify it: making a screen feel "alive", covering a slow
load, or matching a reference that had no reason either.

## Entrance and exit parameters

- **Nothing appears from nothing.** A dialog that scales from 0 to 1 looks like it
  was inflated; 0.96 to 1 with opacity 0 to 1 looks like it arrived. The same
  applies to a popover, a toast, a dropdown.
- **Origin follows the trigger.** Set `transform-origin` from the element that
  opened the surface. A popover growing from its own centre, anchored to a button
  in the corner, is the most common tell of hand-waved motion. A modal is the
  exception: it stays centred because it interrupts rather than extends.
- **Exits are faster than entrances.** The user has already decided; do not make
  them watch. Roughly two thirds of the entrance duration.
- **Enter from a direction that means something.** A toast slides in from the edge
  it can be swiped back to, so dismissing it feels like reversing the gesture
  rather than a separate action.

## Curves and durations

- **`ease-out` for things arriving**, because the movement is fastest at the
  start, which reads as immediate feedback. `ease-in` on an entrance reads as
  sluggish: the thing is visible but barely moving.
- **`ease-in` for things leaving**, for the mirror-image reason.
- **Never linear** except for continuous progress (a determinate bar, a spinner),
  where a constant speed is the honest signal.
- **A spring for direct manipulation.** Drag, swipe, and dismissals should carry
  the momentum the hand gave them; a fixed curve feels like the surface is
  ignoring the gesture.
- **Durations by distance, not by taste.** Something travelling a short distance
  wants 120–180 ms; a full-screen sheet, 250–320 ms. Anything past ~400 ms is
  perceived as the interface thinking.

## What never animates

- Layout that the user is reading: text reflow, table columns resizing while a
  filter applies, a form growing under the cursor.
- Anything triggered by typing.
- A surface that must appear instantly to be useful: a tooltip on a focused
  control, a validation message as the user submits.
- Two things at once with no relationship. If two surfaces move, either they move
  together on purpose, or one of them should be still.

## Origin

QianNing Agent. Written in this repository; the craft guidance is restated in our
own words from general interface-design practice, with no third-party text,
examples, or vocabulary reproduced.
