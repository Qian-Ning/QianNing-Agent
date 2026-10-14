---
name: doc-comments-and-api-docs
description: writing code comments, docstrings, or API documentation
---

# Comments and API documentation

Two audiences, two rules. A comment is for the next person reading this line; API
documentation is a contract with everyone who calls from elsewhere. Both fail the
same way: by being wrong with authority.

## A comment that restates the code is noise

- `// increment the counter` above `counter++` adds nothing and creates something
  to maintain. It will be the thing that is wrong after the refactor.
- **The best comment is often a rename.** If the line needs an explanation of what
  it does, the clearer fix is a name or an extracted function that says it. Then
  the comment is unnecessary and the code is better.
- Comment **why**, not what. Why this order, why this constant, why not the
  obvious approach.

## Comment the surprising things

- **A magic number**: where it comes from, and what breaks if it changes.
- **A workaround**: what it works around, and the condition under which it can be
  removed. A workaround with no condition is permanent.
- **A non-obvious ordering** that is load-bearing — anything where moving two lines
  changes behaviour.
- **A boundary condition** that looks like an off-by-one and is not.
- **A deliberate omission** — why there is no validation here, why this case is not
  handled. Otherwise the next reader adds it.

## Never leave commented-out code

- It rots: it stops compiling, it stops matching the types around it, and nobody
  knows whether it was left as a note or abandoned mid-thought.
- The version control system remembers it. **Delete it.** If it is needed, it is in
  the history.
- The same applies to a flag that disables a path nobody uses, and to a function
  kept "in case". Dead code with a comment claiming it is needed is still dead
  code.

## TODOs need a condition, not just a promise

- **An unowned TODO is a wish.** Worse, it looks like a plan, so it prevents the
  work from being scheduled.
- A useful form states **what must be true for it to be done** — a version, a
  dependency, a prerequisite — or carries a reference to where it is tracked.
- Where a TODO has been there for years, it is either never happening or it is
  needed. Both are worth resolving.

## A stale comment is worse than no comment

- Code with no comment invites the reader to read the code. Code with a wrong
  comment invites them to believe something false, and they will.
- When behaviour changes, **the comment changes in the same commit** — that is part
  of the change, not a follow-up.
- Where a comment describes intent and the code no longer matches it, the reader
  cannot tell which is the mistake. That ambiguity is the cost, and it is paid
  every time.

## API documentation is a contract

Document the things a caller cannot learn from the signature:

- **What it guarantees** — the postconditions, the invariants it maintains.
- **What it requires** — preconditions, valid ranges, what must not be null.
- **What it throws, errors, or returns on failure.** The error contract is the part
  callers most need and documentation most often omits.
- **Ownership and lifetime**: who frees it, whether the returned value is borrowed,
  how long a handle stays valid.
- **Concurrency**: whether it may be called from several threads, and what the
  guarantee is if so. Silence here is read as "safe", so where it is not safe, say
  so plainly.
- **Side effects**: what it touches outside itself — files, network, global state.

Do **not** write `@param x the x` for every parameter. Restating the signature
adds nothing; documenting the units, the valid range, and the meaning does.

## Public documentation is part of the public interface

- It changes **with** the behaviour, in the same commit. A documented behaviour and
  an implemented one that disagree is a bug in one of them, and the reader cannot
  tell which.
- A **deprecation** needs three things: that it is deprecated, what to use instead,
  and when it goes. Without all three it is a warning nobody can act on.
- **Examples must be real.** An example that does not compile, or that uses an API
  from two versions ago, is a defect, and it is the defect readers copy first.
- Where examples are not tested, assume they are wrong. The ones that are run are
  the only ones that stay true.

## The shape of a README

Order it by what a reader needs first, which is rarely what the author finds
interesting:

1. **What this is**, in one or two sentences.
2. **How to run it**, in the fewest steps that work, including the prerequisites
   that actually bite.
3. **What will go wrong first** — the common failure and its fix.
4. Then the details: configuration, architecture, contributing.

A README that opens with philosophy and buries the install command has the order
backwards. The reader arrives with a problem, not with curiosity.

## Put documentation where the confusion happens

- The explanation belongs where the reader will be when they need it: next to the
  configuration option, in the error message, at the function. A perfect document
  in a folder nobody opens is a document nobody reads.
- Where a thing is genuinely hard, say so and say why. "This is subtle because…"
  saves the next reader an hour of assuming they are missing something simple.
- The test for any document: **could someone complete this task using only
  this?** If not, the missing step is the document.

## A short review pass

- Does every comment say something the code does not?
- Is anything commented out that should be deleted?
- Does every TODO say when it will be resolved?
- Does the API documentation say what it throws and who owns the result?
- Do the examples run?
- Does the comment still match the code it sits above?

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
