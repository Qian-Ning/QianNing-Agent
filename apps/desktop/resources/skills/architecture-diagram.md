---
name: architecture-diagram
description: a system or infrastructure diagram has to be drawn as SVG in an HTML page and read clearly at the size it will be viewed
---

# Drawing an architecture diagram by hand

A diagram generator places every node it is given at the same distance from
every other node, wraps labels at a fixed character count, and routes edges in
straight lines between centres. The output is technically a graph and
practically unreadable: labels overflow their boxes, arrows cross the boxes they
pass, and the one important path is drawn the same weight as the twelve
unimportant ones. The fix is not a better generator; it is deciding the layout
arithmetic yourself and writing the markup.

Everything below assumes the diagram is an `<svg>` inside an HTML file, drawn in
user units that equal CSS pixels at the intended size.

## Start from the labels, not the boxes

Box geometry is derived from text, so measure the text first. Advance widths for
the same string in the faces you are likely to get without embedding a font, at
14 px:

| label | Arial | Segoe UI | Consolas |
|---|---|---|---|
| `Authentication service v2` | 11.29 em | 11.00 em | 14.29 em |
| `Postgres primary` | 7.71 em | 7.43 em | 9.14 em |
| `TOKEN CACHE` | 7.14 em | 6.50 em | 6.29 em |
| `Redis` | 2.57 em | 2.29 em | 2.86 em |

Three things follow, and all three are worth internalising:

- The average for mixed-case prose is about **0.45 em per character**, not the
  0.6 that people guess. A 22-character label is 139 px at 14 px, not 185 px.
- Capitals and wide letters break that average badly. `TOKEN CACHE` averages
  0.65 em per character, and a single `W` is 0.93 em. Labels written in caps for
  emphasis need a wider box than the same words in sentence case.
- A monospaced face is **0.572 em per character exactly** (measured: 11
  characters at 14 px = 88 px), which makes it the one case where estimating
  from the character count is honest — and the reason a code-shaped label
  (`GET /v1/token`) fits predictably while a prose label does not.

So: box width = longest label's measured em width × font size + 2 × padding,
with padding at least 0.85 em so the text never touches the border. At 13 px,
`Postgres primary` measures 100 px and needs a 128 px box with 14 px of padding
each side. A 120 px box would clip the last letter, and the clipping is the kind
of thing nobody notices until the screenshot is in a slide.

Vertical centring is arithmetic too. The metrics reported by the font at 14 px
are ascent 13, descent 3, so the em box is 16 px tall and the baseline sits
(13 − 3) / 2 = 5 px below the vertical centre — 0.357 em. Put the text baseline
at `cy + 0.35em`, not at `cy`. `dominant-baseline="middle"` exists and mostly
works, but it is one more thing that can differ between the browser and whatever
rasterises the file later; the offset does not.

## The layout grid

Pick a column count before drawing anything. Four columns and a band per layer
handles most services; three columns is enough for a request path.

```
x(i) = margin + i * (column_width + gutter)
y(j) = margin + j * (box_height + row_gap)
```

With `margin = 32`, `column_width = 180`, `gutter = 56`, the left edges are 32,
268, 504, 740 — a 772 px canvas plus the right margin. Writing these numbers
down once and reusing them means every box in a column really is aligned;
eyeballing `x="500"` and `x="505"` produces the two-pixel stagger that makes a
hand-drawn diagram look sloppy.

If the content does not fit the grid, change the grid, not the nodes. One
oversized label is a reason to widen a column for everyone.

## Layer the drawing

Draw in this order, and the diagram stops having the usual z-order accidents:

1. **Bands** — the coloured rectangle behind a group, with a rotated or
   top-left title. Fill only, no stroke, or a hairline that the boxes sit on.
2. **Edges** — all of them, before any box.
3. **Boxes** — opaque fill. Because they are painted after the edges, a line
   that runs under a box is hidden by it, and you never have to compute exactly
   where a line should stop.
4. **Labels** — last, so nothing covers them.

The arrowhead then has to land on the box border rather than under it. Give each
box four named ports (`left`, `right`, `top`, `bottom`) at the middle of each
edge and route between ports. That is the whole trick: an edge drawn from
`right(x)` of one box to `left(x)` of the next is horizontal and needs no
special case, and one drawn to `top` of a box below is vertical.

## Orthogonal routing that stays readable

Two shapes cover almost everything: H-V-H (out of a side, across, into a side)
and V-H-V (out of a top, across, into a top). For the first, put the turn at the
midpoint between the two ports:

```python
def elbow(x1, y1, x2, y2, r=10):
    """H-V-H path from (x1,y1) to (x2,y2) with rounded corners."""
    mx = (x1 + x2) / 2
    r = min(r, abs(y2 - y1) / 2, abs(x2 - x1) / 2)
    s = 1 if y2 > y1 else -1
    return (f"M{x1},{y1} H{mx - r} "
            f"Q{mx},{y1} {mx},{y1 + s * r} "
            f"V{y2 - s * r} "
            f"Q{mx},{y2} {mx + r},{y2} H{x2}")
```

The clamp on `r` is not defensive decoration. If the radius exceeds half the
vertical run, the two corner curves overlap, the path doubles back on itself,
and you get a loop where a corner should be — with a stroke width of 2 it reads
as a smudge. Half the shorter segment is the geometric limit; half of it again
looks right.

Rules that keep the routing legible:

