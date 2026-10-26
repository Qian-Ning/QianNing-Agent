---
name: ascii-video
description: video or audio has to become ASCII frames that play in a terminal and stay small enough to store
---

# Turning a clip into text

The conversion is four decisions in a fixed order: how many frames per second,
how many columns, how a pixel becomes a character, and whether characters carry
colour. Each one multiplies into the size of the result, and the last one is the
only place where the size gets out of hand.

## Sample with the decoder, not with a loop

Let the video tool drop frames instead of reading every frame and throwing most
of them away:

```bash
ffmpeg -v error -i in.mp4 \
  -vf "fps=12,scale=80:30:flags=area" \
  -f rawvideo -pix_fmt gray -
```

`fps=12` selects twelve frames per second; my 3-second, 30 fps test clip came
out as exactly **36 frames**, which is the number the tube should carry. The
filter duplicates frames when the source is slower than the target rate, so
`fps=30` on 12 fps source gives 30 frames per second of duplicated content —
never upsample to make the text "smoother".

`flags=area` averages the source pixels inside each output pixel. The default
resampling is a cubic kernel that rings on hard edges, and at an 80-column grid
the ringing shows up as speckle in flat backgrounds — the darkest characters
appearing in a sky that should be uniform.

Read raw `gray` rather than decoding PNGs: one buffer per frame, no image files
on disk, and no chance of a stray 16-bit PNG silently halving every value.

## The grid, and the 2:1 cell

A character cell in a terminal is roughly twice as tall as it is wide (about
0.6 em by 1.2 em). An 80-column frame from a 4:3 source therefore wants

```
rows = cols * (height / width) / 2
```

which for 320×240 and 80 columns is 30 rows — the grid I used: 2 400 characters
per frame, 2 430 bytes once the 30 newlines are counted. Skipping the halving gives 60 rows
from an 80×60 scale, and the picture is stretched vertically by a factor of two.
That is the single most common shape bug in these converters, and it looks like
the source was squashed rather than like a bug in the code.

Common grids, with the cost of one frame before colour:

| grid | chars | bytes/frame | 12 fps, 1 minute |
|---|---|---|---|
| 60×20 | 1 200 | 1 220 | 0.9 MB |
| 80×30 | 2 400 | 2 430 | 1.7 MB |
| 120×45 | 5 400 | 5 445 | 4.0 MB |

## Pixel to character

Pick a ramp ordered dark to light. Ten levels is the practical maximum for a
proportional-reading eye; the classic set is

```python
RAMP = " .:-=+*#%@"
level = value * len(RAMP) // 256        # value 0..255
```

More levels do not add detail, because the glyphs' ink coverage does not vary
linearly with the index. Fewer than six and gradients band into stripes.

The subtlety is **which** luminance. Three different answers, all defensible,
and they disagree on saturated colour:

- Rec. 601 luma (`0.299 R + 0.587 G + 0.114 B`): pure red, green, blue become
  **76, 150, 29**. This is what the standard "convert to grey" path uses — I
  checked the greyscale conversion on this host with three single-colour pixels
  and got exactly those three values.
- Rec. 709 (`0.2126 R + 0.7152 G + 0.0722 B`): **54, 182, 18**. The same blue
  is nearly twice as bright as under 601.
- Perceived brightness after linearisation: much darker again.

Consequences worth knowing before you debug a conversion:

- Pure blue is 29/255 under 601, which is level 1 of 10 — a blue object on a
  black background disappears entirely. If the source has saturated colour that
  matters (a highlighted region, a blue LED), convert with your own weights and
  apply gamma before the ramp, or accept that it vanishes.
- Do **not** linearise the sRGB values before mapping to the ramp. Mid-grey 128
  becomes 0.216 in linear light, which lands on level 2 of 10; the ramp's levels
  are spaced perceptually, not physically, so the naive value (level 5) is the
  one that looks right. I expected the linear version to be more correct and the
  arithmetic says the opposite: linearising turns a mid-grey image into a dark
  one.
- Alpha is not in `gray` output at all. A transparent-background source renders
  as black, and black is a space — the shape disappears.

## Colour, and what it costs

A true-colour foreground escape is 19 bytes (`ESC[38;2;R;G;Bm`) and a reset is
4. If each character carries its own colour:

