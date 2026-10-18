---
name: docx
description: a Word document has to be created, read, or edited in place and must still open cleanly afterwards
---

# Editing Word documents without wrecking them

A `.docx` is a zip of XML parts. The visible text is a stream of runs inside
paragraphs inside a body, and the formatting is carried by references to style
definitions that live in a different part. Every tool that promises to "just
replace the text" is quietly making a decision about those references on your
behalf, and the file still opens either way — which is why the damage is usually
found by the person who receives it.

## What is actually in the file

```bash
unzip -l report.docx | head -20
```

The parts that matter:

- `word/document.xml` — the body: paragraphs, tables, and the section properties.
- `word/styles.xml` — every named style, plus the document defaults.
- `word/numbering.xml` — the list definitions the bullets point at.
- `word/header1.xml`, `word/footer1.xml`, `word/footnotes.xml` — separate stories,
  not part of the body text.
- `word/media/` — images. `word/embeddings/` — embedded objects you cannot read.
- `[Content_Types].xml` and the `_rels/` parts — the wiring. Break these and the
  application offers to repair the file.

Text is not stored per paragraph. The unit is the run: `w:p` contains `w:r`,
which contains `w:t`. One sentence with one bold word is three runs, and a
spell-check or a tracked change can split it further.

```bash
unzip -p report.docx word/document.xml | grep -o '<w:t[ >]' | wc -l
```

A paragraph that reads as one line to a human is often four or five `w:t`
elements. That number is the reason naive string replacement fails.

## Creating one with real styles

Use the style system, not direct formatting. A paragraph that merely looks like a
heading is invisible to the navigation pane, the table of contents, and every
downstream converter.

```python
from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.shared import Pt, Cm

doc = Document()
normal = doc.styles["Normal"]
normal.font.name = "Calibri"
normal.font.size = Pt(10.5)

body = doc.styles.add_style("Report Body", WD_STYLE_TYPE.PARAGRAPH)
body.base_style = normal
body.paragraph_format.space_after = Pt(6)
body.paragraph_format.line_spacing = 1.15

section = doc.sections[0]
section.page_width = Cm(21.0)   # A4; the default template is 8.5 x 11 in
section.page_height = Cm(29.7)
section.left_margin = section.right_margin = Cm(2.5)

doc.add_heading("Quarterly report", level=1)
doc.add_paragraph("Revenue grew 8% against a flat headcount.", style="Report Body")
table = doc.add_table(rows=3, cols=3, style="Table Grid")
table.cell(0, 0).text = "Region"
doc.save("report.docx")
```

- The default template carries styles named `Heading 1` through `Heading 9` and
  about a hundred table styles including `Table Grid`; check
  `[s.name for s in doc.styles if s.type == WD_STYLE_TYPE.TABLE]` rather than
  guessing a name, because an unknown style name raises `KeyError`.
- The default page is Letter (8.5 × 11 in, verified on the bundled template).
  Set the page size and margins explicitly when the document is going anywhere
  that expects A4.
- A style's font is the default for runs in that style; a run with direct
  formatting overrides it. Consistency comes from not setting direct formatting,
  not from setting it everywhere.

## Reading text and tables

`doc.paragraphs` returns body-level paragraphs only. Table content is not in it,
and neither is anything in a header, footer, footnote, comment, or text box.

```python
from docx.table import Table
from docx.text.paragraph import Paragraph

for block in doc.iter_inner_content():          # python-docx >= 1.1
    if isinstance(block, Paragraph):
        print(block.style.name, block.text)
    elif isinstance(block, Table):
        for row in block.rows:
            print(" | ".join(cell.text for cell in row.cells))
```

`iter_inner_content()` is the only correct way to get document order. The older
workaround — walk `doc.element.body` and dispatch on the tag name — works, but
you have to remember that `sectPr` is also a child, so the loop sees four body
children for the three blocks above.

On a test document with a heading, a paragraph, a table, and a closing
paragraph, `doc.paragraphs` returned three items and silently dropped the table.
That is the bug you will ship if you summarize without checking.

`.text` also skips content it does not model. Verified cases:

- text inside `w:ins` (an unaccepted tracked insertion) — a paragraph reading
  "The report is due on Friday next week" in the editor returns
  `"The report is due  next week."`, with the inserted words gone;
- `w:del` content, which lives in `w:delText` and is correctly absent;
- field results (`w:fldSimple`, and the result runs of a complex field), so page
  numbers, cross-references, and a generated table of contents read as empty.

So a document under review, or one with fields, extracts as a text that no human
would recognize. Check before trusting the extraction:

```bash
unzip -p report.docx word/document.xml | grep -c '<w:ins '
unzip -p report.docx word/document.xml | grep -c '<w:del '
```

Decide explicitly what those changes mean: accept them, reject them, or report
that the document is mid-edit and the text is provisional.

## Editing without destroying the formatting

There are three levels, and they fail differently.

