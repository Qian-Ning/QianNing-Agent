---
name: caching-correctness
description: adding a cache, or a cached value is serving the wrong answer
---

# Caching is a correctness problem

Every cache is a bet that a value will not change, or that nobody will notice if
it did. Most cache bugs are not performance bugs; they are wrong answers served
confidently, which is worse than a slow system because it is invisible.

## The key must contain everything that changes the answer

This is the first bug and the most common one.

- **Every input that affects the result belongs in the key**, including the ones
  that feel like context rather than input: the user, the locale, the tenant, the
  feature flags in force, the version of the logic, the permissions of the caller.
- **A key missing one of those is a wrong-answer generator.** It looks fine in
  testing because the tests all run as one user with one set of flags.
- Where a value must never be shared across a boundary, put the boundary in the
  key — and prefer a structure where the boundary is part of the storage namespace
  rather than a field somebody can forget to add.

## Serving one user's data to another is a security bug, not a cache bug

- **Never key a cache by something that is not unique per permission domain**, and
  never share a namespace between accounts.
- Invalidation on logout, on permission change, and on tenant change is part of
  the authorization model. If a revocation does not clear the cache, the
  revocation did not happen.
- A cache with a long expiry amplifies every authorization mistake by the length
  of that expiry. Assume the mistake will be made and make the window small.

## Invalidation, and why a TTL is a guess

- **A time-based expiry does not make a cache correct; it bounds how long it is
  wrong.** "Up to five minutes stale" is a product decision, and it should be
  written down as one.
- Explicit invalidation on write is the only mechanism that keeps correctness, and
  it is the hard part: every write path has to know every key that the write
  affects. Miss one and you have a permanently stale entry that expires only by
  time, if at all.
- **Versioned or content-addressed keys** avoid most of it: if the answer changes,
  the key changes, and the old entry is simply unreachable. This is the option to
  prefer when the stored value is derived rather than mutable.
- Write-through, write-behind, and read-through differ in when the cache is
  authoritative. Name which one you have, because they fail differently: a
  write-behind cache can lose data, and a read-through cache can serve stale data
  after a write it never heard about.

## What is safe to cache

- **The immutable is safe.** A value that cannot change is a value that cannot go
  stale. Derived values where the derivation includes every input are close.
- **Errors are not.** A transient failure cached for an hour turns a blip into an
  outage. If you cache negative results deliberately, keep the window short and
  make it observable.
- **Never cache the value you are about to write.** A read-modify-write path that
  reads from a cache can write a stale value back over a fresh one.
- Across a chain of caches, staleness compounds: the effective expiry of the chain
  is the worst of its links, not the best.

## The mechanics that turn into incidents

- **The thundering herd.** A popular key expiring sends every concurrent request
  to the origin at once. Where that matters, collapse concurrent misses into a
  single computation and let the rest wait for its result.
- **Unbounded growth.** A cache with no cap is a memory leak with extra steps.
  Set a maximum size and an eviction policy, and watch the eviction count — a
  cache that evicts constantly is a cache that is the wrong size.
- **Concurrency**: an entry being written while it is read, an eviction racing a
  lookup, two writers producing different values for the same key. Entry creation
  has to be atomic with respect to readers, or readers get half a value.
- **The stampede after a restart**: every process starts cold at once. Decide
  whether that is acceptable before you find out in production.

## Observability, or you cannot reason about it later

- **Hit rate, size, eviction count, and fill latency.** Without these, a cache
  incident is indistinguishable from an origin incident.
- **The age of what was served** is the metric that matters for staleness, and it
  is the one that is usually missing. Track it per namespace, not per cache.
- **A kill switch.** A cache that cannot be turned off is a bug you cannot
  diagnose, and the moment you need the switch is the moment you cannot ship one.

## Testing

- **The test is the invalidation test.** Write the case that changes the
  underlying data and asserts the next read does not return the old answer. If
  that test does not exist, the invalidation path is untested, and it is where the
  bugs are.
- Test with two distinct identities, so a key that forgot the identity fails.
- Test the failure path: origin error, origin timeout, partial value written.
- Test the boundary: an entry exactly at its expiry, a size cap reached, an
  eviction during a read.
- **Assert on the answer, not on the hit.** A test that asserts the value came
  from the cache doesn't check that the value is correct.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
