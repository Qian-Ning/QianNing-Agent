---
name: localization-and-i18n
description: user-visible text is being added, or a locale file is being edited
---

# Localizing user-visible text

Most localization bugs are not bad translations. They are strings assembled by
code in a way that no language can survive.

## Every user-visible string goes through the mechanism

Labels, buttons, placeholders, menus, notifications, empty states, error
messages, `title`, and `aria-*` attributes. No literals in the markup, however
temporary they feel.

- Decide one convention for keys and keep it: either a **stable identifier**
  (`settings.autosave.label`) or **the source-language string as the key**. Both
  work; mixing them does not, because a change to the English text then silently
  creates a new key in one system and edits the source in the other.
- A key is an identifier, not documentation. Do not encode the English wording
  in an identifier-style key — the text will change and the key will lie.
- Deleting a string means deleting its key from every locale, not just the one
  you are looking at. The leftovers are found a year later.

## Never build a sentence from parts

Concatenation is the single most common localization defect.

- Word order differs. `"Delete " + name + "?"` is wrong in any language that puts
  the object elsewhere.
- Grammatical agreement differs. The article, the adjective, and the verb may all
  need to change with the noun.
- Punctuation and spacing differ: French puts a space before `?`, Japanese uses
  different brackets, Spanish opens a question with `¿`.
- A sentence split across two keys is worse: the translator sees two fragments
  with no way to know what they join into.

Use **interpolation with named placeholders** — `{{name}}` in this project — so
the whole sentence lives in one string and the translator controls the order.

Never reorder or reuse a placeholder mismatched with its meaning. If a locale
uses a placeholder the source does not provide, the string renders with a hole
in it, in production, in that language only.

## Plurals are not addition

`count + " items"` is wrong in most languages, and not only in the trivial way.

- Languages have different plural categories: some have two, some have three or
  four, Arabic has six, and some (Japanese, Korean, Chinese) have one, with no
  plural marking at all.
- The rule is about the number: 0, 1, 2, and 5 may each fall into different
  categories, and the categories are not "singular and plural".
- Use the platform's plural mechanism with the count passed in, never a manual
  `count === 1 ? a : b`.

## Gender and agreement

In languages with grammatical gender, a sentence about a person can require the
gender of the subject to be known, and it may change the article, the adjective,
and the pronoun. Where a string refers to a person whose gender is unknown or
irrelevant, prefer phrasing that avoids the agreement entirely, or provide the
variants the translator needs.

## The languages are not the source of truth

- Keep the **source language primary**. Other languages are packs that lag
  behind, and a missing key falls back rather than blocking a release.
- A locale that has drifted badly should be marked as such, rather than
  presented as complete. A half-translated interface reads worse than an
  obviously untranslated one.
- Placeholder text that has been copied from the source language and never
  translated is a defect to report, not a translation. Do not quietly accept it.

## What is never translated

Code identifiers, protocol field names, log strings, commit messages, specs, and
repository documentation stay in the source language. The user interface is
translated; the engineering surface is not.

## Structural checks that catch real bugs

Localization files are data, and data can be checked mechanically — do this
rather than reading them.

- **Key parity**: the same keys exist in every locale, and the set difference in
  both directions is empty.
- **Placeholder parity**: every placeholder in the source appears in each
  translation, and no translation invents one.
- **Pairing**: where the project mirrors documents per language, the mirrored
  paths exist in both directions.
- **Shape**: where a translation mirror contains tabular or structured content,
  the row counts and column counts match the source. A structural mismatch is the
  most common silent break, and it is exactly what a counting check catches and
  reading does not.

## Layout and direction

- **Text length varies** — German and Finnish are longer than English, Chinese
  and Japanese shorter. Design for expansion, and test with a long translation
  rather than only with English.
- **Right-to-left** locales mirror the layout: margins, icons with direction, and
  progress indicators. Not every icon mirrors, and mirroring one that should not
  be is its own bug.
- **Dates, numbers, currency, and sorting** are locale-dependent. `3/4/2026` is
  two different days depending on the reader, and sorting by the raw string is
  wrong in most languages.
- **Fonts**: not every font has every glyph. A missing glyph renders as a box,
  and it appears in the language you tested least.

## Test in the language, not only in the source

- Switch the interface to a non-source locale and exercise the changed screen.
  Translation bugs are invisible in English.
- Use pseudo-localization — a transformed source with added length and brackets
  — to find truncation and untranslated strings before the real translations
  arrive.
- A string that appears untranslated in a locale whose file has the key is a
  wiring bug, not a translation bug. Check the key, not the wording.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
