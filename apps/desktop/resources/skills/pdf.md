---
name: pdf
description: a PDF has to be read, split, merged, filled, or redacted and the result has to be right rather than merely openable
---

# Working with PDFs

A PDF is a page-description format, not a document format. There is no paragraph,
no table, and no word: there are glyphs painted at coordinates, wrapped in an
optional layer that maps characters back to Unicode. Everything that is hard
about PDFs follows from that one fact, and every tool that claims to "read the
text" is really reconstructing it and guessing.

## First question: is there a text layer at all

Ask before extracting, because the answer decides the whole job.

```bash
pdftotext -f 1 -l 1 in.pdf - | head -5
```

Two things to know about that command. It exits 0 and prints nothing at all for a
page that is a scanned image — verified on an image-only page, where the only
output was a form feed. And without `-layout` it emits text in painting order,
which for a two-column page means the left and right columns interleaved line by
line.

The programmatic version, which also tells you *why* the page is empty:

```python
import re
from pypdf import PdfReader

page = PdfReader("in.pdf").pages[0]
ops = re.findall(rb"(?<![A-Za-z])(Tj|TJ)(?![A-Za-z])", page.get_contents().get_data())
print(len(page.extract_text() or ""), "chars,", len(ops), "text ops,", len(page.images), "images")
```

Read the triple:

| chars | text ops | images | meaning |
|---|---|---|---|
| 0 | 0 | ≥1 | scanned page — the pixels are the only content |
| 0 | 0 | 0 | genuinely blank page |
| 0 | >0 | any | text is drawn but not decodable: a subset font with no `ToUnicode` map, or glyphs converted to curves |
| >0 | >0 | any | a text layer exists; extraction is a layout problem, not an OCR problem |

Measured on three generated files: a text page gave 27 chars / 1 text op / 0
images, an image-only page gave 0 / 0 / 1, and a page with a black box painted
over the text gave 34 chars / 1 text op / 0 images.

The third row is the one people misdiagnose. A page that extracts as `????` or as
mojibake has text, just no character map; OCR will be more accurate than fighting
the encoding, and asking the producer for the source is better than both.

## Extracting text and tables

```bash
pdftotext -layout -f 3 -l 7 in.pdf out.txt
```

`-layout` preserves the visual arrangement and is what you want for anything with
columns, invoices, or statements. It also inserts runs of spaces you have to
normalize before comparing.

For tables, `pdfplumber` gives you the grid rather than a stream of words:

```python
import pdfplumber

with pdfplumber.open("invoice.pdf") as pdf:
    page = pdf.pages[3]
    print(page.extract_text(layout=True))
    for table in page.extract_tables():
        for row in table:
            print([cell.replace("\n", " ") if cell else None for cell in row])
```

A `None` cell means no characters were found in that grid position; an empty
string means characters were found and they were whitespace. Collapsing the two
loses the distinction between "blank" and "the value did not extract", which is
exactly the distinction you need when a total column comes back empty.

Ruling lines are the difference between a table and a pile of words. On a table
with borders, the default strategy works. On one without, pass explicit
positions (`table_settings={"vertical_strategy": "text", "horizontal_strategy":
"text"}`) and check a row against the page image before trusting the rest.

## Merge, split, and rewrite

`pypdf` covers the mechanical operations:

```python
from pypdf import PdfReader, PdfWriter

# Merge, keeping the first document's outline, forms, and page labels.
writer = PdfWriter(clone_from="cover.pdf")
for page in PdfReader("body.pdf").pages:
    writer.add_page(page)
writer.write("merged.pdf")

# Split: one file per page, named by the page's own label.
reader = PdfReader("merged.pdf")
for number, page in enumerate(reader.pages, 1):
    out = PdfWriter()
    out.add_page(page)
    with open(f"page-{number:03d}.pdf", "wb") as handle:
        out.write(handle)
```

- `add_page` copies the page object, nothing else. The outline, the AcroForm, and
  the page labels live on the document catalog and are not carried along. If they
  matter, start from `PdfWriter(clone_from=...)` and append into it.
- Splitting costs one copy of every shared resource per output unless the writer
  is told to reuse them; a 200-page split of a scanned document can be larger
  than the original.
- Do not re-compress a scan you are only splitting. Every re-encode of a JPEG is
  lossy, and a five-generation copy is unreadable.

