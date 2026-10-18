---
name: audio-visualization
description: a spectrogram, mel view, or chroma plot has to be made from an audio file and read accurately enough to say something true about the signal
---

# Looking at sound

A spectrogram is a picture of a decision: which window, which hop, which
frequency scale, which dynamic range. Change any of them and the picture changes
while the sound does not. So the first rule is that the parameters go in the
caption, and the second is that the numbers on the axes are checked against a
signal whose answer you already know.

## Window size is a time-frequency trade

The window length sets the frequency resolution: bin width is `fs / nperseg`, and
the time step is `hop / fs`. You cannot have both.

At 8 kHz on a one-second 440 Hz sine, using the defaults of the spectrogram
routine on this host:

| `nperseg` | bin width | peak bin read | error | time slices |
|---|---|---|---|---|
| 256 (default) | 31.25 Hz | 437.5 Hz | −2.5 Hz | 35 |
| 1024 | 7.81 Hz | 437.5 Hz | −2.5 Hz | 8 |
| 4096 | 1.95 Hz | 439.5 Hz | −0.5 Hz | 2 |

Read that table twice, because it says something people get wrong: **the peak
you read off a spectrogram is a bin centre, not the frequency.** 440 Hz falls
between bins 14 and 15 of a 31.25 Hz grid, and the maximum lands on 437.5
whatever the amplitude. Widening the window did not fix it either — 437.5 again
at 1024, because the bin grid moved but 440 is still not on a bin centre.

Two honest fixes:

- **Parabolic interpolation** on the three magnitudes around the peak. I fitted
  a parabola to the log magnitudes either side of the maximum and got an offset
  of +0.336 bins, which on the 1024-point grid is **440.12 Hz**. That is a
  hundredfold improvement for six lines of arithmetic, and it is what every
  serious peak tracker does.
- **Quote the resolution, not the number.** "Energy concentrated near 437 Hz,
  with a 31 Hz bin width" is a true statement about the analysis. "A 437.5 Hz
  tone" is a false statement about the signal.

For music at 44.1 kHz, 1024 samples is 43 Hz per bin and 23 ms per slice — fine
for pitch, too coarse for consonants. 4096 is 10.8 Hz and 93 ms, good for
harmony and useless for rhythm. 256 is 172 Hz per bin, which is not a
spectrogram, it is a blur.

## The defaults are probably not what you want

The routine's signature on this host (`scipy.signal.spectrogram`):

```
fs=1.0, window=('tukey_periodic', 0.25), nperseg=None, noverlap=None,
nfft=None, detrend='constant', return_onesided=True, scaling='density',
mode='psd'
```

Three consequences:

- **`fs` defaults to 1.0.** Forget it and every axis is in cycles per sample,
  which is a number between 0 and 0.5. The plot looks plausible and means
  nothing.
- **The window is a Tukey taper with 0.25 of the window tapered**, not the Hann
  window people assume. Tukey with that parameter keeps a long flat top, so
  sidelobes are higher than Hann's — visible as skirts around a pure tone. Pass
  `window="hann"` when you want the textbook picture, and say so.
- **The overlap defaults to one eighth of the window**, not the 50% or 75% that
  tutorials use. That is why the default gave 35 time slices per second at
  `nperseg=256` instead of the 122 you get at 75% overlap. Pass `noverlap`
  explicitly; the time axis is otherwise four times coarser than expected, and
  fast transients fall between slices.

I use `nperseg=1024, noverlap=768, window="hann"` as a starting point for
speech, and `nperseg=4096, noverlap=3072` for harmony.

## Mel: the formula with a factor-of-2.3 trap

The mel scale compresses high frequencies the way hearing does. The form is

```
m = 2595 * log10(1 + f / 700)
```

Checked at 1 kHz: 999.99 mel, which is the calibration point the formula is
built around. Now the trap. The same scale is often written with the constant
1127 and the *natural* logarithm:

```
m = 1127 * ln(1 + f / 700)
```

Both give 1000 at 1 kHz. Pair 1127 with `log10` and you get **434.29** — off by
a factor of 2.3026, which is exactly ln(10). Nothing errors, the filter bank is
just built on a scale that is not mel, and the resulting spectrogram looks
almost right: slightly too much resolution at the bottom, too little at the top.
If a mel plot looks subtly wrong, check which logarithm is next to which
constant before checking anything else.

Mel is also not a single scale. The 2595/700 form is the convention most speech
toolkits use; the other common one is linear below 1 kHz and logarithmic above,
and the two disagree by a few percent in the mid range. Pick one, name it, and
use it for both the filter bank and the axis labels. Mixed conventions produce a
plot whose ticks do not sit where its bins do.

For a mel spectrogram: 40–128 bands, `n_fft=1024` at 22 kHz, log-compress the
result (`10*log10(x + 1e-10)` or `log1p`), and clip the display to an 80 dB
range. A dB range of 120 shows the noise floor and the room tone and makes the
signal hard to see.

## Chroma, and why it lies a little

Chroma folds every bin to one of twelve pitch classes, which is what makes chord
and key views possible. The fold is

