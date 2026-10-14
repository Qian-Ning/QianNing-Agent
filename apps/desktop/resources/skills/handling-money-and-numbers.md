---
name: handling-money-and-numbers
description: storing, computing, or displaying money, percentages, or measured quantities
---

# Money and numbers

These are the two domains where a small arithmetic decision becomes an
accountant's problem six months later, and where the bug is invisible in testing
because it is off by a hundredth.

## Money is never a floating point number

`0.1 + 0.2` is not `0.3` in binary floating point, and the difference compounds
across every addition, every percentage, and every row.

- **Store the amount as an integer in the smallest unit** — cents, or the
  currency's own minor unit — or use a decimal type designed for exact decimal
  arithmetic. Never a float, in code or in the schema.
- **Store the currency alongside the amount**, always. An amount without a
  currency is not money; it is a number, and it will be compared against the
  wrong one eventually.
- Never pass money through a format that turns it back into a float: JSON numbers
  are floats in most parsers, so a money field in JSON travels as a string, or as
  the integer in the minor unit, decided deliberately.

## Decide the rounding once, and at the boundary

- **Round when you display or when the business says so, not at every step.**
  Rounding twice produces a different number than rounding once, and neither error
  is visible until someone reconciles.
- Pick a rounding mode and write it down: half-up, half-even (banker's), floor,
  ceiling. They differ exactly on the cases that go to arbitration.
- **When a total must split, decide who absorbs the remainder.** Three people
  splitting a cent, a discount across line items, an allocation over shares: the
  parts must still add up to the whole, and the code has to say where the extra
  cent goes.
- **Never round for storage, then round again for display.** Store the exact
  value; format at presentation.

## Percentages are computed on unrounded values

- Compute on the exact value and round the **result**, once.
- **Never sum rounded percentages** and expect the total to match. The sum of the
  roundings is not the rounding of the sum, and the discrepancy is what an
  auditor finds.
- Where a rate must be stored, keep it in a form that does not lose precision —
  basis points as integers, or a ratio with a documented scale — rather than a
  formatted percentage string.
- **Order of operations is a business decision**, not an implementation detail.
  Tax before discount or after changes the answer; interest compounding monthly
  or daily changes the answer. Name the order in the code, not only in a comment
  on the ticket.

## Division, remainders, and comparison

- Integer division **truncates silently**. Decide what happens to the remainder
  and make it explicit — carry it, accumulate it, or assign it by a stated rule.
- Comparing floats for equality is always wrong. If a float is unavoidable
  anywhere, compare with an epsilon and state what the epsilon means.
- Accounting for the sum of parts: after any split or allocation, **assert that
  the parts equal the whole**. A test that only checks one part will not catch it.

## Parsing and displaying are separate concerns

- **Do not parse user-entered numbers with a locale-blind function.** `1,234.56`
  and `1.234,56` are the same number in different conventions and different
  numbers in the same one.
- Keep the exact value internally; format for display with the locale's separators
  and symbol, and never read the formatted form back into arithmetic.
- Negative amounts, and how they are displayed, are a convention that differs by
  domain — parentheses in some accounting contexts, a leading minus in others.
  Follow the domain's convention, and be consistent across the product.

## Quantities that are not money

- **Units belong in the name and in the type.** `timeoutMs`, `sizeBytes`,
  `distanceMetres`. A bare number in a shared structure will be read as the wrong
  unit by someone.
- Unit conversions multiply error, so convert once, at a named boundary.
- Significant digits: a percentage of a very large number stays precise; a
  percentage of a small one can vanish. Watch for the case where a legitimate
  calculation rounds to zero and then divides.
- Integers have limits: cents overflow sooner than you think, and a 32-bit
  accumulation over a large data set is a real risk. Choose the width
  deliberately and say so near the type.

## What this has to satisfy

- **Someone has to be able to explain the arithmetic line by line later** —
  a reconciliation, an audit, a dispute. Keep the intermediate values that the
  explanation needs, rather than recomputing from a total.
- **Every money-handling change needs a test with numbers that do not come out
  evenly**, or the rounding path is untested. Round numbers are the case that
  hides the bug.
- Where a total is derived, store or compute both sides and assert equality in a
  test: the sum of the line items against the header total is the single most
  useful assertion in this domain.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
