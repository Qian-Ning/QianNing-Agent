---
name: docs-code-sync
description: code changed and the documentation that describes it has to be checked against the code rather than trusted
---

# Documentation that stays true

Prose does not fail when it stops being correct. A renamed function leaves a
document that still reads perfectly, still has the right tone, and now sends
every reader to a symbol that does not exist. Nothing in a normal test run
touches it, so drift accumulates quietly until someone follows the
documentation and gets an error.

Treat documentation as a second implementation of the same behaviour, with two
differences: it is never executed, and nobody is forced to update it.

## Drift has three shapes, and they need different checks

| shape | example | caught by |
|---|---|---|
| path and name drift | a file moved, a flag renamed, a config key deleted | a script |
| behavioural drift | the sentence describes what the code used to do | a reader |
| structural drift | of two mirrored documents, one gained a section | a script, weakly |

The first and third are mechanical and worth automating because they are cheap
and they never produce false confidence when they pass — a passing path check
means the path exists, nothing more. The second is the one that matters most and
the one no script will catch, because the sentence still parses.

## Extract the claims, then check them

A document makes claims in a small number of checkable forms: a path, a command,
a config key, an option name, a link, a code block. Pull them out and test them
against the tree.

```python
import re, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
bad = []

for doc in sorted((root / "docs").glob("*.md")):
    text = doc.read_text(encoding="utf-8")

    # Every repo-relative path written in backticks must exist.
    for ref in re.findall(r"`((?:src|docs|scripts)/[^`\s]+)`", text):
        if not (root / ref).exists():
            bad.append(f"{doc.relative_to(root)}: missing path {ref}")

    # A mirrored translation must have the same section count.
    heads = re.findall(r"^## (.+)$", text, re.M)
    if doc.stem.endswith(".zh"):
        base = doc.with_name(doc.stem[:-3] + ".md")
        if base.exists():
            n = len(re.findall(r"^## (.+)$", base.read_text(encoding="utf-8"), re.M))
            if n != len(heads):
                bad.append(f"{doc.relative_to(root)}: {len(heads)} sections vs {n} in {base.name}")

print("\n".join(bad) if bad else "clean")
raise SystemExit(1 if bad else 0)
```

Verified on a small fixture with one stale reference and one extra section
(paths below are printed as the script's relative form; on Windows that comes out
with backslashes):

```
docs\guide.md: missing path src/old-loader.ts
docs\guide.zh.md: 2 sections vs 1 in guide.md
```

The script exits 1 on that, 0 on a clean tree. Forty lines, no dependencies, and
it runs in a pre-commit hook or a CI job in under a second.

Two things to get right when you copy this shape:

- **Anchor the regex to real top-level directories.** A generic
  `` `([a-z]+/[^`]+)` `` pattern matches shell paths, URLs, and prose fragments,
  and every false positive teaches the team to ignore the check. Start narrow
  and widen when a class of drift is actually missed.
- **Do not try to verify prose.** If a check needs a heuristic to decide whether
  a sentence is a claim, it will fail on a rewrite and pass on a lie. Check the
  things that are exactly checkable, and leave the rest to review with a named
  owner.

### The checks that repay their cost

- **Referenced paths and symbols exist.** Paths are trivial. Symbols need more:
  grep for `function name(`, `class Name`, `export const name`, or ask the
  language server. A doc that names a function should name one that is still
  there.
- **Documented commands run.** Run each command block against a scratch checkout
  with a timeout. This catches the commonest rot of all — a setup step that
  needs a flag or an environment variable added two releases ago.
- **Documented flags exist.** Compare `--help` output against the flags the
  document mentions, in both directions: a flag documented and absent is drift;
  a flag present and undocumented is a gap.
- **Config keys are a set, not prose.** Generate the set of keys from the schema
  and the set from the docs, then diff. This is the one check where generating
  the docs section from the schema is genuinely better than checking it.
- **Internal links and anchors resolve.** Anchor drift is invisible in a rendered
  page that only shows a broken jump; it is the commonest defect in a docs tree
  after a heading rewrite.
- **Mirrored pairs keep the same section ids.** Section count is a weak proxy; if
  headings carry explicit ids, compare ids, not titles — titles are translated
  and will never match.

### The checks that only a reader catches

Whether the example is still the recommended path. Whether a limit stated as
"currently 100" is still 100. Whether the paragraph above the changed one now
contradicts it. Whether the doc teaches an approach the team abandoned while all
its paths still resolve. A green drift check plus a document that recommends the
deprecated client is the normal state of a docs tree that is "passing".

So the mechanical check is a floor, not a substitute. Pair it with a question in
review: *which paragraph in the docs does this change make false?* If the answer
is "none", say so in the change description.

## Paired and mirrored documents

A document that exists twice — two languages, a guide and a reference, a public
page and an internal one — has a canonical side and a derived side. Decide which
is which, in writing:

- **Generated from code**: the derived side is regenerated in CI and diffed. A
  hand edit to a generated page is lost at the next build, so the check is "the
  working tree is clean after regeneration".
- **Translated by hand**: both sides drift independently, and the only honest
  check is structural (same sections, same code blocks, same claims) plus a
  date on each side. Do not pretend a section count proves the translation is
  current; it proves the shape survived.
- **Duplicated for a different audience**: the duplication is the bug. Two copies
  of the same instructions will disagree within two releases. Link one to the
  other, or generate both from one source.

Whichever it is, put a line at the top of the derived side saying where it comes
from and whether editing it is allowed. A reader who does not know it is
generated will fix it by hand, and their fix will vanish.

## Retiring a statement instead of deprecating it

The instinct is to leave the old sentence and add "**Deprecated**" or "*(no
longer applies)*". Do not. A document with a deprecated paragraph and a current
one, three sections apart, is read by skimming: the reader finds whichever came
first, and so does a model summarising the page. The marker does not encode which
one is true now.

Replace, do not annotate:

1. Delete the sentence. Put the current rule where the old one lived, so the
   reader who arrives at that heading gets the truth.
2. If the history is load-bearing — a migration note, a behaviour change users
   will notice — state it once, in the present tense with the version it changed
   in: "Since 2.4, `--strict` is the default; passing `--no-strict` restores the
   old behaviour." That is a fact about today, not an archaeological layer.
3. If a section has no replacement at all, delete the section and its links.
   A dangling heading that says "removed" costs a reader a click and teaches
   nothing.
4. If the old behaviour is still supported and still worth documenting, it is not
   deprecated — it is a variant, and both variants belong side by side with the
   difference stated plainly.

The same applies to version-qualified prose. A page that accumulates "in 1.x you
did X, in 2.x you do Y" becomes a history book that nobody reads to the end.
Keep the current instruction, plus one migration line if it is needed.

## Give each load-bearing page an owner

Drift concentrates where nobody is responsible. The pages whose accuracy actually
costs something — setup and install, security and permissions, the API contract,
data migration — should have a named owner and a review trigger. The ones that
can lag (design notes, historical rationale) should be marked as such so a reader
knows how much to trust them.

A useful split to write down once:

- **Contract pages**: wrong here breaks a user. Checked mechanically where
  possible, reviewed by the owner on every change to the relevant code.
- **Task pages**: wrong here wastes an hour. Checked by running the commands.
- **Background pages**: wrong here misleads gently. No check; date-stamped.

Without the split, everything gets the same treatment, which in practice means
the important pages get none.

## The change that invalidates a doc belongs with the doc

The person changing the behaviour is the only one who knows what became false.
So the rule is: the code change and the doc change land together, in the same
change, or the code change carries a named task with an owner and a date. A
"docs to follow" note with no owner is a deletion with extra steps.

Reviewers are the enforcement point, and the question is cheap to ask: *what did
this change make untrue?* It catches more drift than any script, because it
happens before the false statement is written rather than a year after.

## Where this goes wrong

- Trusting a docs tree because the build is green. The docs build proves the
  markdown parses.
- A drift check whose regex matches prose, so it reports thirty findings, the
  team mutes it, and real drift is now invisible.
- Checking paths but not commands, so every setup guide references files that
  exist and steps that fail.
- Leaving the old paragraph with a "deprecated" marker and the new one three
  sections below it, then wondering why people follow the old one.
- Mirroring a document by hand and calling the section counts equal "in sync"
  when one side is two releases behind in content.
- Writing "documentation update" as a follow-up task with no owner, which is the
  same as deciding not to do it.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