```
2 400 chars × 23 bytes = 55 200 bytes/frame
55 200 × 12 fps × 3 600 s = 2.38 GB per hour
```

Against **105 MB per hour** for the same grid in monochrome. That is the whole
difference between a file you keep and a file you delete. Verified by length,
not by guess: the two escape strings measure 19 and 4 bytes.

Ways to keep colour and stay small:

- **Colour per run, not per character.** Emit an escape when the colour changes
  by more than a threshold, so a flat sky is one escape for 80 characters.
- **Diff frames.** Encode only the cells that changed since the previous frame
  and seek the cursor with `ESC[row;colH`. A talking head at 12 fps changes a
  few hundred cells per frame, not 2 400.
- **Use the 256-colour palette** (`ESC[38;5;Nm`, about 8 bytes): 6×6×6 cube plus
  greys, and for a 10-level ramp the quantisation is invisible.
- **Drop colour entirely** for anything archival. Monochrome ASCII of an
  hour-long clip is 105 MB and greps.

## Fidelity: what each knob actually buys

| change | effect |
|---|---|
| more columns | real detail; also real cost, quadratic if rows follow |
| more fps | smoother motion; above ~15 the text stops reading as motion and starts reading as flicker |
| more ramp levels | smoother gradients; no new edges |
| colour | separates objects of similar brightness; costs 20× |

12 fps is the usual compromise for motion; 8 fps is fine for a slow pan; 24 is
only worth it for fast cuts, and only if the viewer's terminal can keep up. A
terminal that redraws 2 400 cells per frame at 24 fps is doing 57 600 cell
writes per second, which is where some terminals start to tear.

## The converter

This is the loop that produced the numbers above, with the useful parts kept:

```python
import subprocess

RAMP = " .:-=+*#%@"
COLS = 80
FPS = 12

probe = subprocess.run(
    ["ffprobe", "-v", "error", "-select_streams", "v:0",
     "-show_entries", "stream=width,height", "-of", "csv=p=0", "in.mp4"],
    capture_output=True, text=True, check=True)
w, h = (int(v) for v in probe.stdout.strip().split(","))
rows = max(1, int(round(COLS * (h / w) / 2)))

raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", "in.mp4",
     "-vf", f"fps={FPS},scale={COLS}:{rows}:flags=area",
     "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    capture_output=True, check=True).stdout

stride = COLS * rows
frames = [raw[i:i + stride] for i in range(0, len(raw), stride)]
with open("out.txt", "w", encoding="utf-8") as fh:
    for buf in frames:
        for y in range(rows):
            row = buf[y * COLS:(y + 1) * COLS]
            fh.write("".join(RAMP[b * len(RAMP) // 256] for b in row) + "\n")
        fh.write("\n")
```

Reading the height from `ffprobe` rather than hard-coding it is what makes the
aspect correct for a vertical clip; assuming 4:3 works until the first phone
video.

Trailing spaces matter only if the file is used as art rather than played back;
stripping them halves the size of dark frames and changes nothing about the
picture. Newlines cost one byte per row — 30 bytes per frame out of 2 430, so
worth having for readability.

## Playing it back

`cat out.txt` scrolls at whatever speed the terminal can print. For a timed
playback, read the file as frames and print one frame per tick, sleeping
`1/fps`, with a cursor-home escape (`ESC[H`) between frames instead of clearing
the screen — clearing flickers, homing does not. Keep the frame in a single
write; per-line writes at 30 lines per frame tear visibly.

If the terminal is narrower than the grid, either scale the grid to the terminal
width at conversion time or accept wrapping, which destroys the picture. Ask the
terminal for its width instead of guessing 80.

## Where this goes wrong

- Forgetting the 2:1 cell correction, then "fixing" the distortion by cropping.
- Pure blue objects vanishing because luma weights put them near black, with no
  error anywhere to explain it.
- Linearising before the ramp and shipping a video that is two stops
  underexposed.
- Per-character true-colour escapes, and an hour of source becoming 2.4 GB of
  text.
- Upsampling the frame rate, so the output is slower to play and carries no more
  information.
- Reading every frame and discarding 60% of them in Python, which converts in
  minutes what the decoder does in seconds.
- Writing the frames as one string per character — a million tiny writes, and a
  conversion that takes longer than the film.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
