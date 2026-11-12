---
name: motion-performance
description: Use when an animation stutters, drops frames, or feels heavy, and when choosing which property to animate.
---

# Motion that lands every frame

An animation that drops frames does not read as "slightly slow". It reads as
broken, and no amount of correct easing rescues it. Frame budget is not a polish
pass after the motion is right — it is what lets the motion register at all.

The budget: **16.7 ms per frame at 60 Hz, 8 ms at 120 Hz.** A mid-range phone is
the bar, not the developer's laptop; on a fast machine almost every problem below
is invisible.

## Start from the symptom

| What the user sees | What it usually is |
| --- | --- |
| Stutter while a panel opens | `width`, `height`, `top`, `margin` or `left` being animated |
| Choppy shadow | An animated `box-shadow` instead of `filter: drop-shadow()` |
| Smooth alone, janky during load or navigation | The animation runs on the main thread while that thread is busy |
| A drag that gets worse as the list grows | An inherited custom property being animated; every child recomputes |
| Blur that lags, especially on Safari | Animated `filter: blur()` above roughly 20 px |
| Properties nobody meant to animate | `transition: all` |
| A 1 px shift as motion starts or ends | Missing compositor hint — but check it last, not first |

## The rules, in order of what actually fixes things

1. **`transform` and `opacity` by default.** They are composited: the layer moves
   without the browser re-laying out or repainting. Anything else needs a reason,
   and "it seemed fine" is not one.
2. **Never `transition: all`.** List the exact properties. `all` animates whatever
   changes next, including a layout property that was never meant to move, and it
   is the single most common cause of a stutter nobody can place.
3. **Name the cause before changing code.** "Added `will-change`, seems smoother"
   is not a diagnosis. Say which row of the table above the fix addresses.
4. **`will-change` is the last step.** It promotes a layer and costs memory; used
   everywhere it makes things slower, not faster. Add it to a surface that is
   about to animate, and remove it when the animation ends.
5. **Do not conclude "it's fine" from a fast machine.** Say which findings came
   from reading the code and which need a recording on a real device.

## Cheaper swaps that keep the same visual

- Animate `transform: scale()` instead of `width`/`height`.
- Animate `translate` instead of `top`/`left`/`margin`.
- Use `filter: drop-shadow()` for a shadow that must move or grow.
- Fade a pre-rendered blur layer instead of animating the blur radius.
- For a progress or spinner, keep the animated part on `transform` and let the
  colour change without a transition.

## Where the work runs

- **CSS transitions and `@keyframes`** run on the compositor when the property
  allows it; this is the cheapest place to be during a busy main thread.
- **Web Animations API** gives the same off-thread behaviour with imperative
  control — useful when the end state is computed.
- **A per-frame JavaScript loop** is the most expensive option, and it is the one
  that stutters exactly when the app is busy. If the animation is cosmetic, prefer
  either of the two above.
- **In React, write to the node, not to state.** A `setState` per frame re-renders
  a subtree sixty times a second to move one element.

## Checklist before calling an animation done

- [ ] Only `transform` / `opacity` / `filter` animate
- [ ] No `transition: all` anywhere on the path
- [ ] The animation is not started by typing, and does not block input
- [ ] `will-change` present only while it is needed
- [ ] Verified on a throttled device profile, not just on the dev machine
- [ ] The reduced-motion preference is respected (see `accessibility-and-keyboard`)

## Origin

QianNing Agent. Written in this repository; the craft guidance is restated in our
own words from general interface-design practice, with no third-party text,
examples, or vocabulary reproduced.
