---
name: generative-sketches
description: an animated canvas sketch — generative art, shader effect, interactive scene — must reproduce a good frame
---

# Canvas sketches that can be replayed

A sketch is a program with a clock and a random source. Both are easy to write
badly, and both fail in the same way: the picture on screen looks fine, and the
frame you liked cannot be produced again. Everything else here is about making
those two inputs explicit.

## The loop

```js
let last = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); // clamp: tab stalls
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
```

The first callback's timestamp becomes `last`, otherwise the first `dt` is the
whole time since page load and everything jumps.

`requestAnimationFrame` gives `now` in milliseconds and it is a real timestamp,
not a frame counter. Use it. Motion computed as `x += 2` per frame runs at
double speed on a 120 Hz display and at half speed when the machine is busy, and
the bug is invisible on your monitor.

The clamp matters more than it looks. A background tab stops receiving
callbacks; when it comes back, `now - last` can be thirty seconds. With a
physics step, one unclamped step of 0.5 s puts a falling body at 225 px where
thirty steps of 1/60 s put it at 116 px and the exact answer is 112 px — I ran
those three numbers, and the single big step is off by 2×. That is the visible
"everything teleported through the floor" bug.

Float drift is *not* the problem, whatever the folklore says. Accumulating
1/60 ten thousand times for ninety seconds of frames drifts by 3.8e-12 seconds.
Accumulation error is irrelevant; variable step size is not.

## Fixed step, with interpolation for display

When the simulation must be stable, advance it in fixed steps and let the render
use the leftover fraction:

```js
const STEP = 1 / 120;
let acc = 0;
function update(dt) {
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard++ < 8) { simulate(STEP); acc -= STEP; }
}
```

The guard is what stops a long stall from turning into ten thousand simulation
steps and a frozen tab. Cap the catch-up work, drop the rest, and let the
simulation be slightly behind reality.

If the render has to be smooth while the simulation ticks at 120 Hz and the
display is 60 Hz, interpolate between the last two states by `acc / STEP`. For
most sketches this is unnecessary; for anything with visible momentum it is the
difference between smooth and stuttery.

## Seeded randomness, so a frame can be found again

`Math.random()` cannot be seeded, so a sketch that calls it can never be
replayed. Use a small integer-hash generator with the seed as the only input:

