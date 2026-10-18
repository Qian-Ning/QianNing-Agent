---
name: meeting-action-items
description: meeting notes or a transcript has to become decisions, owners, and tickets that can be traced back to what was said
---

# From meeting notes to cited action items

The notes are evidence. The list you produce is a claim about the evidence, and
every item in it that is not a quotation is your inference. The job is to keep
those two things distinguishable, because a list of confident action items is
acted on, and nobody re-reads the notes to check it.

This is the meeting-shaped case of a general rule; `document-to-action-items`
covers contracts and other written obligations, and `grounded-citations` covers
the citation discipline both share.

## Three kinds of sentence, and only three

Everything said in a meeting falls into one of these, and mixing them is the
whole failure mode.

**A decision** is a choice among alternatives, made by someone with the authority
to make it, stated in the past or present perfect: "we're going with the split
pool", "approved", "the answer is no". Note the alternative that lost. A decision
recorded without its rejected option gets re-litigated in six weeks, because
nobody can remember why.

**A commitment** is a person saying they will do a specific thing by a time: "I'll
have the pool split behind a flag by Friday", "Dana is taking the migration note".
The marks are a first person future, or a named person plus a verb.

**A discussion** is everything else: opinions, context, complaints, questions,
and proposals. Proposals are the dangerous member of this group, because they sound
like decisions and are not:

- "I think we should split the pool" — a proposal, from anyone, at any rank;
- "let's leave that open" — a proposal to defer, which is at best a soft decision
  and needs the chair to confirm it;
- "if we had another week we'd redo the retry logic" — a hypothetical with no
  commitment in it at all, and the classic thing an extractor promotes into a
  task nobody agreed to;
- "someone from platform will pick it up" — a wish with no person attached.

The grammar is the test. Conditional mood, "should", "could", "might", and
unnamed actors mean the sentence is not an action yet, however strongly it reads
in a summary.

## The decision test

Three conditions, all required:

1. **A choice** between at least two options, named or implied.
2. **An owner** — the person accountable for the outcome, not the person who
   argued for it.
3. **Authority** — the decider can actually decide this. "The team agreed to
   change the launch date" in a meeting where nobody owns the launch date is a
   recommendation, whatever the notes call it.

Failing any one of the three, it is an open question, and it belongs in the open
questions section with the name of whoever can decide it. That is a useful output.
Calling it a decision is not.

Also record what was decided *not* to happen, when the meeting said so
explicitly. "We are not doing the retry logic this quarter" is a decision, and it
is the one that stops the same discussion next month.

## Every item carries a quote

For written notes, cite the line; for a transcript, cite the speaker and the
timestamp. The source field holds a **verbatim** quotation, not a summary of the
sentence.

> "I'll have the pool split behind a flag by Friday" — Rahul, 00:14:20

Rules that keep this honest:

- **Quote, don't paraphrase, in the source field.** Paraphrase is exactly where
  "might" turns into "will", and the drift is invisible once the list is separated
  from the notes.
- **One item, one quote.** If two sentences are needed to justify an item, either
  it is two items or it is an inference — put it in the inferred section with both
  citations.
- **If the notes are already a summary** written by someone else, say so, and cite
  the note line rather than inventing a timestamp. A summary of a summary is not
  evidence, and the reader needs to know which layer they are looking at.
- **Timestamps beat names alone.** Names disambiguate who; time locates where in
  the recording. Both, when you have both.
- **Quote accurately, including the hesitation.** "I can probably get it done by
  Friday" is a different commitment from "I'll get it done by Friday", and the
  hedge is the part that matters when it slips.

When the sentence you need is not in the notes, the item goes in the inferred
list with the sentence that led you there, marked as yours. The count of inferred
items is a quality signal about the meeting, not about you: a meeting that
produces many of them did not decide much.

## The item with no owner

This is the most common real case and the one people resolve by guessing. Do not.

- Owner is `unassigned`. That is a value, not a gap.
- Add a **triage owner**: the person who will name the real owner, with a date.
  Usually the chair, or whoever raised the item.
- Keep the item in the list. Deleting it loses the only record that the topic was
  discussed, and it will come back as a surprise.
- Escalate on a rule: unassigned items older than one meeting get raised at the
  start of the next one, by name. A rule that fires automatically is the only kind
  that survives a busy week.

"Someone from platform" is not an owner. Neither is a team name when the work needs
a person, and neither is the person who happened to be talking about it.

## From item to ticket

The ticket is not the notes. It is the smallest thing that can be finished, with
enough context to start.

- **Title**: imperative, under about 60 characters, one deliverable. "Split the
  connection pool behind a flag", not "connection pool".
- **Body**: two sentences of context, the quoted source with its citation, the
  acceptance condition ("done when the load test holds 4,000 connections"), the
  due date with a timezone, and a link back to the notes.
- **One ticket per commitment.** "Review and approve" is two, if two people do
  them.
- **Deduplicate before filing.** The same commitment usually appears twice — once
  in the meeting and once in the follow-up message. One ticket, two citations.
  Search the existing tracker for the distinctive noun phrase before creating a
  second one; duplicate tickets are worse than missing ones because they split the
  history.

