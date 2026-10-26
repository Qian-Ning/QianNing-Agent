---
name: codebase-inspection
description: an unfamiliar repository has to be sized up before a change — its parts, where the weight sits, what is generated
---

# Measuring a repository before you change it

A change is judged against the size and shape of the tree it lands in. Ten
minutes of counting gives you the three facts that decide how careful to be: how
much is here, where the risk is concentrated, and which files you must not touch
because a machine wrote them.

Count from the tracked tree, not the working directory.

```bash
git ls-files | wc -l
```

`git ls-files` is the honest denominator: it excludes ignored build output and
vendored installs. A `find . -type f | wc -l` on a repository with a populated
dependency directory is off by two orders of magnitude, and every ratio built on
it afterwards is wrong.

## The language mix, by file

```bash
git ls-files | sed -n 's/.*\.\([A-Za-z0-9]*\)$/\1/p' | sort | uniq -c | sort -rn | head -20
```

Read this as *where the work is*, not as a claim about importance. A repository
that is 900 TypeScript files and 170 Rust files is a TypeScript product with a
native component; the reverse is a native product with a UI. The second and
third entries in that list are usually the interesting ones — configuration
formats and shell scripts reveal how the thing is operated.

Extensionless files (`Makefile`, `Dockerfile`, `LICENSE`) drop out of that
pipeline silently. Check the gap between `git ls-files | wc -l` and the sum of
the extension counts before you trust the percentages.

## Lines, per language and per file

```bash
git ls-files '*.ts' '*.tsx' | xargs wc -l | tail -1
git ls-files '*.ts' '*.tsx' | xargs wc -l | sort -n | tail -20
```

- Quote the globs, or the shell expands them against the working directory and
  silently counts the wrong set.
- `xargs` splits long argument lists, which is what you want here; if paths
  contain spaces, use `git ls-files -z '*.ts' | xargs -0 wc -l`.
- Raw line counts include blanks and comments, and they include long string
  literals and embedded fixtures. If a physical-line counter is installed, say
  which one produced the number (`tokei`, `cloc`, or `scc`) so the next person
  can reproduce it. A number with no tool named is a rumour.

The per-file list matters more than the total. A single 10,000-line file is a
different repository from one with the same total spread over 200 files, and it
is a different problem to change.

## Where the weight actually moves

Size is static; churn is where the bugs are.

```bash
git log --since='12 months ago' --name-only --pretty=format: | grep -v '^$' | sort | uniq -c | sort -rn | head -20
```

Sorted by commit count, this is the list of files the team keeps having to
touch. Cross it with the largest-file list: **large and frequently changed** is
the intersection where a change is most likely to break something, and where you
should read before you edit. A file that is large but untouched for two years is
usually stable, generated, or abandoned — find out which before assuming.

## The test-to-source ratio

```bash
git ls-files | grep -Ei '(^|/)(test|tests|spec|__tests__)/|\.(test|spec)\.' | wc -l
git ls-files | grep -Ei '(^|/)(test|tests|spec|__tests__)/|\.(test|spec)\.' | xargs wc -l | tail -1
```

Two numbers are worth having: test files against source files, and test lines
against source lines. Beyond about 1:1 in lines, look closer — the total is
usually inflated by fixtures, snapshots, and generated cases, and the genuinely
tested modules may still be a small fraction. A 9,000-line test file is usually
data.

The ratio is a smell, not a verdict. The useful question is narrower: **do the
files that appear in the churn list have tests next to them?** That is the
question the ratio is a proxy for, and you can answer it directly by looking.

## Generated versus hand-written

Hand-editing a generated file is a change that disappears at the next build, so
find these before you plan any work.

```bash
git grep -lE '@generated|DO NOT EDIT|automatically generated|This file is generated' | head -20
git ls-files | grep -E '\.(gen|generated|g)\.(ts|js|dart|py)$|_pb2\.py$|\.min\.(js|css)$'
git check-attr linguist-generated -- $(git ls-files '*.ts' | head -200)
```

Also count as generated: lockfiles, compiled bundles checked in under `dist/` or
`out/`, protocol definitions, and vendored third-party source. Exclude them from
your line totals before quoting a size, and name the generator when you report
one — "12k lines, of which 4k are generated client bindings" is a different
statement from "12k lines".

## Where the boundaries really are

Top-level directories are a first approximation and often a lie; the package
manifests and the import graph are the truth.

```bash
ls
git ls-files | cut -d/ -f1-2 | sort | uniq -c | sort -rn | head -20
git grep -n "from ['\"]\.\./\.\./\.\." -- '*.ts' | wc -l
git grep -ln '"workspaces"' -- 'package.json'
```

- A workspace root with `packages/*` and `apps/*` means several independently
  built units; a change that crosses two of them is a release-coordination
  problem, not just a code change.
- Count the deep relative imports. A high number is a boundary that is not being
  enforced, and it tells you which layer is being reached around.
- Find the entry points before the modules: the `main`/`exports`/`bin` fields,
  the process start scripts, the route table. Everything else is reachable from
  one of those.

## Write the shape down

The deliverable is five numbers and three sentences, in the task description or
the pull request:

- tracked files, total source lines excluding generated code;
- the dominant language and the second one;
- the top three files by churn, and whether each has a test;
- the package/workspace boundary a change would cross;
- what is generated and must not be edited.

Then say where you expect your change to land, and check that expectation against
the churn list. If your plan touches a file that nobody has touched in a year,
that is either the safest place in the tree or a trap — read it before deciding
which.

## Where this goes wrong

- Counting the working directory instead of the tracked tree, then quoting
  ratios derived from it.
- Reporting a total that includes generated bundles, protocol stubs, and
  lockfiles as "our code".
- Treating the test-to-source ratio as a quality score. It measures text, not
  coverage.
- Skipping the churn list, then "discovering" in review that the file you changed
  is the one every recent bug touched.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