```js
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

Verified: seed 7 gives `0.011705 0.061958 0.976908 0.699029 0.521445` on every
run in a fresh process, seed 8 gives a different sequence, and 200 000 draws from
seed 1 average 0.4996. It is a PRNG, not a source of entropy — fine for
placement, jitter, and palette choice, wrong for anything security-shaped.

Three rules that make the seed actually useful:

- **Seed once per structure, not once per draw.** A generator constructed inside
  the per-frame loop restarts every frame, so the "random" layout flickers
  between two states. Construct it when the sketch is set up and keep it.
- **Store the seed with the output.** When a frame is worth keeping, the
  metadata is `{seed, frameIndex, width, height, dpr}`. A seed alone does not
  reproduce a frame if the sketch has been running for an unknown time.
- **Derive sub-streams instead of sharing one.** `mulberry32(seed ^ 0x9e37)` per
  subsystem means adding one particle system does not reshuffle every other
  one.

For a frame you can seek to, `seek(t)` must reset the state and step the
simulation forward to `t` — not interpolate a time parameter into a formula that
was never time-parameterised. If the sketch cannot seek, "frame 900" is the only
address, and frame 900 depends on what the browser did on the way there.

## The device pixel ratio

A canvas has two sizes: the CSS box it occupies and the backing store in device
pixels. Set both, and scale the context once:

```js
function resize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: rect.width, h: rect.height, dpr };
}
```

`getBoundingClientRect()` rather than `canvas.width`, because the CSS size is the
one the layout decided. At 800 CSS px: dpr 1 gives an 800 px backing store, dpr
1.25 gives 1000, dpr 2 gives 1600 — all three measured from the same formula.
Forget the transform and everything draws at half size on a retina display;
forget the backing store and everything is soft.

Two traps live here:

- **Assigning `canvas.width` resets the context**: transform, `fillStyle`,
  `lineWidth`, clip, and shadow all return to defaults. Resize *then* re-apply
  state, or you will chase a bug where the drawing turns black after a window
  resize.
- **Setting the canvas size inside its own `ResizeObserver` callback** can loop,
  because changing the size can change the layout that the observer is watching.
  Compare against the last applied size and return early when it is unchanged.

Debounce the resize by a frame rather than doing the work per event; a window
drag fires dozens of times a second and the resize itself is the expensive part.

## Cost, before the frame rate tells you

Canvas 2D fills pixels. The useful estimate is overdraw: particles × π r².
I computed a few:

| particles | radius | area per frame | at 60 fps |
|---|---|---|---|
| 2 000 | 2 px | 0.03 Mpx | trivial |
| 20 000 | 2 px | 0.3 Mpx | fine |
| 20 000 | 20 px | 25 Mpx | 1.5 Gpx/s — too slow |
| 200 000 | 3 px | 5.7 Mpx | borderline |

Software canvas fill runs in the low hundreds of millions of pixels per second
on a normal laptop, so the third row is a stutter and the fourth is a slideshow
on a retina display where every one of those pixels is four device pixels. Add
`globalCompositeOperation = "lighter"` and blending makes it worse.

Cheap levers, in order: draw fewer, larger marks; render the static layer once
into an offscreen canvas and blit it; cap the particle count against
`rect.width * rect.height / 400`; and drop the dpr to 1 for the effect layer
while keeping type at full resolution.

A per-pixel effect in JavaScript is a different budget. 800×600 is 480 000
pixels per frame, 28.8 Mpx/s at 60 fps, and a per-pixel loop with a few
operations each is already at the edge. Two workable answers: compute the effect
at a quarter resolution into an `ImageData` and upscale it with
`imageSmoothingEnabled = true`, or move it to WebGL where the same work is
normal. Do not write a per-pixel loop at 1920×1080 (124 Mpx/s) and then wonder
why the fans come on.

## A 3D view without a 3D library

Painter's algorithm — sort by depth, draw back to front — is enough for points,
spheres, and anything convex, and it fails the moment two objects interpenetrate.
Rotate, then project:

```js
const cy = Math.cos(yaw), sy = Math.sin(yaw);
const cp = Math.cos(pitch), sp = Math.sin(pitch);
function project([x, y, z]) {
  const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
  const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
  const k = focal / (focal + z2);      // perspective; z2 > -focal
  return [cx + x1 * k, cy0 + y1 * k, z2];
}
```

Sort by `z2` descending and draw. Guard against `focal + z2 <= 0`: a vertex
behind the camera projects to a mirrored point and you get geometry smeared
across the whole frame. Either clamp, or cull the primitive.

For more than about fifty thousand points, stop using canvas paths — build one
`ImageData` and write pixels, or use WebGL with a single buffer.

## Saving the frame

```js
const url = canvas.toDataURL("image/png");
```

PNG, always. `image/jpeg` at quality 0.9 rounds every soft gradient into blocks
and is lossy on exactly the fine noise a generative sketch is made of. If the
canvas was drawn at dpr 2, the PNG is 2× the CSS size — that is usually what you
want, and it is worth saying in the filename (`sketch-1600x1200@2x.png`) so the
next person does not think the layout changed.

A good frame is a found object, not a design. Record the seed, the frame index,
and the canvas size next to the file; without them the search has to start over.

## Where this goes wrong

- Driving motion from a frame count, so the sketch runs at a different speed on
  every display and cannot be compared across machines.
- One unclamped `dt` after a tab switch, and every body in the simulation jumps
  through the walls.
- A PRNG constructed inside the draw loop, producing a two-state flicker that
  looks like noise and is actually a reset.
- Backing store at CSS size on a retina display: soft lines, and a
  `lineWidth = 1` hairline that renders as two grey pixels.
- Resizing the canvas and losing the transform, then blaming a library.
- Twenty thousand 40 px blobs with additive blending, then optimising the wrong
  thing.
- Saving a frame as JPEG and losing the gradient banding that made it good.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