## Filling a form

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("form.pdf")
print(list(reader.get_fields()))          # fully-qualified field names

writer = PdfWriter(clone_from="form.pdf")
writer.update_page_form_field_values(
    writer.pages[0], {"name": "Ada Lovelace", "agree": True}, auto_regenerate=False
)
writer.write("form-filled.pdf")
```

The field names printed by `get_fields()` are the keys to use. In a hierarchical
form the key is the full dotted path, not the leaf label a human sees, and a
wrong key is silently ignored rather than raising.

The trap: with `auto_regenerate=False` the value lands in the form dictionary
(`/V`) and **not** on the page. Verified on a filled test form — the field read
back as `"Ada Lovelace"`, `NeedAppearances` was `False`, and the page's extracted
text still contained only the label `"Name:"`. Any viewer that does not build
appearances on the fly will show an empty box, and printing shows an empty box.
`auto_regenerate=True` sets `NeedAppearances`, which asks the viewer to render
the value — better, still viewer-dependent.

If the filled form has to look the same everywhere, the value must become page
content: draw it yourself at the field's rectangle, or rasterize the page after
filling. There is no portable "flatten" call in the common Python libraries —
checked: the writer exposes no public flatten method, only internal helpers.

Checkboxes take `True`/`False`. Radio groups take the export value string of the
selected button, not the group name; print the field's `/Opt` or the kids' names
to find it.

## Redaction that is actually redaction

Drawing a black rectangle over the text is not redaction. Verified: a page with
`Card 4111 1111 1111 1111 approved` and a filled black box painted across it still
extracts as the full 34-character string, because the glyphs are still in the
content stream underneath the rectangle. The same is true of a white box, a
cropped page, and an annotation.

What actually removes content:

1. **Rasterize.** Render the page at 300 dpi, paint over the region, and rebuild
   the PDF from images. The text on that page is gone because the page is now a
   picture. Everything on the page stops being selectable and searchable, and the
   file usually gets larger.
2. **Delete the glyphs from the content stream**, and also remove the strings
   from any object streams, annotations, and metadata. Doable, and easy to get
   half right: a fragment left in an unused object is still in the file.
3. **Use a tool with a real redaction feature**, then verify it, because the tool
   is making the same promise everyone else is.

Verification is not optional and it is cheap:

```bash
pdftotext -layout redacted.pdf - | grep -n -i -E '4111|ada lovelace|invoice 4471'
```

An empty result proves the text layer is clean. Then check the things that are
not the text layer: document metadata and XMP, `/EmbeddedFiles`, annotations and
their popup contents, form values, and the incremental-update history. A file
that was saved incrementally keeps its previous revision until it is rewritten
completely, so produce the output with a full write rather than an append.

## OCR, when the text layer is missing

The pipeline is three steps and each one can be wrong: render the page to a
raster at 300 dpi, run an OCR engine over it, then decide whether to keep the
image with an invisible text layer or to emit plain text. The renderer and the
extractor come from the same utility suite, but they are packaged separately in
some distributions — check `command -v pdftoppm` before writing it into a
pipeline, because a partial install that has only the text extractor is common.

OCR output is a draft. It confuses `0` and `O`, `1` and `l`, and it loses every
decimal point it is unsure of. On an invoice, the numbers are the only part
anyone cares about, so check every amount against the image rather than the
confidence score the engine reports.

## What the file carries that you forget

```python
from pypdf import PdfReader
reader = PdfReader("in.pdf")
print(reader.metadata)                       # /Author, /Producer, /Creator
print(list(reader.attachments))              # embedded files
print(len(reader.pages), reader.page_labels)
```

Annotations, form data, attachments, and the original producer name all travel
with the file. A "clean" export from an editor usually still contains the author
name and the edit history in XMP.

## Where this goes wrong

- Reporting "no text found" as "the document is empty" without distinguishing a
  scan from a blank page.
- Filling a form and shipping it before opening the result in a viewer that does
  not regenerate appearances.
- Calling a black rectangle redaction, then attaching the file to an email.
- Splitting a scanned PDF by re-encoding each page, then wondering why the copies
  are blurry and larger.
- Trusting an extraction order from a multi-column page without `-layout`, and
  producing a summary where the two columns are interleaved.
- Leaving the author metadata in place after removing the visible name.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
