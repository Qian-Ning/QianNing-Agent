---
name: math-animation
description: an algorithm or an equation has to be explained as a short animation and the result has to be a file that plays correctly everywhere
---

# Animating an explanation

The failure mode of a maths animation is not ugly frames; it is a video where
something moved and the viewer did not see why. The work is in the timeline, not
in the drawing: what is on screen before a change, how long the change takes, and
what stays still while it happens.

## The timeline is a table, not a feeling

Write it before drawing anything. Each row is one thing the viewer must
understand, with a start and an end in seconds:

| # | beat | in | out |
|---|---|---|---|
| 1 | problem on screen, nothing else | 0.0 | 2.0 |
| 2 | first term highlighted | 2.0 | 3.0 |
| 3 | substitution shown, old form fades | 3.0 | 4.6 |
| 4 | result holds | 4.6 | 7.0 |

Then `frame = round(t * fps)` and `t = frame / fps`. At 30 fps, a 3 s animation
is 90 frames; I rendered 90 PNGs, encoded them, and `ffprobe` reports
`duration=3.000000`, `nb_frames=90`, `r_frame_rate=30/1`. The arithmetic is
exact, which is why the mapping belongs in one function used by every beat.

Timing rules that hold across styles:

- **Nothing appears before it is needed.** A viewer reading a formula stops
  watching the animation. Reveal when the narration or the cursor reaches it.
- **A change needs about a quarter of a second to register** — 7–8 frames at 30
  fps. A 0.1 s cross-fade is 3 frames and reads as a cut, which is fine if you
  wanted a cut.
- **Hold at the end.** The last frame must stay long enough to read, usually
  1.5–2 s. An animation that ends on the frame where the answer lands has no
  answer.
- **Total length is the length of the explanation, not a target.** Two minutes
  for a proof step is correct; two minutes for "this is a box" is not.

## Easing that shows cause and effect

Constant-velocity motion reads as mechanical, and worse, as unrelated to
anything: the viewer cannot tell whether the movement is the operation or just
the camera. Ease-out (fast start, slow finish) reads as "this landed here";
ease-in reads as "this is being pulled away".

Concretely, the widely used four-parameter curve `cubic-bezier(0.4, 0, 0.2, 1)`,
solved numerically, is at **0.776 of the distance at the halfway point** — it is
strongly front-loaded, not symmetric, and its ten per-frame steps from a
ten-step tween are:

```
eased : 0.026 0.108 0.233 0.246 0.162 0.100 0.062 0.037 0.019 0.006
linear: 0.100 0.100 0.100 0.100 0.100 0.100 0.100 0.100 0.100 0.100
```

The peak step is nearly 2.5× the average, which is what makes the motion read as
decisive. If you want symmetric acceleration and deceleration instead, use
`cubic-bezier(0.42, 0, 0.58, 1)` — measured at 0.500 at the midpoint — and note
that its first step is 0.02, so it starts almost imperceptibly.

Rules:

- Ease **position and camera**. Do not ease a number the viewer is reading: a
  counter that accelerates through 3.7 to land on 4 is a number nobody saw.
- Ease the *interpolation* of a parameter, not the parameter's own value, when
  the parameter is supposed to be compared across beats.
- Keep one easing curve per animation. Two curves means two visual languages and
  the viewer has to learn both.
- Never ease a step that is supposed to be simultaneous with another; matched
  durations are how two things read as one event.

## Cause before effect, by one frame at least

The operation and its result must not land on the same frame. Show the
substitution, hold it for 2–3 frames with the old and new forms both visible,
then fade the old one. If both appear together, the eye reads a replacement and
the reasoning is lost.

The same applies to an algorithm: the array state *before* the swap, then the
swap, then the state after. Three states, not one. The comparison that decided
it should stay visible during the swap — highlight the two elements, keep the
highlight, then move them.

## Labelling without clutter

