---
name: naming-and-terminology
description: naming something, or keeping vocabulary consistent across a codebase
---

# Naming and terminology

Names are the interface between the code and everyone who reads it, including
you in six months. Two rules carry most of the value:

**One concept, one word. One word, one concept.**

Break either and every reader has to hold two mappings in their head, and has to
guess which one this file means.

## A name that needs a comment is not finished

If the name requires an explanation next to it, the explanation belongs in the
name, or the thing is doing two jobs and needs to be split.

- `getUser`, not `queryDatabaseForUserRow` — name the intent, not the mechanism.
  The mechanism changes; the intent is what callers depend on.
- A name that describes **how** becomes a lie the day the implementation changes
  and nobody renames it. This is the most expensive kind of stale name, because
  it is confidently wrong.

## Length is about distance

A variable's name has to carry as much as its scope is wide.

- Inside a three-line loop, `i` and `x` are fine; the reader has everything.
- A field read in another file must say what it is without that context.
- A public function's name is read by people who never open it, so it carries the
  most. Include the unit, the shape, and what it returns: `timeoutMs`,
  `parseConfigFile`, `errorsByField`.
- **Units belong in the name.** `timeout` is a guess someone will get wrong;
  `timeoutMs` is not.

## Names that quietly mislead

- **Booleans read as statements**: `isEnabled`, `hasAccess`, `canRetry`. Not
  `flag`, `status`, or `option`.
- **Negations are traps**: `isNotDisabled` and `disableX = false` require a double
  negation at the point of use, and one of them will be read wrong. Prefer the
  positive and invert at the boundary.
- **Collections are plural**, singletons are not. `user` and `users` being
  interchangeable is a bug waiting for a loop.
- **Functions that do more than one thing cannot be named** — the naming failure
  is usually a design problem wearing a naming costume. If you cannot find the
  name, read the function again and see whether it is two.
- **Never reuse a name for a different concept across layers.** If the interface
  calls it a project and the database calls it a workspace and the user interface
  calls it a folder, every reader has to learn three words for one thing —
  and the day two of them actually differ, the confusion becomes a defect.

## The words that say nothing

`data`, `info`, `manager`, `helper`, `util`, `process`, `handle`, `service`,
`thing`, `stuff`. They are not names; they are placeholders that survived.

- A `manager` usually owns nothing and coordinates everything. Name it after what
  it actually does.
- A `utils` module is a signal that the concepts inside have not been identified.
  Split it by what the functions are about.
- `handle` and `process` describe neither the input nor the result. Name the
  transformation.

## Keep a glossary, and use its words

- Write the domain terms down, with a one-line definition and, where useful, what
  the term is **not**. The second half is what prevents the argument.
- The code uses the glossary's words. A glossary nobody follows is worse than
  none, because it looks authoritative.
- Where a term is ambiguous in the domain, pick one meaning and ban the other in
  the code. Two teams arguing about the same word is a translation layer nobody
  asked for.
- The **user interface uses the user's words**, not the schema's. A user does not
  have a "workspace record"; they have a project, and it has a name. When the two
  vocabularies must differ, know which one the visible text uses and be
  consistent.

## Renaming

- **Rename sooner than feels comfortable.** The cost is proportional to how many
  places reference it, and it is monotonic.
- **Never mix a rename into a behavior-change commit.** A rename touches
  everything and hides everything. Keep it separate so the real change can be
  read.
- When renaming across layers or persisted data, the old name may live in a
  database, a transcript, or a saved file. Decide the migration deliberately
  rather than breaking the reader of the old format.
- Rename in the glossary at the same time as the code, or the glossary becomes the
  stale thing.

## Before you keep a name

- **Would a newcomer guess where to look from this name alone?** If not, the name
  is either too vague or the responsibility is unclear.
- **Does it say what it is, and not how it works?**
- **Is this concept already named somewhere in the project?** Use that word.
- **Would the sentence "the name is wrong" be fixable in one place?** If not, the
  problem is the structure.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
