---
name: performance-investigation
description: something is slow and the cause is not yet known
---

# Finding out why it is slow

The most expensive thing in performance work is a plausible guess. Change the
code based on a guess and you will not know whether you helped, and you will have
added complexity either way.

## Measure first, and measure the right thing

- **Before the change**, so you have a number to compare against. An improvement
  with no baseline is a claim, not a result.
- **In the environment where it is slow.** A debug build, a dev database, a
  local network, and a quiet machine are all different problems from production.
  Measure where the complaint is.
- **Distributions, not averages.** Report p50 and p99 (or p95). An average hides
  the case that is actually hurting users, and the tail is usually what gets
  reported.
- **Latency and throughput separately.** Cutting per-request latency does not
  raise throughput if the bottleneck is contention, and parallelising a slow
  single request makes tail latency worse.

Name the number before you start: "the first page load is 4.2 s at p95, and the
goal is under 1 s."

## Find the bottleneck before optimising anything

An optimisation is only as good as the share of time it removes. Measure where
the time actually goes first — a profiler, tracing spans, or coarse timers around
the candidate regions.

- Optimising a region that is 5% of the time caps the win at 5%, however elegant
  the rewrite.
- The bottleneck often moves after you fix it. Expect to repeat the cycle, and
  re-measure rather than assuming the next region is now hot.
- If the time is spread evenly with no dominant region, the problem is
  structural — too many round trips, too much work per item — not a hot function.
  Local micro-optimisation will not move it.

## The usual causes, worth checking in this order

1. **Round trips.** One network or database call per item instead of one call for
   all items. The fix is usually batching or a join, not faster calls.
2. **Repeated work in a loop.** Re-deriving a value, re-parsing, re-allocating,
   re-querying something that did not change.
3. **A cache that never hits** — or one that hits and is not invalidated
   correctly, so it is a correctness bug wearing a performance costume.
4. **Blocking on the hot path.** Synchronous I/O, a synchronous lock held across
   an await, a chatty boundary crossed many times in sequence.
5. **Allocation churn.** Enormous object counts, strings concatenated in loops,
   copies of large structures per item. Measure allocation, do not assume it.
6. **Work that should not happen at all.** This is the best category: the
   fastest code is the call you delete.

## Change one thing at a time

- One change, one measurement, same conditions. Two changes at once and you learn
  nothing when the number moves.
- **Make it reproducible**: fixed input size, warm-up or a stated cold start, the
  same machine, the same data. Record the command you ran.
- Compare against the baseline, not against the previous experiment, or error
  accumulates and you end up "faster" than the original while being slower.
- Watch for what else moved: memory, startup time, error rate. A speedup that
  buys latency with memory or reliability is a trade-off to state, not a win to
  claim.

## Keep the win, or keep the code simple

- **Revert what did not help.** A micro-optimisation that measured neutral is now
  complexity you maintain for nothing. Undo it.
- Keep the optimisations that show up in the number, and write down which they
  are, so a later refactor knows what it would be giving up.
- Where a cache or an index is load-bearing, say so next to it, and say what
  invalidates it.

## The cheap wins, in order of cost

1. **Delete the work.** A call that does not need to happen beats every
   optimisation of it.
2. **Do it once.** Hoist, memoise on a stable key, precompute at build time.
3. **Do it less often.** Batch, debounce, cache with a real invalidation story.
4. **Do it somewhere else.** Move it off the hot path, off the request, or into a
   background job.
5. **Only then, make it faster.** A better algorithm or data structure, which is
   where the large asymptotic wins live — and which is also where the bugs live.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
