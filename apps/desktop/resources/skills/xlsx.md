---
name: xlsx
description: a spreadsheet has to be read, aggregated, or written and the numbers, dates, and formulas must survive the trip
---

# Spreadsheets: reading them without lying

A workbook is not a table. It is a grid of cells where the stored value, the
displayed value, and the calculated value are three different things, and every
column carries a format that decides which of the three a reader will see. Most
of the ways this goes wrong are silent: the file opens, the numbers are there,
and they are not the numbers anyone meant.

## Reading a large file without loading it

```python
from openpyxl import load_workbook

workbook = load_workbook("export.xlsx", read_only=True, data_only=True)
sheet = workbook["Data"]
count = 0
for row in sheet.iter_rows(values_only=True):
    count += 1
    if count <= 3:
        print(row)
workbook.close()
```

`read_only=True` streams rows instead of building a cell object per position, and
`values_only=True` skips the object wrapper entirely. For a file with a hundred
thousand rows this is the difference between seconds and an out-of-memory kill.
Two consequences: the cells are lightweight proxies — `has_style` is `False` and
`font`/`fill` return library defaults rather than the file's actual formatting,
so read styling in normal mode if you need it — and cell objects are single-use,
so do not hold a reference to a row after advancing.

`data_only=True` is the bigger decision. It asks for the value the last
application calculated, and if there is none, the answer is `None`. More on that
below, because it is the most common way a "successful" read returns blanks.

**The dimension trap.** In read-only mode the worksheet trusts the `<dimension
ref="...">` element in its XML to know where the data ends. Verified: taking a
four-row sheet, rewriting that element to `A1:A1`, and reopening it read-only
gave `max_row == 1` and iteration stopped after one row — while the same file
opened normally still returned all four. A file from a streaming producer, or one
whose rows were appended by a script that never updated the dimension, truncates
without an error.

```python
sheet.reset_dimensions()      # drop the declared extent; iterate to the real end
```

Verified: after `reset_dimensions()` the same sheet yielded all four rows and
`max_row` became `None`. Use it whenever the row count matters and the file did
not come from a mainstream editor. Then count the rows you actually read and
report that number, not `max_row`.

## Formulas that survive

A formula is a string beginning with `=` written into the cell. The library
stores it; it does not evaluate it, and it does not check it.

```python
sheet["C3"] = "=C2*2"
sheet["D3"] = "=SUM(D2:D2)"
sheet["E3"] = "=VLOOKUP(A3, Lookup!$A:$C, 3, FALSE)"
```

- Nothing validates the reference. A typo becomes `#NAME?` or `#REF!` the first
  time an application opens the file, which may be long after you delivered it.
- Structured references (`Table1[Amount]`) are opaque strings to the library. They
  work if the table exists and is spelled exactly right, and fail at open time if
  not.
- A formula written into a cell whose number format is text is displayed as text.

**The cached-value trap, both directions.** Verified on a generated workbook: a
cell holding `=C2*2` reads back as the string `'=C2*2'` normally, and as `None`
with `data_only=True`, because the writing library left no cached result. And the
reverse: taking a file that carried a cached `<v>2401</v>`, loading and re-saving
it dropped that cached value, after which `data_only=True` returned `None`.

So the rule is: a workbook produced or touched by a script that does not
calculate has no values for value-only readers. Dashboards, importers, and
anything that reads with `data_only=True` will see empty cells where the formulas
are. Choose one:

1. compute in Python, write the numbers, and keep the formulas in a documented
   column or a separate build step;
2. let an application recalculate and save once, and treat that file as the
   published artifact;
3. read formulas deliberately (no `data_only`) and evaluate the ones you need
   yourself, accepting that you now own every function you touch.

Never compare a formula cell to a number and conclude the data is wrong. Check
which of the three values you are looking at first.

## Numbers and dates that stay as typed

The stored value and the displayed value diverge at the format. Two rules:

- **Write the type you mean.** `date(2026, 1, 5)` becomes a serial number with a
  date format applied (verified: it round-trips as a `datetime` with
  `yyyy-mm-dd`). The string `"2026-01-05"` stays a string, sorts alphabetically,
  and is excluded from every date function.
- **Set the format before or with the value** when the display matters:
  `cell.number_format = "0.00%"`, `"#,##0"`, `"yyyy-mm-dd hh:mm"`. A percentage
  stored as `0.085` with a percent format displays as `8.5%`; the same number
  without the format displays as `0.085` and someone will paste it into a slide.

Identifiers are the other half. A part number, an account number, or a postal code
is text even when it is all digits. Assign it as a string and set
`number_format = "@"`, or the leading zero disappears and a 16-digit value loses
its last digit to floating point. Verified: a string `"007"` written by the
library and read back is still the string `"007"` — the conversion happens when a
spreadsheet application imports a CSV, not inside the library. Which is the next
section.

