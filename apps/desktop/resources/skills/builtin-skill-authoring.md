---
name: builtin-skill-authoring
description: a document will ship inside an assistant and be loaded by a model on demand, so the trigger line and the procedure both have to earn their cost
---

# Writing a document that ships inside an assistant

A shipped skill has two audiences and they pay different prices.

Every session pays for the **name and description** — that line sits in the
catalogue the model sees before it decides anything. Only the session that loads
the document pays for the **body**. So the description is not a summary of the
document; it is the advertisement that decides whether the body is ever read, and
it is billed to everyone whether they use it or not.

Get that backwards and you write a description that reads well to a human
reviewer — "Guidance on release engineering" — which matches no request the model
will ever receive, so the document never loads and the work of writing it is
wasted. Meanwhile it costs context in every unrelated session, forever.

## The description is a trigger, not a summary

Write the situation, in the words the request will actually arrive in.

| written as a summary | written as a trigger |
|---|---|
| "Best practices for release management." | "a release is about to be tagged and the artefact, the tag, and the tested tree have to be proven to be the same thing" |
| "Documentation maintenance." | "code changed and the documentation that describes it has to be checked against the code rather than trusted" |
| "Introduction to spreadsheet handling." | "a spreadsheet has to be read, aggregated, or written and the numbers, dates, and formulas must survive the trip" |

Three properties do the work:

- **It names the moment, not the topic.** "When a tag is about to go out" is a
  moment; "release engineering" is a topic.
- **It names the failure the document prevents.** That is what distinguishes two
  documents that cover adjacent ground, and it is what makes the line useful to a
  model choosing between them.
- **It uses the vocabulary of the request.** If callers say "the numbers came out
  wrong", the line should contain those words, not "numerical fidelity".

Test it before shipping. Write three prompts that *should* load the document and
three that should not, then read the description as if you were choosing. If the
line cannot separate them, it is a summary and it needs rewriting. This is a
two-minute test that catches the most expensive mistake in the genre.

What not to put in a description: a restatement of the title, a promise about
quality ("comprehensive", "expert-level"), or a list of every section. All three
cost tokens in every session and discriminate nothing.

## Budgeting the context cost

Measured on a shipped set of 78 documents: the description lines came to 6,427
characters in total — a median of 68 characters each, the longest at 244 — which
is roughly 1,600 tokens before any skill is loaded. The bodies in the same set had
a median of 5,356 bytes and a maximum of 11,822, loaded one at a time and only on
demand.

Two conclusions follow directly from those numbers:

- The whole catalogue costs about as much as one and a half bodies. That is the
  correct order of magnitude: 78 documents should not cost more to *advertise*
  than a handful cost to read. If the catalogue is approaching the size of the
  library, the descriptions have become summaries.
- The body is nearly free at rest and expensive when loaded, so it should be
  complete rather than short. Do not compress a procedure to save tokens that
  nobody is paying; do not pad it either, because the session that loads it pays
  by the line and a model reading 400 lines of preamble attends less to the
  procedure.

Practical rules: no preamble ("In this document we will…"), no repeated
restatement of the description in the first paragraph, no motivational framing.
Start with the constraint or the procedure.

## Frontmatter that survives a shallow parser

Skill loaders commonly parse frontmatter as flat `key: value` lines rather than
as full YAML, because the format only has two keys and a real parser is a
dependency. That has consequences worth knowing exactly:

- **A folded block does not work.** Writing

  ```
  description: >
    one long trigger line
    that wraps across two source lines
  ```

  to keep the source readable produced, in a loader of that kind, the literal
  string `>` as the description — verified by running the parser on exactly that
  input. The document then advertises `>` as its trigger. Keep the description on
  one line even if your editor wraps it; the source line gets long and that is
  fine.
- **A colon inside the value is safe.** The key ends at the first colon, so
  "when a tag is about to go out: verify it" round-tripped intact (verified).
- **Quotes are stripped.** `description: "quoted: with colon"` came back as
  `quoted: with colon` (verified), which is convenient — but a value that begins
  and ends with a quote character for other reasons will lose them.
- **An empty value is not an error.** A blank description is dropped silently and
  the entry advertises nothing, so the check "does it have a description" is not
  the same as "is the description non-empty after parsing".

Verify the parsed result, not the file. Print what the loader returns and read
it: name, description, first line of the body.

The `name` is an identifier as well as a label. It becomes the id the model calls,
it may appear in stored transcripts, and the id usually derives from the file
name. Treat renaming as a breaking change with a compatibility alias, and never
put a product name in it — the name is a handle, not a surface.

## The shape of a procedure a model can follow

A model follows instructions literally and generalises from examples. That makes
some shapes work and others fail.

**Works:**

- A first paragraph that states the invariant or the failure the procedure
  prevents, in two or three sentences. Everything after it is a consequence.