## The verification pass

Re-read the notes with the finished list beside you, then run the mechanical
checks. This script enforces the traceable part: a kind from the fixed set, an
owner, and a quotation that actually appears in the notes. It cannot tell whether
an item is a good idea — only whether it is sourced.

```python
#!/usr/bin/env python3
"""check-items.py NOTES.md ITEMS.md"""
import re
import sys
import unicodedata

KINDS = {"decision", "commitment", "question"}
COLUMNS = ["#", "item", "kind", "owner", "due", "source"]
HEDGES = re.compile(r"\b(if|would|could|might|maybe|perhaps|probably)\b", re.I)


def norm(text):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip().lower()


def main(notes_path, items_path):
    notes = norm(open(notes_path, encoding="utf-8").read())
    lines = [l.rstrip("\n") for l in open(items_path, encoding="utf-8")
             if l.lstrip().startswith("|")]
    problems, warnings, seen, checked = [], [], {}, 0

    for number, line in enumerate(lines, 1):
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < len(COLUMNS):
            problems.append(f"line {number}: {len(cells)} cells, expected {len(COLUMNS)} "
                            "(a pipe inside a quote will do this)")
            continue
        if cells[1].lower() == "item" or set(cells[0]) <= set("-: "):
            continue
        checked += 1
        item, kind, owner, due, source = cells[1], cells[2].lower(), cells[3], cells[4], cells[5]

        if kind not in KINDS:
            problems.append(f"line {number}: kind {kind!r} is not one of {sorted(KINDS)}")
        if not owner:
            problems.append(f"line {number}: no owner (write 'unassigned' if nobody was named)")
        elif owner.lower() != "unassigned" and norm(owner) not in notes:
            warnings.append(f"line {number}: owner {owner!r} is never named in the notes")

        quote = source.strip().strip('"“”' + "'")
        if len(quote) < 8:
            problems.append(f"line {number}: source is not a quoted sentence")
        elif norm(quote) not in notes:
            problems.append(f"line {number}: quote not found in the notes: {quote[:60]!r}")
        elif kind in ("decision", "commitment") and HEDGES.search(quote):
            problems.append(f"line {number}: a {kind} quoted from a conditional sentence "
                            "- that is a proposal, retype it as a question")

        key = norm(item)
        if key in seen:
            problems.append(f"line {number}: duplicate of line {seen[key]} - keep one row, cite both")
        else:
            seen[key] = number

    for warning in warnings:
        print(f"warn: {warning}")
    for problem in problems:
        print(f"error: {problem}")
    print(f"{checked} item(s) checked, {len(problems)} problem(s), {len(warnings)} warning(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: check-items.py NOTES.md ITEMS.md")
    sys.exit(main(sys.argv[1], sys.argv[2]))
```

The item file is a markdown table, so the notes and the list are readable
side by side:

```markdown
| # | Item | Kind | Owner | Due | Source |
|---|---|---|---|---|---|
| 1 | Split the connection pool behind a flag | commitment | Rahul | 2026-10-16 | "I'll have the pool split behind a flag by Friday" |
| 2 | Keep the old endpoint until Q1 | decision | Rahul | 2027-01-31 | "We decided last month to keep the old endpoint until Q1" |
| 3 | Publish the migration note | commitment | Dana | 2026-10-21 | "I'll get the migration note out by Wednesday" |
| 4 | Update the runbook | question | unassigned | next sync | "Who is updating the runbook?" |
```

Run against those notes it reports `4 item(s) checked, 0 problem(s), 0 warning(s)`.
Run against a version with a conditional quoted as a commitment and the same
commitment filed twice, it reports two errors and exits 1 — the exact pair of
mistakes that a careful human also makes when the meeting was long.

The warning is worth its own line: an owner who never appears in the notes is an
owner you invented, and it is the single easiest way to make a list look complete
while being wrong.

## What the finished list contains

- **Decisions**, each with the alternative that lost and the decider.
- **Commitments**, each with an owner, a date, and a quote.
- **Open questions**, each with the name of whoever can answer it.
- **Inferred items**, separated from the three above and marked as yours.
- **What was not discussed**, when the agenda said it would be. Silence is not
  agreement, and the gap is often the most useful thing in the report.
- Counts at the top: N decisions, M commitments, K open questions. A meeting with
  zero decisions is a status meeting, and saying so is more useful than inflating
  the list.

## Where this goes wrong

- Promoting every "we should" into a task, so the list is longer than the meeting
  and half of it was never agreed.
- Paraphrasing the source, then citing the paraphrase. The citation looks
  checkable and is not.
- Assigning an unnamed owner by inference because the item looks incomplete.
  `unassigned` is the honest value and the triage owner is the way to close it.
- Filing one ticket per mention of the same commitment, splitting its history
  across three trackers.
- Dropping the discussion entirely. The reasoning is usually what the next person
  needs, even though it is not an action.
- Producing a list with no counts and no inferred section, so the reader cannot
  tell what is quoted and what is guessed.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