**1. Paragraph level.** `paragraph.text = "new"` replaces every run with a single
unformatted one. Verified: a paragraph with plain, bold, and plain runs comes back
as one run with `bold=None`. The paragraph style survives, the character
formatting inside it does not. Fine for a placeholder, fatal for a contract.

**2. Run level.** `run.text = "new"` keeps that run's character formatting — and
deletes everything else in the run. Verified: a run holding `before`, a line
break, and `after` loses the break; the same is true of tabs, footnote
references, and inline drawings. Only use it on a run whose children are exactly
`w:rPr` plus one `w:t`.

**3. Across runs.** This is what "replace this sentence" actually needs, because
the sentence is split. Put the new text in the first run that overlaps the match,
trim the head of the first and the tail of the last, blank the runs in between:

```python
from docx.oxml.ns import qn

def text_only(run):
    return [c.tag for c in run._r if c.tag != qn("w:rPr")] == [qn("w:t")]

def replace_in_paragraph(p, old, new):
    """Replace across run boundaries; the new text takes the first run's format."""
    runs = [r for r in p.runs if text_only(r)]
    text = "".join(r.text for r in runs)
    if old not in text:
        return False
    start, end = text.index(old), text.index(old) + len(old)
    pos, placed = 0, False
    for run in runs:
        r_start, r_end = pos, pos + len(run.text)
        pos = r_end
        if r_end <= start or r_start >= end:
            continue
        head = run.text[: start - r_start] if r_start < start else ""
        tail = run.text[end - r_start:] if r_end > end else ""
        run.text = head + ("" if placed else new) + tail
        placed = True
    return placed
```

It returns `False` rather than silently doing nothing when the target is not
present, which is the difference between a failed edit and a file that looks
edited. Two consequences to state in the change description: the result carries
the first run's formatting (a replacement spanning a bold word comes out bold),
and the emptied runs stay behind as zero-length elements — harmless, but visible
in a diff of the XML.

Anything that is not a run is not covered by this. A phrase inside a content
control (`w:sdt`), a text box, or a field cannot be reached this way; edit those
by their own API or not at all.

## The traps, in the order they bite

**String surgery on `document.xml`.** Unzip, `sed` the sentence, re-zip. It fails
for three separate reasons: the sentence spans several `w:t` elements (verified:
three elements for one mixed-format line, and the complete sentence does not
appear anywhere in the XML); the new text must be XML-escaped (`&`, `<`, `>`);
and the re-zip must preserve every part and the `[Content_Types].xml` entry, or
the application reports a corrupt file. If the replacement genuinely lands inside
one `w:t`, unzip to a directory, edit, and re-zip from inside that directory so
the archive root is correct — but understand that you are one encoding mistake
from a repair prompt.

**Revision marks.** A document with tracked changes carries two versions of the
text. Extraction shows one of them, and not the one the author sees. Before
summarizing, count `w:ins` and `w:del`; before editing, decide whether to accept
them first, because an edit to a paragraph with pending changes produces a third
state nobody asked for.

**Element order inside `w:pPr`.** The schema fixes the order of paragraph
properties (style, then keep-next, then spacing, and so on). Appending a property
at the end of `pPr` produces a file that some readers accept and others repair.
Use the library's typed accessors (`p.paragraph_format.space_after`) rather than
inserting XML by hand; when you must insert, check the sequence in the schema
first.

**Embedded objects.** `word/embeddings/` holds OLE objects: a spreadsheet, a
diagram, a signature block. The library preserves the part and cannot read it,
and replacing the document's text does not touch it. If the embedded object
contains the number you were asked to change, the change did not happen.

**Legacy `.doc`.** Not a zip; `Document("old.doc")` raises
`PackageNotFoundError`. Convert first with an office suite, and check the result
— the conversion rewrites layout and often loses tracked changes.

**Metadata.** `doc.core_properties` carries author, last-modified-by, company,
and revision history. It travels with the file. Clear it before sending a
document outside the organization, and check the same properties on any template
you build from.

## Checking the result

Cheap checks, in order:

```python
from docx import Document
d = Document("out.docx")
print(len(d.paragraphs), len(d.tables), len(d.sections))
print(d.paragraphs[3].text)
```

Then re-extract the full text and diff it against what you expected — including
the parts `.text` skips, which is why the check should count tables and search
`word/document.xml` for the strings you inserted. Finally, open it once in a real
editor. The library writes valid XML; it cannot tell you that the heading now
sits on its own page.

## Where this goes wrong

- Summarizing `doc.paragraphs` and reporting the document as read, with every
  table and every tracked insertion missing from the summary.
- Replacing a paragraph's text to change one number, and flattening the bold,
  the footnote, and the hyperlink in the same stroke.
- Running a literal find-and-replace over the unzipped XML and calling the result
  an edit, when the phrase was split across runs and the replacement matched a
  prefix.
- Editing a document that still has unaccepted revisions, then wondering why the
  recipient sees text you never wrote.
- Forgetting that the file carries its author's name.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