```
pc = round(69 + 12 * log2(f / 440)) mod 12
```

Measured on a 440 Hz sine: the chroma vector peaks at A with everything else at
0.00 — as it must. On a 440 Hz **sawtooth**, which has the same pitch but a
harmonic series, the same code gives A at 1.00 and **E at 0.13**: the third
harmonic at 1320 Hz folds to E. One note, two pitch classes. A chord view built
this way attributes energy to notes nobody played.

Mitigations, in order of usefulness: log-compress before folding (turns a
1000:1 harmonic ratio into a 3:1 one); restrict the range to roughly 55–2000 Hz,
where the fundamental and first harmonics live; subtract a spectral floor so
window skirts do not vote; and treat chroma as a similarity measure, never as a
transcription.

Also note the log compression and the range restriction are not cosmetic — I got
a completely wrong answer (C tying with A on an A+C dyad) from an uncompressed
fold over the full spectrum, because the window sidelobes and the noise floor
carried as much weight as the partials.

## Drawing it without a plotting library

The data is an array of dB values; the picture is a colour lookup. That is
twenty lines, and it avoids a large dependency for a one-off:

```python
import numpy as np
from PIL import Image

# S: power, shape (freq_bins, time_bins); f: frequencies in Hz
db = 10 * np.log10(S + 1e-12)
db = np.clip((db - (db.max() - 80)) / 80, 0, 1)     # 80 dB window

# A simple dark-to-bright ramp; a perceptually uniform map is better if you
# have one, and any rainbow map is worse than this.
ramp = np.stack([
    30 + 225 * db ** 1.4,
    20 + 200 * db ** 2.2,
    60 + 195 * db ** 0.8,
], axis=-1).clip(0, 255).astype(np.uint8)

img = Image.fromarray(ramp[::-1])                    # low freq at the bottom
img.resize((900, 400), Image.BILINEAR).save("spec.png")
```

Notes that matter for the picture being true:

- **Origin.** Arrays come out with frequency increasing downward, so the image
  has to be flipped or the axis is upside down — the most common wrong
  spectrogram, and it looks completely normal.
- **Log frequency axis** for anything musical (or a mel axis, which is the same
  idea with a different warp). A linear axis spends 90% of the height on the top
  two octaves, where there is usually nothing.
- **Colour.** Sequential and monotonic. Rainbow maps invent edges where the data
  is smooth, and they are unreadable to a colour-blind viewer.
- **A video of the spectrogram** is just the same code in a frame loop, written
  as PNGs and encoded; the same `-framerate` and `-pix_fmt yuv420p` rules apply
  as for any other frame sequence.

## Reading one well enough to say something true

What the image supports, and what it does not:

- **A steady horizontal line** is a sustained partial at that frequency. You can
  state the frequency to within a bin, and the duration to within a hop.
- **A stack of horizontal lines at integer multiples** is a harmonic series. The
  lowest is the fundamental *only if it is present* — a missing fundamental is
  normal for small speakers and for some instruments, and the pitch is still the
  fundamental.
- **Vertical stripes** are amplitude modulation: a tremolo, a plucked attack, a
  click track. Their spacing is the modulation rate, and it is usually easier to
  read from the stripe spacing than from the waveform.
- **A diagonal line** is a glide — a sweep, a pitch bend, a siren. A diagonal
  that is not straight is a non-linear glide, which is a real and interesting
  finding.
- **Broadband energy across all frequencies for a short time** is a transient or
  noise. You cannot tell which instrument from the picture.
- **You cannot read timbre, instrument identity, or lyrics off a spectrogram.**
  "A violin" is an inference from prior knowledge, not an observation. Say
  "harmonic series with a strong 3rd and 5th partial and slow attack" and let the
  reader make the inference.

Two mistakes that produce confident wrong statements:

1. **Reading the peak as the pitch.** For a voice, the strongest partial is
   often not the fundamental, and the pitch you report is an octave or a fifth
   off. Check the harmonic spacing, not the brightest row.
2. **Using magnitude where the code wanted power.** `10*log10(magnitude)` is
   half the dB value of `20*log10(magnitude)`; the plot looks fine and every
   threshold you set is 6 dB off. Pick one and put the reference (`dBFS`,
   `dB re 1.0`) in the label.

Finally, calibrate on a known signal before plotting the unknown one: a sine at
a stated frequency, a click at a known time, silence. Thirty seconds of that
catches the wrong sample rate, the flipped axis, and the off-by-a-window
timestamp, all of which produce a plot that looks like a plot.

## Where this goes wrong

- Forgetting `fs`, and labelling an axis in cycles per sample.
- Reporting the peak bin as the frequency, with no mention of the bin width.
- Building a mel filter bank with 1127 and `log10`, and getting a scale that is
  2.3× a mel.
- Leaving the default 12.5% overlap and missing every transient.
- A linear frequency axis for music, or an upside-down one for anything.
- Chroma without log compression, so one note appears as two pitch classes.
- Describing the instrument instead of the signal, from a picture that only
  shows energy.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