- **Parallel edges need separate lanes.** Two edges leaving the same port
  overlap exactly. Offset the second by 12 px in the perpendicular direction and
  give each its own mid-point.
- **Crossings are acceptable, junctions are not.** An edge crossing another at
  90° reads fine; two edges merging into the same pixel reads as one edge.
- **Never route through a box.** Since boxes are opaque, a line passing under
  one looks like it terminates; the reader will believe the connection is
  missing. Route in the gutter.
- **Label the edges that matter, in the gutter, on a background patch.** An edge
  label that sits on the line is unreadable; put a small opaque rect behind the
  text, or offset the text 6 px above the line.

## Arrowheads that survive scaling

Define one marker and reuse it. The trap is `markerUnits`, whose default is
`strokeWidth`: with `markerWidth="6"` and a 3 px stroke, the head renders 18
user units wide, so a diagram that thickens one edge for emphasis gets an
oversized arrow on exactly that edge.

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse">
    <path d="M1,1 L9,5 L1,9" fill="none" stroke="#8a93a6"
          stroke-width="1.4" stroke-linecap="round"/>
  </marker>
</defs>
<path d="..." fill="none" stroke="#8a93a6" stroke-width="1.5"
      marker-end="url(#arrow)"/>
```

- `markerUnits="userSpaceOnUse"` fixes the head size against the canvas, so it
  scales with the diagram and not with the stroke.
- `refX` is the point of the marker placed at the path end. With a 10-unit
  viewBox and the tip at x=9, `refX="9"` puts the tip exactly on the path's last
  point. `refX="0"` leaves the head hanging past it, over the box border.
- `orient="auto-start-reverse"` means one marker serves both ends; `marker-end`
  and `marker-start` then point outward correctly.
- Draw the head as an open chevron rather than a filled triangle. At 1.5 px
  stroke the chevron stays crisp when the SVG is scaled up; a filled 10-unit
  triangle turns into a blob.

## Text that does not overflow

Three separate failure modes, three separate fixes.

**Too long for the box.** Wrap at word boundaries using measured widths, and
cap at two lines — a third line means the label should be shorter or the box
wider. Do not use `textLength` to squeeze: `textLength` with
`lengthAdjust="spacingAndGlyphs"` compresses the glyphs themselves and produces
text whose weight no longer matches every other label in the diagram. If the
label must fit, change the label.

**Centred text drifting out of a narrow box.** `text-anchor="middle"` is right,
but it centres on the `x` you gave it; if the box visual is a rounded rect from
`x` to `x + w`, the anchor belongs at `x + w/2`, not at `x + w/2 - 1`.

**Unexpected width from an unexpected font.** A font stack that ends in a
generic family resolves differently on another machine, and `Consolas` is 27%
wider than `Arial` for the same label. Either embed the face (a data URI in the
`@font-face`, which also makes the file standalone) or use a stack whose
members are metrically close — and check the widest label in the widest
candidate.

## Type and colour

- One size for box labels, one smaller size for band titles and edge labels. Two
  sizes total. Emphasis comes from weight and colour, not from a third size.
- Keep the type dark-on-light or light-on-dark throughout; a diagram that
  switches halfway looks like two diagrams.
- If the page defines colours as CSS custom properties, the `<svg>` inline in
  that page inherits them — and the moment someone saves the bare `.svg` and
  opens it alone, every `var(--x)` resolves to nothing and the diagram goes
  black. Either keep the colours literal in the SVG, or export from the page
  with the values resolved.
- Contrast: a 12% tint behind a band is enough to group, and light enough that
  the box borders still read. Two tints at 12% and 24% are distinguishable; 12%
  and 15% are not.

## Checking it before anyone looks at it

Without a renderer, the arithmetic is checkable, and the arithmetic is where
most of the bugs are. Keep the layout numbers in a small table and assert
against them:

```python
EM = {"Arial": 0.46, "Segoe UI": 0.45}          # conservative mixed-case average
def fits(label, font_size, box_width, padding, em=0.46, caps=1.15):
    factor = em * (caps if label.isupper() else 1.0)
    return len(label) * factor * font_size + 2 * padding <= box_width
```

Then check the three things the eye catches first: no box overlaps another, no
label's estimated width exceeds its box, every path's `d` starts and ends at a
declared port. When a browser is available, `getComputedTextLength()` on each
`<text>` gives the real number and closes the gap between the estimate and the
font.

Finally, look at it at the size it will be seen: 100% in the page, and as a
200 px-wide thumbnail. A diagram that only works at 1400 px is a diagram that
will be pasted into a slide at 600 px and become noise. If the thumbnail is
unreadable, cut nodes, not font size.

## Where this goes wrong

- Sizing boxes from a character count at 0.6 em, then discovering that the
  longest label is in caps and overflows by 30%.
- Thickening one edge for emphasis and getting a triple-size arrowhead, because
  the marker was sized in stroke widths.
- Drawing arrows on top of boxes, so the reader cannot tell where a connection
  actually lands.
- Two edges leaving the same port and running on top of each other for 200 px,
  reading as a single connection.
- Scaling the whole diagram with `transform="scale(0.7)"` on a group: the
  strokes and the type scale together, so the 12 px labels become 8.4 px and the
  hairlines disappear. Change the viewBox or re-lay it out.
- Letting a text block sit at `y = cy` and calling it centred when the baseline
  puts it visibly low.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
