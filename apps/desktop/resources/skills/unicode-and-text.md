---
name: unicode-and-text
description: handling user text, filenames, or any string that may not be ASCII
---

# Text is not a sequence of characters

"A character" is at least four different things, and the bug is always that the
code meant one of them and used another.

## The four layers

1. **Bytes** — what is on disk, on the wire, in the database.
2. **Code units** — the fixed-width pieces of a particular encoding. UTF-8 uses
   8-bit units, UTF-16 uses 16-bit units, and every string in a language like
   JavaScript, Java, or C# is a sequence of these.
3. **Code points** — the abstract characters the standard numbers. One code point
   may be several code units: an emoji outside the basic plane is two UTF-16
   units.
4. **Grapheme clusters** — what a person sees as one character. A family emoji is
   one cluster, several code points, and many code units.

**`.length` almost always gives layer 2**, which is the one nobody wants. A flag
emoji is two code points; "é" typed one way is two code points and "é" typed
another way is one. Any number you compute from `.length` and show to a user is
wrong for some input.

## Normalization, before anything else

The same visible text can be encoded two ways. Combining marks can be separate or
merged, and that means **two strings that look identical are not equal**.

- **Normalize to one form (NFC is the usual choice) before comparing, storing a
  key, or hashing.** Otherwise a search for a name fails for a user whose
  keyboard produced the other form.
- Do not normalize inside a function that claims to be a comparison of raw
  strings; make the normalization explicit at the boundary where text enters.
- Some filesystems normalize behind your back, so a filename that round-trips on
  one platform may not on another. Never compare filenames as bytes without
  knowing this.

## Indexing, slicing, truncating

- **Never slice by code unit index.** Cutting at an arbitrary index splits a code
  point or a cluster, producing a mangled character or an invalid sequence.
- **Never truncate by bytes.** A byte limit cuts in the middle of a multi-byte
  sequence, and the result may not even be valid text. Truncate by clusters, and
  know what your language's facilities actually count.
- Reversing a string by index breaks clusters, and produces nonsense for anything
  combining or joined. Where the result matters, reverse by cluster.
- A substring match can split a cluster too. Where you highlight or wrap, find
  cluster boundaries, not offsets.

## Case, and why it is not simple

- **Lowercasing is locale-dependent.** Some languages have letter pairs whose case
  mapping differs by locale; uppercasing the wrong way turns one letter into a
  different one with a different meaning.
- Some characters have no single-character case mapping, so a length-preserving
  case conversion is not guaranteed.
- Case **folding** — for comparing without regard to case — is a different
  operation from lowercasing. Use a fold for comparisons, and say which one you
  are doing.
- Sorting is also locale-dependent: compare with the locale's collation, not by
  code point, or the order will look arbitrary to the reader.

## Where text and bytes meet

Name the boundary explicitly, and convert there: a file path, a filename, a
database column, an HTTP header, a command-line argument, a terminal, a log file.

- **Do not assume the default encoding is UTF-8.** Many Windows APIs and files are
  UTF-16, many consoles are legacy code pages, and a legacy code page is not
  Unicode at all — some characters simply cannot be represented in it.
- A path or a filename that arrives from the OS may not round-trip through your
  string type. On Windows in particular, a filesystem name is not guaranteed to be
  valid Unicode in the way your language expects.
- **Never write text through an API that takes bytes without stating the
  encoding.** The default will be platform-dependent and wrong somewhere.

## Invalid input

- Decide, once, what happens to a byte sequence that is not valid in the expected
  encoding: **reject it** with an error, or **replace** the bad part. Never let a
  conversion silently drop characters.
- Silent dropping is the worst option because it corrupts data that looks fine
  afterwards, and it is undetectable in a diff.
- Where the data comes from outside — a file, a network message — validate at the
  boundary and record what was rejected, rather than mangling it inward.

## The little things that break

- **A byte order mark** at the start of a UTF-8 file becomes an invisible
  character in the first field, and breaks parsers and comparisons. Write without
  one unless the format requires it, and strip it when reading.
- **Zero-width and formatting characters** are invisible but present, and break
  names, matching, and length limits. Where they matter, strip them at the
  boundary.
- Newline conventions differ by platform, and a mixed file is a diff that shows
  every line as changed.
- **Trimming whitespace is not trimming invisible characters.** What "whitespace"
  means differs by language and version, and it includes or excludes things
  people expect it not to.

## Test the text you did not type

Include, at least: an emoji with a modifier, a combining sequence, a
right-to-left string, a CJK string, a string with a byte order mark, and a string
that exceeds whatever limit the code applies. If any of those appear in a
filename or an identifier, test that path too — that is where the failures are,
and they are always the same few cases.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