- **One caption area, fixed position.** A caption that moves with the object is
  read once and then lost. Reserve the bottom 12–15% of the frame.
- **Labels arrive with the thing they name, and leave with it.** A label for a
  value that is off screen is noise; a label that persists after its object
  leaves is a puzzle.
- **Do not label a value twice.** If the caption says "wave speed 3 m/s", the
  axis needs ticks and a unit, not a second "wave speed" annotation.
- **Point with a short line, not a long one.** A leader over 40 px long crosses
  other things; move the label closer and shorten the text instead.
- **Type size is set by the smallest screen the video will be seen on**, which
  is usually a phone at 360 px wide. At 1280×720, a 24 px label is 7% of the
  height and survives that; 16 px does not.

For an equation, set it once at full size and animate opacity and position of
whole terms rather than retyping it per frame; retyping means the baseline
shifts by a pixel between frames and the whole thing shimmers.

## Rendering to a file

Frames first, then encode. Never encode on the fly while a preview is also
running — the frame timing becomes a function of machine load.

```bash
# frames/f0000.png ... frames/f0089.png, all the same size
ffmpeg -y -framerate 30 -i frames/f%04d.png \
       -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart out.mp4
```

Three traps, all verified on this host:

- **`-framerate` before `-i`.** The input option sets how fast the image
  sequence is read. Omit it and the sequence is read at 25 fps: my 90 frames
  came out as `duration=3.600000` instead of 3.0 — a silent 20% slow-motion, and
  the audio, if there is any, no longer matches.
- **`-pix_fmt yuv420p`.** Without it the encoder picks the input's format, and
  RGB PNGs produced `pix_fmt=yuv444p`, profile `High 4:4:4 Predictive`. Many
  hardware decoders and some presentation tools refuse that; the file plays
  locally and not on the machine in the meeting room.
- **`-crf 18` is the quality knob, not `-b:v`.** For flat diagrams and text,
  crf 18 is visually lossless and small (my 640×360, 90-frame clip: 7 831
  bytes). At crf 23 it was 6 784 bytes and at 28, 6 259 — a fifth of the size
  for visibly softer type. On a synthetic clip like this one, the quality is
  worth more than the bytes.

Intermediates should be PNG, not JPEG: JPEG chroma subsampling on a saturated
annotation colour produces halos that survive the final encode.

For a long piece, render scenes separately and join them without re-encoding:

```bash
ffmpeg -f concat -safe 0 -i scenes.txt -c copy final.mp4
```

`scenes.txt` lists `file 'scene1.mp4'` lines. Every scene must share codec,
resolution, frame rate, and pixel format or the concat produces a file whose
timestamps drift.

## Checking the result

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=nb_frames,r_frame_rate,duration,width,height \
  -of default=nw=1 out.mp4
```

`nb_frames` should equal your frame count exactly; `duration` should equal
frames / fps to within a frame. Then look at three stills — the first frame, the
frame where the key change happens, and the last — and check that each is
readable on its own. A still that makes no sense is a frame the viewer will
pause on.

If there is narration, the timeline is derived from the audio, not the other way
round: cut the voice track first, note the sentence boundaries, and place the
beats against those times. Animating first and fitting narration to it produces
the rushed, clipped delivery that makes an explainer sound automated.

## Where this goes wrong

- A timeline held in code as scattered `if (t > 3.2)` conditions, so no one can
  say what the animation does without running it.
- Cross-fading the old and new form at the same time as moving them, so the eye
  tracks the movement and never reads the substitution.
- Easing a readable number, or easing the camera and the object with different
  curves.
- Encoding without `-pix_fmt yuv420p`, then discovering the file is rejected by
  the player in the room.
- Forgetting `-framerate`, and shipping a slow-motion version that looks
  "smoother" and is wrong.
- Labels drawn at 14 px on a 1920-wide canvas, unreadable the moment it is
  viewed on a phone.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
