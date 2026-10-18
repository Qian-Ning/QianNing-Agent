---
name: powerpoint
description: a slide deck has to be built or edited in code and still look right when it opens
---

# Building and editing slide decks

A deck is a small hierarchy of parts: the presentation lists slide ids, each
slide points at a layout, each layout belongs to a master, and each master carries
a theme. Text lives in shapes on the slide; the shape's geometry is in EMU, at
914,400 to the inch. Almost every "it looks wrong" bug is one of those three
things being assumed rather than checked.

## Geometry before content

The default presentation is 10 × 7.5 inches (verified: `9144000 × 6858000`), which
is 4:3. A widescreen deck is 13.333 × 7.5. Set the size first, because every
coordinate you write afterwards is relative to it.

```python
from pptx import Presentation
from pptx.util import Emu, Inches, Pt

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
```

Place shapes on a grid you decide once — title at 0.6 in from the top, body from
1.6 in, 0.5 in margins — and keep those numbers in a module constant. Hand-tuned
coordinates per slide are how a generated deck ends up with three different
title heights.

## Building a deck from scratch

```python
from pptx.enum.text import PP_ALIGN

layout = prs.slide_layouts[1]                 # "Title and Content"
slide = prs.slides.add_slide(layout)
slide.shapes.title.text = "Q3 in three numbers"

body = slide.placeholders[1].text_frame
body.text = "Revenue up 8%"
for line in ("Churn flat at 2.1%", "Two hires closed"):
    paragraph = body.add_paragraph()
    paragraph.text = line
    paragraph.level = 0
```

- The default template's layouts are index 0 through 10, in order: title, title
  and content, section header, two content, comparison, title only, blank, content
  with caption, picture with caption, title and vertical text, vertical title and
  text. Index 6 is the blank one.
- `slide.shapes.title` is `None` on a blank layout, and
  `slide.placeholders[1]` raises `KeyError` when the layout has no second
  placeholder. Both verified; check before using.
- Text in a placeholder inherits bullets, indents, and font from the layout. Text
  in a plain textbox inherits nothing: no bullets, no indent levels, and
  `paragraph.level` has no visible effect without a list definition. If the slide
  needs bullets, use the content placeholder.
- `prs.save()` writes the whole package. Saving the same `prs` twice is fine;
  saving over the file you loaded from is fine too.

### Images

```python
pic = slide.shapes.add_picture("chart.png", Inches(1), Inches(2), width=Inches(6))
print(pic.height / 914400)          # 3.0 for a 2:1 image
```

Pass exactly one of `width` or `height`. With a single dimension the other is
computed from the image's pixel aspect ratio — verified on an 800 × 400 source,
which came back 2.0 in high at 4 in wide. Passing both stretches the image and is
almost never what you want. An image with no intrinsic DPI may still be placed at
its pixel size in points if you pass neither; pass one.

### Charts

A chart is a part in `ppt/charts/`, and the data behind it is an embedded
spreadsheet in `ppt/embeddings/` (verified: both parts appear on save). The chart
reads its categories and series from the chart part, not from the embedded sheet,
so building the file in code means putting the numbers into `CategoryChartData`
and not trying to write cells into the embedded workbook. Editing that workbook in
the application updates the chart; the reverse is not true.

### Speaker notes

```python
slide.notes_slide.notes_text_frame.text = "Open with the churn number, not revenue."
```

Accessing `notes_slide` creates the notes part on demand — verified by the
`ppt/notesSlides/` part appearing after the first save, along with a notes master.
Notes are the place for the argument you are not putting on the slide; a deck
without them is a deck someone else has to present from memory.

## Editing an existing deck

- **Find placeholders by `idx`, not by position.** `placeholder_format.idx` is
  stable within a layout; the order of `slide.shapes` is the order the shapes
  happen to be stored in, which varies by producer. `shape.name` is worse:
  `Title 1` is a default name and duplicates freely.
- **Replace text without flattening it.** `text_frame.text = "..."` collapses
  every paragraph into one and discards per-paragraph levels and runs. To keep the
  design, write into the first paragraph's first run and delete the extra
  paragraphs, or iterate `text_frame.paragraphs` and set `paragraph.runs[0].text`
  for each — and empty the remaining runs in that paragraph, which keeps the
  paragraph's own formatting.
- **Deleting every slide**, which is how you reuse a deck as a template:

```python
slide_ids = prs.slides._sldIdLst
for slide_id in list(slide_ids):
    rel_id = slide_id.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
    prs.part.drop_rel(rel_id)
    slide_ids.remove(slide_id)
```