- Numbered or headed steps in execution order, each starting with a verb and
  naming its output. "Run X and read the number it prints" is followable; "ensure
  the version is correct" is not.
- Concrete commands, paths, flags, and thresholds. `` git rev-parse v1.0.0^{commit} ``
  is usable; "resolve the tag" is a summary of a step, not a step.
- Reasons attached to rules, in the same sentence or the next one. A rule with a
  reason generalises correctly to the case the document did not cover. A rule
  without one gets over-applied or ignored.
- Decision points stated as conditions with both branches: "if the tree is dirty,
  stop; if only generated files changed, rebuild and compare".
- A closing section of the mistakes people actually make, phrased as symptoms
  ("the archive listing includes directories, so the count overstates the files")
  rather than as warnings.
- Measured numbers, with the thing that produced them named, so the reader can
  reproduce or contradict them.

**Fails:**

- Adverbs standing in for procedure: "carefully", "appropriately", "as needed".
- Rules with no reason, which the model applies to cases the author never
  considered.
- Unstated prerequisites — the step that assumes a tool is installed, or that a
  previous section ran.
- Examples that do not run, or that reference a fictional API with no note that
  it is illustrative.
- Restating the same rule in four sections, which reads as four rules and gets
  four different treatments.
- Hedging everywhere ("generally", "usually", "may"), which leaves no default
  action; state the rule and name the exception.

Length follows from content. The documents that carry their weight in this genre
run 100–250 lines: enough for a real procedure with its failure modes, not enough
to become a book the model skims. If a section could be deleted without changing
what a reader does, delete it.

## A guard you have never watched fail is not a guard

Every check a document tells someone to run should have been seen failing, once,
on purpose. Until then it is a sentence that produces a reassuring exit code.

Concrete cases, all cheap:

- A checker that greps for a section heading passes a document whose heading is
  there and empty. Verified against a provenance checker: the empty-section case
  needed its own assertion on the error message, because the presence check alone
  accepted it.
- A test command that globs to zero files exits 0. Break one input and confirm the
  suite goes red before you put the command in a document.
- A drift check whose regex matches nothing passes on every tree. Add the stale
  reference yourself and watch it report.
- A "must not contain the product name" rule passes trivially when the scan scope
  is wrong — the file is outside the directory the checker walks, and the count it
  prints is the only clue. Count what was scanned and compare it with what you
  expect.

The same discipline applies to the document's own instructions. If the body says
"run the gate", run it and paste the line it printed into your head, then ask
whether the number is the one you predicted. A procedure nobody executed is a
draft.

## Shipping mechanics

- **Discovery is by directory, not by registry.** Adding the file is the whole
  change — which removes the "forgot to register it" bug, and also removes the
  place where a broken document could be hidden. Every file in the directory is
  loadable, so every file must be finished.
- **The body must be non-empty, and so must the description**, after parsing.
  Both are silently skipped when empty; the failure is a skill that does not
  appear, with no error.
- **File names must be unique** and stable, because the id derives from the name.
- **Ids derive from the file, so a rename removes the old id.** Anything that
  stored the old id — a transcript, a saved shortcut, a user's habit — stops
  resolving unless an alias is kept.
- **Do not hand-maintain a parallel list.** A catalogue with its own entries and
  a directory with files are two sources of truth; they disagree the first week.
- **Provenance is part of the format.** Every shipped document states where it
  came from, in a section at the end, and carries no upstream product name
  anywhere in the text — the document's words reach the model and, through it,
  the user.

## Checklist before it ships

1. Read only the description. Would you load it for the three prompts you wrote?
   Would you leave it alone for the three you should not?
2. Is the description one line, free of marketing adjectives, and does it name
   the moment and the failure?
3. Does the body open with the constraint rather than a preamble?
4. Does every step have an output or a decision, and every rule a reason?
5. Are all commands runnable as written, with placeholders marked?
6. Has every check in the document been seen to fail at least once?
7. Are the measured numbers reproducible, and is the tool that produced them
   named?
8. Does the last section before the provenance note describe real mistakes rather
   than generic warnings?
9. Is the name free of product names, and does the id stay stable?
10. Does the document contain anything that would be wrong for a reader outside
    the team that wrote it? If so, it is not a general practice yet.

## Where this goes wrong

- Writing the description as a table of contents, so nobody ever loads the
  document and its cost is paid in every session for nothing.
- Wrapping the description across lines with a YAML folded block, and shipping a
  trigger that is literally `>`.
- Telling the reader to "verify the version" without saying which command prints
  it, so the step is performed by assumption.
- A body that explains why the topic matters for the first fifteen lines, in a
  document that is only read by someone already in the situation.
- Rules with no reasons, applied by the model to contexts where they are wrong,
  with great confidence.
- Instructions that were never executed: a command with the wrong flag, a path
  that does not exist, a threshold from memory.
- A check added to the document in the same change as the thing it checks, never
  seen red, quietly passing because it matches nothing.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
