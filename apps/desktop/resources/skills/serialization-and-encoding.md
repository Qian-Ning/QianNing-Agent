---
name: serialization-and-encoding
description: defining or changing a wire format, a persisted record, or an encoding
---

# Serialization and encoding

A serialized form is a contract with every version of your program that will ever
read it, including the ones already installed. Treat it that way and the
surprises become arithmetic.

## The round-trip test, first

**Serialize a value, parse it back, compare.** Do that for every shape, and the
majority of format bugs appear immediately.

It catches the field you forgot to write, the one you write but do not read, the
precision lost in the middle, the map that came back reordered, the value that
arrived as a string the second time. It is three lines of test and it finds more
than any review.

## Types that do not survive the trip

- **Integers larger than 2^53 do not survive JSON.** Most parsers turn every
  number into a float, and an identifier that looked fine is now off by some
  amount nobody will notice until it is a wrong record. Send large integers as
  strings, deliberately, and say so in the format's documentation.
- **Decimals do not survive either.** Once it is a float in the middle, it is
  approximate forever. Money and precise measurements travel as strings or as
  integers in a stated unit.
- **Dates**: define the format and the zone, and never rely on a parser guessing.
  An unzoned timestamp is a question, not a value.
- **Absent, null, and empty** are three different things, and a format may map two
  of them together. Decide which of the three your format can represent, and say
  what happens to the others.
- **Maps with non-string keys**, sets, binary blobs, and references between
  records do not exist in most text formats. Each needs a stated convention, and
  each convention is a place a later reader will guess wrong.
- **Enums** travel as their numeric value in some serializers, which means
  reordering the enum silently changes the data.

## Changing a format

- **Adding an optional field is safe** only if every reader ignores what it does
  not know. Make that a rule of the format rather than a hope.
- **Renaming a field is a breaking change**, even if the code renames too. The
  name on the wire is the interface.
- **Removing a field** breaks every reader that still expects it. Deprecate it,
  keep writing it for a version, then remove — the same discipline as any other
  contract.
- **A field that changes meaning while keeping its name** is the worst kind of
  change, because nothing in the shape warns the reader.
- **If your program parses and re-serializes**, it must preserve fields it does
  not understand. A proxy or a formatter that drops unknown fields destroys data
  it never looked at, and the loss is invisible until someone needs that field.

## Determinism

- **Two equal values should serialize identically** if anything downstream
  depends on that: a signature, a hash, a cache key, a diff.
- Map ordering is the usual culprit. Some serializers sort keys; some preserve
  insertion order, which differs between equivalent inputs. **Sort explicitly**
  when determinism is required.
- Float formatting differs between implementations and versions, so a hash over a
  serialized float is not stable across them. Normalize before hashing.
- Where you sign or hash a serialized form, pin the serialization rules in the
  contract. Otherwise a dependency upgrade invalidates every signature, and it
  looks like corruption.

## Size, depth, and untrusted input

- **A parser is an attack surface.** Recursive structures can exhaust the stack;
  a length prefix can claim more memory than exists; a nested document can be
  deeper than any legitimate use.
- Set limits explicitly — maximum depth, maximum size, maximum number of items —
  and reject beyond them rather than attempting to cope.
- **Never read a length field from untrusted input and allocate on it** without
  checking it against the actual remaining bytes.
- Binary formats need all of this plus bounds checking on every read, and reading
  past the end must be an error rather than a default value.

## Binary formats, when you must

- **Endianness** is part of the format. State it, implement it, and test on a
  second architecture if the program can run on one.
- **Alignment and padding** differ between compilers and platforms. Never write a
  struct's memory directly as a wire format; write field by field, in a stated
  order, with a stated width.
- **Version the layout**, and add a length or a tag so a new field can be added
  without breaking old readers.
- **Never hand-roll a parser for a format you did not invent.** Use a library, and
  the twenty-line rule does not apply here — this is the category where the edge
  cases were discovered by other people's outages.

## Encoding is three different things

Keep these separate, because conflating them produces bugs at the seams:

1. **Character encoding** — how text becomes bytes.
2. **Compression** — how bytes get smaller.
3. **Encryption** — how bytes become unreadable.

Compression and encryption both change the bytes, so a format that assumes it can
inspect its own payload stops working once either is applied. Decide which layers
exist, in which order, and where the boundary is.

## Testing a format

- **A fixture of real bytes**, checked into the repository, parsed by the reader.
  Round-tripping through your own writer only tests the two halves against each
  other, and both halves can be consistently wrong.
- A file produced by an **older version** of the program, kept forever as a test
  case. That is the only way to know the compatibility claim is true.
- The edge shapes: an empty collection, a missing optional field, a null where a
  value is expected, a maximum-size integer, text with a non-ASCII character and
  with a newline inside it.
- A refused input: truncated bytes, a wrong length, a deeply nested document.
  These should be errors with clear causes, not defaults and not crashes.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