Dropping the relationship as well as the element is what removes the part; skip
`drop_rel` and the slides are gone from the presentation but their parts stay in
the file, and the deck grows every time you do it. Verified: after this loop the
deck has zero slides and still opens.

- **Insert a slide at a position** by moving its `sldId` element inside
  `_sldIdLst`; `add_slide` always appends.

### Duplicating a slide

Copying shape elements between slides does not copy their relationships. Verified
failure: deep-copying a picture and a chart from one slide to another produced a
file that saved without complaint, and then raised `KeyError: no relationship with
key 'rId2'` on read, because `r:embed="rId2"` is resolved against the *target*
slide's relationship set, where only `rId1` existed.

Do it by copying the slide part with its relationships, or rebuild the content on
the new slide by re-adding each image and chart from its source file. Then open
the result and enumerate every shape's image and chart; a dangling reference is
invisible until something tries to resolve it.

## The master trap

The library preserves every part it loaded: verified by round-tripping a deck with
a master, a notes master, and a chart — no part names lost, none gained. So
re-saving a deck in code does not drop a master *by itself*. It goes wrong when
the deck is rebuilt rather than edited:

- a new presentation has exactly one master (verified), so importing slide content
  into a fresh file loses every other master, and with it the theme, the theme
  fonts, and the layouts those slides were built on;
- `prs.slide_layouts` returns the layouts of the **first** master only — that is
  what the library documents, and on a two-master deck it means the second
  master's layouts are unreachable through the common property. Go through
  `prs.slide_masters[i].slide_layouts` when the count is more than one;
- removing a master element while slides still point at its layouts produces a
  file that parses and renders wrong, because nothing validates the layout chain.
  A "does it open" smoke test passes; the fonts and the bullet styles do not.

Check the chain explicitly:

```python
masters = {m.part.partname for m in prs.slide_masters}
for index, slide in enumerate(prs.slides, 1):
    layout = slide.slide_layout
    ok = layout.slide_master.part.partname in masters
    print(index, layout.name, "ok" if ok else "ORPHANED LAYOUT")
```

Also worth checking: `len(prs.slide_masters)` against what the source deck had,
when the job is "edit" rather than "rebuild".

## Text that overflows

The library never computes autofit. A placeholder carries whatever
`<a:normAutofit fontScale="...">` the last application wrote; content added in
code keeps that value, so a slide whose original text was short will overflow once
you fill it and nothing will report an error.

- A new textbox defaults to `auto_size = SHAPE_TO_FIT_TEXT` with
  `word_wrap = False` (verified). Unwrapped, a long line widens the box past the
  slide edge instead of wrapping. Set `text_frame.word_wrap = True` on anything
  you add.
- Budget the text before you place it: at 18 pt, a character averages about half
  the point size, so a 6-inch box holds roughly 50 characters per line and a
  3-inch one about nine lines. Strings are cheap to shorten; a repaired layout is
  not.
- Certify the geometry. This catches the box that runs off the page, which is the
  most common overflow:

```python
for index, slide in enumerate(prs.slides, 1):
    for shape in slide.shapes:
        if shape.left is None:
            continue
        if (shape.left + shape.width > prs.slide_width
                or shape.top + shape.height > prs.slide_height):
            print(f"slide {index}: {shape.name} extends past the slide")
```

Verified on a textbox placed at 9 in on a 10 in slide: flagged. It cannot tell you
that the *text inside* the box overflows — that needs a render.

## Look at the output

Structural checks do not see typography. Convert and inspect:

```bash
soffice --headless --convert-to pdf deck.pptx
```

Then count pages (should equal the slide count), extract the text, and read it:
a title that appears at the bottom of the extracted page order, or a bullet that
vanished, is a layout problem you can find without a screen. Font substitution is
the other silent failure — a theme font that is not installed on the rendering
machine changes every metric, so either embed the font or choose one that is
present everywhere the deck will be opened.

## Where this goes wrong

- Rebuilding a deck slide by slide and losing the second master, then wondering
  why the brand font is gone.
- Passing both width and height to `add_picture` and shipping stretched logos.
- Copying shapes to duplicate a slide, which leaves relationship ids pointing at
  parts that belong to another slide.
- Filling a content placeholder with four bullets and letting them run off the
  bottom, because autofit was never recalculated.
- Deleting slides without dropping their relationships, doubling the file size on
  every regeneration.
- Checking that the file opens and calling the deck verified.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