**The date epoch.** Workbooks use either the 1900 or the 1904 date system.
`workbook.epoch` reports which; on a freshly written file it was
`1899-12-30 00:00:00` (the 1900 system, offset for its own historical quirk). Open
a workbook made from a 1904 template and every date is four years off, and the
values still come back as plausible `datetime` objects. Check the epoch once per
file and say which one you assumed.

## Merged cells, hidden rows, and other invisible state

**Merged cells.** The value lives in the top-left cell only. Verified: a merge
over `A4:B4` returns `"merged"` for `A4` and `None` for `B4`, and
`sheet.merged_cells.ranges` lists the range. Iterating rows naively therefore
sees a `None` where a human sees a label repeated down a column, and any group-by
built on that column silently drops the continuation rows. Unmerge a copy of the
sheet, or forward-fill before aggregating, and say which you did.

**Hidden rows and columns.** Hiding affects display, not storage. Verified:
`row_dimensions[2].hidden` and `column_dimensions["D"].hidden` both read back
`True`, and the values in them are still returned by `iter_rows`. If the sheet is
a report where someone hid the detail rows, your total includes them and the
report's total does not. Detect:

```python
hidden_rows = [i for i, d in sheet.row_dimensions.items() if d.hidden]
hidden_cols = [c for c, d in sheet.column_dimensions.items() if d.hidden]
print(hidden_rows[:10], hidden_cols)
```

Filter state is separate and often mistaken for it: an autofilter's `ref` only
says which range has filter controls, not which rows are filtered. The rows are
hidden, so check the dimensions.

**Very hidden sheets.** `sheet.sheet_state` is `"visible"`, `"hidden"`, or
`"veryHidden"`. A very hidden sheet does not appear in the application's unhide
menu, and it is still in the file and readable. If you are summarizing a
workbook, list every sheet with its state rather than iterating the visible ones;
the lookup table everyone forgot about is usually on one of them.

## CSV round-trip damage

CSV has no types, no formats, and no encoding declaration. Everything that was
decided in the spreadsheet is decided again by whoever opens the file.

- **Encoding.** Write UTF-8 with a BOM (`utf-8-sig`) if the file is destined for
  a spreadsheet application on Windows; read with `utf-8-sig` as well, which
  tolerates a missing BOM.
- **Line endings.** Open with `newline=""` when using the `csv` module, or the
  writer's `\r\n` gains an extra `\r` on some platforms and every row doubles.
- **Delimiter and decimal separator.** A comma-delimited file with comma decimals
  is unparseable; exports from much of Europe use `;` and `,`. Sniff, then state
  the delimiter you assumed rather than guessing silently per row.
- **Leading zeros and long identifiers.** `007` becomes `7`, and a 16-digit
  account number becomes `1.23457E+15`. Inside the library a quoted field stays a
  string; the damage happens on import, so the fix has to be in the file:
  quote the value and tell the recipient the column is text. If you control both
  ends, do not use CSV.
- **Formulas.** A field beginning with `=`, `+`, `-`, or `@` is interpreted as a
  formula by many spreadsheet applications when the file is opened. A cell
  containing `=HYPERLINK(...)` from an untrusted source is an execution vector.
  Prefix such values with an apostrophe or a tab when writing, and strip the
  prefix when reading.
- **Dates.** No format travels. Write ISO 8601 and let the reader parse it; do not
  write `05/01/2026` and hope.
- **Quoting.** Commas, quotes, and newlines inside a field must be quoted, and
  quotes doubled (RFC 4180). The `csv` module does this correctly; hand-built
  lines do not, and a field containing a newline silently becomes two rows.

Round-trip check: write the CSV, read it back with the same settings, and compare
the count and a sample of the values that are most likely to be mangled — the
ones with leading zeros, the widest numbers, and the dates.

## Writing a sheet someone can use

- Freeze the header (`sheet.freeze_panes = "A2"`), set column widths, and add an
  autofilter. A sheet without these is a data dump.
- Prefer a real table (`Table` with `TableStyleInfo`) over colored header cells;
  the table survives sorting and is what structured references point at.
- Never merge cells in a data range. Merge in a summary block, never over
  something a formula needs to read.
- Keep one header row, exactly one, with unique names. Duplicate column names
  break every reader that keys by name.

## Where this goes wrong

- Reporting `max_row` as the row count on a read-only sheet with a stale
  dimension, and shipping a summary of the first row.
- Reading with `data_only=True` and reporting zeros or blanks for every formula,
  then concluding the file is empty.
- Aggregating a column that was merged, so every value after the first in each
  group is counted as missing.
- Summing a column that contains hidden rows, and disagreeing with the number at
  the bottom of the report.
- Writing a "date" as a string and a "number" as text, then blaming the reader
  when sorting and filtering do not work.
- Round-tripping through CSV and losing the leading zeros on every product code.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
